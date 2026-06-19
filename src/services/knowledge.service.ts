import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse';
import XLSX from 'xlsx';
import { GoogleGenAI } from '@google/genai';
import { Prisma } from '@prisma/client';
import type { BotKnowledge } from '@prisma/client';
import { db } from '../db';
import { logger } from '../logger';

const SIMILARITY_THRESHOLD = 0.35;
const TOP_N = 3;
// Above this threshold the in-process O(N) cosine scan becomes a latency concern
const INPROCESS_WARN_THRESHOLD = 5_000;
const DEFAULT_CHUNK_CHARS = 3_000;
const SUPPORTED_DOCUMENT_EXTENSIONS = ['pdf', 'docx', 'txt', 'csv', 'xlsx', 'xls'] as const;
const SUPPORTED_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'] as const;
const OCR_PROMPT = 'Extract all readable text from this image. Return plain text only. Preserve line breaks when helpful. Do not translate, summarize, or add commentary. If there is no readable text, return an empty string.';

export type SupportedDocumentExtension = (typeof SUPPORTED_DOCUMENT_EXTENSIONS)[number];
export type SupportedImageExtension = (typeof SUPPORTED_IMAGE_EXTENSIONS)[number];
export type SupportedKnowledgeUploadExtension = SupportedDocumentExtension | SupportedImageExtension;

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

export async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  const parsed = await pdfParse(buffer);
  return normalizeExtractedText(parsed.text ?? '');
}

export async function extractTextFromDocument(
  buffer: Buffer,
  extension: SupportedDocumentExtension,
): Promise<string> {
  switch (extension) {
    case 'pdf':
      return extractTextFromPdf(buffer);
    case 'docx': {
      const result = await mammoth.extractRawText({ buffer });
      return normalizeExtractedText(result.value ?? '');
    }
    case 'txt':
      return normalizeExtractedText(buffer.toString('utf8'));
    case 'csv':
      return normalizeExtractedText(buffer.toString('utf8'));
    case 'xlsx':
    case 'xls':
      return extractTextFromWorkbook(buffer);
    default:
      return '';
  }
}

export async function extractTextFromImage(
  buffer: Buffer,
  extension: SupportedImageExtension,
  provider: string,
  apiKey: string,
  model: string,
): Promise<string> {
  const mimeType = imageExtensionToMimeType(extension);
  const base64 = buffer.toString('base64');

  switch (provider) {
    case 'openai': {
      const client = new OpenAI({ apiKey });
      const response = await client.chat.completions.create({
        model,
        temperature: 0,
        max_tokens: 4096,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: OCR_PROMPT },
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
            ],
          },
        ],
      });
      return normalizeExtractedText(response.choices[0]?.message?.content ?? '');
    }
    case 'anthropic': {
      const client = new Anthropic({ apiKey });
      const response = await client.messages.create({
        model,
        max_tokens: 4096,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: OCR_PROMPT },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mimeType as 'image/png' | 'image/jpeg' | 'image/webp',
                  data: base64,
                },
              },
            ],
          },
        ],
      });
      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      return normalizeExtractedText(text);
    }
    case 'google': {
      const client = new GoogleGenAI({ apiKey });
      const response = await client.models.generateContent({
        model,
        contents: [
          {
            role: 'user',
            parts: [
              { text: OCR_PROMPT },
              { inlineData: { mimeType, data: base64 } },
            ],
          },
        ],
        config: {
          temperature: 0,
          maxOutputTokens: 4096,
        },
      });
      return normalizeExtractedText(response.text ?? '');
    }
    default:
      throw new Error(`OCR is not supported for provider "${provider}"`);
  }
}

export function getSupportedDocumentExtension(filename?: string, mimetype?: string): SupportedKnowledgeUploadExtension | null {
  const fromName = filename?.split('.').pop()?.trim().toLowerCase();
  if (
    fromName &&
    (SUPPORTED_DOCUMENT_EXTENSIONS.includes(fromName as SupportedDocumentExtension) ||
      SUPPORTED_IMAGE_EXTENSIONS.includes(fromName as SupportedImageExtension))
  ) {
    return fromName as SupportedKnowledgeUploadExtension;
  }

  const mimeMap: Record<string, SupportedKnowledgeUploadExtension> = {
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'text/plain': 'txt',
    'text/csv': 'csv',
    'application/csv': 'csv',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-excel': 'xls',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
  };
  return mimeMap[mimetype ?? ''] ?? null;
}

export function getSupportedDocumentAcceptList(): string {
  return '.pdf,.docx,.txt,.csv,.xlsx,.xls,.png,.jpg,.jpeg,.webp';
}

export function buildKnowledgeChunksFromText(
  title: string,
  text: string,
  maxChars = DEFAULT_CHUNK_CHARS,
  tags: string[] = [],
): Array<{ title: string; content: string; tags: string[] }> {
  const normalized = normalizeExtractedText(text);
  if (!normalized) return [];

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const segments = paragraphs.flatMap((paragraph) => splitLongSegment(paragraph, maxChars));
  const chunks = mergeSegments(segments, maxChars);
  const total = chunks.length;

  return chunks.map((content, index) => ({
    title: total === 1 ? title : `${title} (${index + 1}/${total})`,
    content,
    tags,
  }));
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

function normalizeExtractedText(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function splitLongSegment(segment: string, maxChars: number): string[] {
  if (segment.length <= maxChars) return [segment];

  const pieces: string[] = [];
  const sentences = segment.split(/(?<=[.!?])\s+/).filter(Boolean);
  let current = '';

  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      if (current) {
        pieces.push(current.trim());
        current = '';
      }
      pieces.push(...splitByWords(sentence, maxChars));
      continue;
    }

    const next = current ? `${current} ${sentence}` : sentence;
    if (next.length > maxChars) {
      pieces.push(current.trim());
      current = sentence;
    } else {
      current = next;
    }
  }

  if (current.trim()) pieces.push(current.trim());
  return pieces;
}

function splitByWords(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  const pieces: string[] = [];
  let current = '';

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      pieces.push(current.trim());
      current = word;
    } else if (word.length > maxChars) {
      if (current) {
        pieces.push(current.trim());
        current = '';
      }
      for (let start = 0; start < word.length; start += maxChars) {
        pieces.push(word.slice(start, start + maxChars));
      }
    } else {
      current = next;
    }
  }

  if (current.trim()) pieces.push(current.trim());
  return pieces;
}

function mergeSegments(segments: string[], maxChars: number): string[] {
  const chunks: string[] = [];
  let current = '';

  for (const segment of segments) {
    const next = current ? `${current}\n\n${segment}` : segment;
    if (next.length > maxChars && current) {
      chunks.push(current.trim());
      current = segment;
    } else {
      current = next;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function extractTextFromWorkbook(buffer: Buffer): string {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetTexts = workbook.SheetNames.map((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_csv(sheet, { blankrows: false }).trim();
    if (!rows) return '';
    return `[Hoja: ${sheetName}]\n${rows}`;
  }).filter(Boolean);

  return normalizeExtractedText(sheetTexts.join('\n\n'));
}

function imageExtensionToMimeType(extension: SupportedImageExtension): string {
  if (extension === 'png') return 'image/png';
  if (extension === 'webp') return 'image/webp';
  return 'image/jpeg';
}
