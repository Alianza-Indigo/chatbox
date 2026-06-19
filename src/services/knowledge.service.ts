import OpenAI from 'openai';
import { Prisma } from '@prisma/client';
import type { BotKnowledge } from '@prisma/client';
import { db } from '../db';
import { logger } from '../logger';

const SIMILARITY_THRESHOLD = 0.35;
const TOP_N = 3;
// Above this threshold the in-process O(N) cosine scan becomes a latency concern
const INPROCESS_WARN_THRESHOLD = 5_000;

// ─── Embedding codec ──────────────────────────────────────────────────────────

export function encodeEmbedding(vec: number[]): Buffer {
  const f32 = new Float32Array(vec);
  return Buffer.from(f32.buffer);
}

export function decodeEmbedding(data: Buffer | Uint8Array): Float32Array {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  // Float32Array requires 4-byte alignment; copy if the buffer is misaligned
  if (buf.byteOffset % 4 !== 0) {
    const aligned = Buffer.allocUnsafe(buf.byteLength);
    buf.copy(aligned);
    return new Float32Array(aligned.buffer, 0, aligned.byteLength / 4);
  }
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ─── Embedding generation ─────────────────────────────────────────────────────

export async function generateEmbedding(
  text: string,
  apiKey: string,
  model = 'text-embedding-3-small',
): Promise<number[]> {
  const client = new OpenAI({ apiKey });
  const response = await client.embeddings.create({ model, input: text });
  return response.data[0].embedding;
}

/**
 * Persist the embedding vector to both the legacy BYTEA column (for in-process
 * fallback) and the pgvector column (for DB-side ANN search).
 * The pgvector write is best-effort — it fails gracefully if the extension is
 * not installed, leaving the BYTEA column as the only storage.
 */
export async function saveEmbeddingVector(knowledgeId: string, vec: number[]): Promise<void> {
  const vecStr = `[${vec.join(',')}]`;
  await db.$executeRaw(
    Prisma.sql`
      UPDATE "bot_knowledge"
      SET "embedding_vec" = CAST(${vecStr} AS vector)
      WHERE "id" = ${knowledgeId}
    `,
  );
}

export async function clearEmbeddingVector(knowledgeId: string): Promise<void> {
  await db.$executeRaw(
    Prisma.sql`
      UPDATE "bot_knowledge"
      SET "embedding_vec" = NULL
      WHERE "id" = ${knowledgeId}
    `,
  );
}

// ─── Retrieval ────────────────────────────────────────────────────────────────

export function getByKeyword(knowledge: BotKnowledge[], query: string): BotKnowledge[] {
  const lowerQuery = query.toLowerCase();
  const words = lowerQuery.split(/\s+/).filter(w => w.length > 3);
  if (!words.length) return [];
  return knowledge.filter(k => {
    const haystack = `${k.title} ${k.content} ${k.tags.join(' ')}`.toLowerCase();
    return words.some(w => haystack.includes(w));
  });
}

/**
 * Return the most relevant knowledge snippets for `query`.
 *
 * Priority:
 *   1. pgvector ANN search in DB  — fast, scales to 100 k+ entries, requires
 *      the pgvector extension AND populated embedding_vec column.
 *   2. In-process cosine similarity — correct but O(N) memory & CPU; falls back
 *      to this when pgvector is unavailable or the column is not yet populated.
 *   3. Keyword search — always available, no API call needed.
 */
export async function getRelevantKnowledge(
  botId: string,
  knowledge: BotKnowledge[],
  query: string,
  embedderApiKey?: string,
): Promise<string> {
  if (!knowledge.length) return '';

  if (embedderApiKey) {
    const withEmbeddings = knowledge.filter(k => k.hasEmbedding);
    if (withEmbeddings.length > 0) {
      // Try DB-side vector search first (pgvector path)
      try {
        const result = await vectorSearchDB(botId, query, embedderApiKey);
        if (result !== null) return result;
      } catch {
        // pgvector not installed or embedding_vec column not populated — fall through
      }

      // In-process cosine similarity (legacy / fallback path)
      try {
        return await semanticRetrieval(knowledge, query, embedderApiKey);
      } catch {
        // Embedding generation failed — fall through to keyword
      }
    }
  }

  // Keyword fallback — always available, no API call
  return formatKnowledge(getByKeyword(knowledge, query).slice(0, TOP_N));
}

// ─── Internals ────────────────────────────────────────────────────────────────

/** DB-side ANN search using pgvector. Returns null if no results above threshold. */
async function vectorSearchDB(botId: string, query: string, apiKey: string): Promise<string | null> {
  const vec = await generateEmbedding(query, apiKey);
  const vecStr = `[${vec.join(',')}]`;

  const rows = await db.$queryRaw<Array<{ title: string; content: string; score: number }>>(
    Prisma.sql`
      SELECT title,
             content,
             1 - (embedding_vec <=> CAST(${vecStr} AS vector)) AS score
      FROM   "bot_knowledge"
      WHERE  bot_id = ${botId}
        AND  embedding_vec IS NOT NULL
      ORDER  BY embedding_vec <=> CAST(${vecStr} AS vector)
      LIMIT  ${TOP_N}
    `,
  );

  const relevant = rows.filter(r => Number(r.score) >= SIMILARITY_THRESHOLD);
  if (!relevant.length) return null;
  return relevant.map(r => `[${r.title}]\n${r.content}`).join('\n\n');
}

/** In-process cosine similarity (original implementation kept as fallback). */
async function semanticRetrieval(
  knowledge: BotKnowledge[],
  query: string,
  apiKey: string,
): Promise<string> {
  const queryVec = new Float32Array(await generateEmbedding(query, apiKey));

  const withEmbeddings = knowledge.filter(k => k.embeddingData);
  if (withEmbeddings.length > INPROCESS_WARN_THRESHOLD) {
    logger.warn(
      { count: withEmbeddings.length },
      'knowledge: in-process cosine fallback on large knowledge base — enable pgvector for this bot to avoid latency',
    );
  }
  const scored = withEmbeddings.map(k => ({
    entry: k,
    score: cosineSimilarity(queryVec, decodeEmbedding(k.embeddingData!)),
  }));

  scored.sort((a, b) => b.score - a.score);
  const relevant = scored.slice(0, TOP_N).filter(s => s.score >= SIMILARITY_THRESHOLD);

  if (!relevant.length) {
    return formatKnowledge(getByKeyword(knowledge, query).slice(0, TOP_N));
  }

  return formatKnowledge(relevant.map(r => r.entry));
}

function formatKnowledge(entries: Pick<BotKnowledge, 'title' | 'content'>[]): string {
  if (!entries.length) return '';
  return entries.map(k => `[${k.title}]\n${k.content}`).join('\n\n');
}
