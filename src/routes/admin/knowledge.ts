import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { db } from '../../db';
import { invalidateBotCache } from '../../services/bot.service';
import {
  attachImportMetadataToChunks,
  buildKnowledgeChunksFromText,
  clearEmbeddingVector,
  extractTextFromDocument,
  extractTextFromImage,
  extractTextFromPdfWithOcrFallback,
  generateEmbedding,
  getSupportedDocumentExtension,
  previewRelevantKnowledge,
  type SupportedImageExtension,
  encodeEmbedding,
  saveEmbeddingVector,
} from '../../services/knowledge.service';
import { decrypt, decryptJson } from '../../crypto';
import { requirePermission } from '../../lib/rbac';
import { parseBody, KnowledgeSchema, PreviewKnowledgeSchema, UpdateKnowledgeSchema } from '../../lib/validate';

const knowledgeRoutes: FastifyPluginAsync = async (fastify) => {
  const handleDocumentUpload = async (
    req: FastifyRequest<{ Params: { botId: string } }>,
    reply: FastifyReply,
  ) => {
    const file = await req.file();
    if (!file) return reply.status(400).send({ error: 'Document file is required' });
    const extension = getSupportedDocumentExtension(file.filename, file.mimetype);
    if (!extension) {
      return reply.status(415).send({ error: 'Supported formats: pdf, docx, txt, csv, xlsx, xls' });
    }

    const bot = await db.bot.findUnique({
      where: { id: req.params.botId },
      include: { integrations: { where: { kind: 'embeddings', status: 'active' } } },
    });
    if (!bot) return reply.status(404).send({ error: 'Bot not found' });

    const sourceBuffer = await file.toBuffer();
    const sourceTitle = formatDocumentTitle(file.filename);
    let extractedText = '';
    try {
      if (isImageExtension(extension)) {
        extractedText = await extractTextFromConfiguredProvider(sourceBuffer, extension, bot);
      } else if (extension === 'pdf' && bot.llmProvider && bot.llmModel && bot.llmApiKeyEnc) {
        extractedText = await extractTextFromPdfWithOcrFallback(
          sourceBuffer,
          bot.llmProvider,
          decrypt(bot.llmApiKeyEnc),
          bot.llmModel,
        );
      } else {
        extractedText = await extractTextFromDocument(sourceBuffer, extension);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not extract text from document';
      return reply.status(422).send({ error: message });
    }
    const chunkTags = isImageExtension(extension) ? [extension, 'ocr'] : [extension];
    const chunks = attachImportMetadataToChunks(
      buildKnowledgeChunksFromText(sourceTitle, extractedText, undefined, chunkTags),
      randomUUID(),
    );
    if (!chunks.length) {
      return reply.status(422).send({ error: 'The document does not contain readable text' });
    }

    const createdItems = await db.$transaction(
      chunks.map((chunk) =>
        db.botKnowledge.create({
          data: { botId: req.params.botId, title: chunk.title, content: chunk.content, tags: chunk.tags },
        }),
      ),
    );

    const embedApiKey = resolveEmbeddingApiKey(bot.integrations, bot.llmProvider, bot.llmApiKeyEnc);
    let embedded = 0;
    let failed = 0;

    if (embedApiKey) {
      for (const item of createdItems) {
        try {
          const vec = await generateEmbedding(`${item.title}\n${item.content}`, embedApiKey);
          await db.botKnowledge.update({
            where: { id: item.id },
            data: { embeddingData: encodeEmbedding(vec), hasEmbedding: true },
          });
          await saveEmbeddingVector(item.id, vec).catch(() => { /* pgvector unavailable */ });
          embedded++;
        } catch {
          failed++;
        }
      }
    }

    invalidateBotCache(req.params.botId);
    return reply.status(201).send({
      sourceTitle,
      sourceType: extension,
      created: createdItems.length,
      embedded,
      failed,
      totalChunks: chunks.length,
    });
  };

  fastify.get<{ Params: { botId: string } }>('/:botId/knowledge', async (req, reply) => {
    const items = await db.botKnowledge.findMany({
      where: { botId: req.params.botId },
      select: { id: true, botId: true, title: true, content: true, tags: true, hasEmbedding: true },
    });
    return reply.send(items);
  });

  fastify.post<{ Params: { botId: string } }>('/:botId/knowledge', { preHandler: [requirePermission('bot:update-knowledge')] }, async (req, reply) => {
    const { title, content, tags } = parseBody(KnowledgeSchema, req.body);
    const item = await db.botKnowledge.create({
      data: { botId: req.params.botId, title, content, tags: tags ?? [] },
    });
    invalidateBotCache(req.params.botId);
    return reply.status(201).send(item);
  });

  fastify.put<{ Params: { botId: string; itemId: string } }>('/:botId/knowledge/:itemId', { preHandler: [requirePermission('bot:update-knowledge')] }, async (req, reply) => {
    const { botId, itemId } = req.params;
    const existing = await db.botKnowledge.findUnique({ where: { id: itemId }, select: { botId: true } });
    if (!existing || existing.botId !== botId) return reply.status(404).send({ error: 'Knowledge item not found' });

    const body = parseBody(UpdateKnowledgeSchema, req.body);
    const data: Record<string, unknown> = {};
    if (body.title !== undefined) data.title = body.title;
    if (body.content !== undefined) {
      data.content = body.content;
      // Clear embedding when content changes — it becomes stale
      data.embeddingData = null;
      data.hasEmbedding = false;
    }
    if (body.tags !== undefined) data.tags = body.tags;
    const item = await db.botKnowledge.update({ where: { id: itemId }, data });
    if (body.content !== undefined) {
      await clearEmbeddingVector(itemId).catch(() => { /* pgvector unavailable */ });
    }
    invalidateBotCache(botId);
    return reply.send(item);
  });

  fastify.delete<{ Params: { botId: string; itemId: string } }>('/:botId/knowledge/:itemId', { preHandler: [requirePermission('bot:update-knowledge')] }, async (req, reply) => {
    const { botId, itemId } = req.params;
    const existing = await db.botKnowledge.findUnique({ where: { id: itemId }, select: { botId: true } });
    if (!existing || existing.botId !== botId) return reply.status(404).send({ error: 'Knowledge item not found' });
    await db.botKnowledge.delete({ where: { id: itemId } });
    invalidateBotCache(botId);
    return reply.status(204).send();
  });

  fastify.post<{ Params: { botId: string } }>('/:botId/knowledge/upload-document', { preHandler: [requirePermission('bot:update-knowledge')] }, async (req, reply) => {
    return handleDocumentUpload(req, reply);
  });

  fastify.post<{ Params: { botId: string } }>('/:botId/knowledge/upload-pdf', { preHandler: [requirePermission('bot:update-knowledge')] }, async (req, reply) => {
    return handleDocumentUpload(req, reply);
  });

  fastify.post<{ Params: { botId: string } }>('/:botId/knowledge/preview', { preHandler: [requirePermission('bot:update-knowledge')] }, async (req, reply) => {
    const { query } = parseBody(PreviewKnowledgeSchema, req.body);
    const bot = await db.bot.findUnique({
      where: { id: req.params.botId },
      include: { knowledge: true, integrations: { where: { kind: 'embeddings', status: 'active' } } },
    });
    if (!bot) return reply.status(404).send({ error: 'Bot not found' });

    const embedApiKey = resolveEmbeddingApiKey(bot.integrations, bot.llmProvider, bot.llmApiKeyEnc);
    const result = await previewRelevantKnowledge(bot.id, bot.knowledge, query, embedApiKey);
    return reply.send({
      query,
      mode: result.mode,
      total: result.entries.length,
      items: result.entries.map((entry) => ({
        id: entry.id,
        botId: entry.botId,
        title: entry.title,
        content: entry.content,
        tags: entry.tags,
        hasEmbedding: entry.hasEmbedding,
      })),
    });
  });

  // Generate / refresh embeddings for all knowledge entries of a bot.
  // Uses the bot's OpenAI LLM key if available; otherwise a dedicated embeddings integration.
  fastify.post<{ Params: { botId: string } }>('/:botId/knowledge/embed', { preHandler: [requirePermission('bot:update-knowledge')] }, async (req, reply) => {
    const bot = await db.bot.findUnique({
      where: { id: req.params.botId },
      include: { knowledge: true, integrations: { where: { kind: 'embeddings', status: 'active' } } },
    });
    if (!bot) return reply.status(404).send({ error: 'Bot not found' });

    const embedApiKey = resolveEmbeddingApiKey(bot.integrations, bot.llmProvider, bot.llmApiKeyEnc);
    if (!embedApiKey) {
      return reply.status(422).send({ error: 'No embedding API key configured. Add an OpenAI LLM key or a dedicated embeddings integration.' });
    }

    let updated = 0;
    let failed = 0;
    for (const entry of bot.knowledge) {
      try {
        const vec = await generateEmbedding(`${entry.title}\n${entry.content}`, embedApiKey);
        await db.botKnowledge.update({
          where: { id: entry.id },
          data: { embeddingData: encodeEmbedding(vec), hasEmbedding: true },
        });
        // Best-effort: populate pgvector column for ANN search; falls back to
        // in-process cosine similarity if pgvector is not installed.
        await saveEmbeddingVector(entry.id, vec).catch(() => { /* pgvector unavailable */ });
        updated++;
      } catch {
        failed++;
      }
    }

    invalidateBotCache(req.params.botId);
    return reply.send({ updated, failed, total: bot.knowledge.length });
  });
};

function resolveEmbeddingApiKey(
  integrations: Array<{ credentials: Buffer | Uint8Array }>,
  llmProvider?: string | null,
  llmApiKeyEnc?: Buffer | Uint8Array | null,
): string | undefined {
  if (integrations.length > 0) {
    const creds = decryptJson<{ apiKey: string }>(integrations[0].credentials);
    if (creds.apiKey) return creds.apiKey;
  }
  if (llmProvider === 'openai' && llmApiKeyEnc) {
    return decrypt(llmApiKeyEnc);
  }
  return undefined;
}

function formatDocumentTitle(filename?: string): string {
  const raw = (filename ?? 'Documento').replace(/\.[a-z0-9]+$/i, '').trim();
  return raw || 'Documento';
}

async function extractTextFromConfiguredProvider(
  buffer: Buffer,
  extension: SupportedImageExtension,
  bot: { llmProvider: string | null; llmModel: string | null; llmApiKeyEnc: Buffer | Uint8Array | null },
): Promise<string> {
  if (!bot.llmProvider || !bot.llmModel || !bot.llmApiKeyEnc) {
    throw new Error('Image OCR requires the bot to have its provider, model, and API key configured');
  }
  const apiKey = decrypt(bot.llmApiKeyEnc);
  return extractTextFromImage(buffer, extension, bot.llmProvider, apiKey, bot.llmModel);
}

function isImageExtension(extension: string): extension is SupportedImageExtension {
  return extension === 'png' || extension === 'jpg' || extension === 'jpeg' || extension === 'webp';
}

export default knowledgeRoutes;
