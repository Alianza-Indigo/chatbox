import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotKnowledge } from '@prisma/client';

const { mockEmbeddingsCreate, mockQueryRaw, mockExecuteRaw, mockPdfParse } = vi.hoisted(() => ({
  mockEmbeddingsCreate: vi.fn().mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
  mockQueryRaw: vi.fn().mockRejectedValue(new Error('pgvector unavailable in tests')),
  mockExecuteRaw: vi.fn(),
  mockPdfParse: vi.fn(),
}));

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    embeddings: { create: mockEmbeddingsCreate },
  })),
}));

vi.mock('pdf-parse', () => ({
  default: mockPdfParse,
}));

vi.mock('../src/db', () => ({
  db: {
    $queryRaw: mockQueryRaw,
    $executeRaw: mockExecuteRaw,
  },
}));

vi.mock('../src/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
  getByKeyword,
  getRelevantKnowledge,
  encodeEmbedding,
  decodeEmbedding,
  generateEmbedding,
  extractTextFromPdf,
  extractTextFromImage,
  attachImportMetadataToChunks,
  buildKnowledgeChunksFromText,
  getSupportedDocumentExtension,
  clearEmbeddingVector,
  previewRelevantKnowledge,
} from '../src/services/knowledge.service';

function makeEntry(id: string, title: string, content: string, tags: string[] = [], embeddingVec?: number[]): BotKnowledge {
  return {
    id,
    botId: 'bot-1',
    title,
    content,
    tags,
    embeddingData: embeddingVec ? encodeEmbedding(embeddingVec) : null,
    hasEmbedding: !!embeddingVec,
  } as BotKnowledge;
}

const KB: BotKnowledge[] = [
  makeEntry('e1', 'Serpientes en suenos', 'Las serpientes suelen representar transformacion o peligro latente.', ['serpiente', 'transformacion']),
  makeEntry('e2', 'Volar en suenos', 'Sonar que vuelas puede indicar deseo de libertad o escapar de problemas.', ['volar', 'libertad']),
  makeEntry('e3', 'Agua en suenos', 'El agua simboliza las emociones y el subconsciente.', ['agua', 'emocion']),
];

describe('getByKeyword', () => {
  it('returns entries matching a query word', () => {
    const results = getByKeyword(KB, 'sone con serpientes');
    expect(results.map((r) => r.id)).toContain('e1');
  });

  it('returns entries matching via tags', () => {
    const results = getByKeyword(KB, 'libertad');
    expect(results.map((r) => r.id)).toContain('e2');
  });

  it('returns empty array when no match', () => {
    const results = getByKeyword(KB, 'dinosaurio');
    expect(results).toHaveLength(0);
  });

  it('ignores short words (<=3 chars)', () => {
    const results = getByKeyword(KB, 'en el');
    expect(results).toHaveLength(0);
  });

  it('matches multiple entries for broad queries', () => {
    const results = getByKeyword(KB, 'suenos emocion transformacion');
    const ids = results.map((r) => r.id);
    expect(ids).toContain('e1');
    expect(ids).toContain('e3');
  });
});

describe('encodeEmbedding / decodeEmbedding', () => {
  it('round-trips a float32 vector', () => {
    const original = [0.1, 0.5, -0.3, 0.9, 0.0];
    const encoded = encodeEmbedding(original);
    const decoded = decodeEmbedding(encoded);
    for (let i = 0; i < original.length; i++) {
      expect(decoded[i]).toBeCloseTo(original[i], 5);
    }
  });

  it('handles a 1536-dim vector (text-embedding-3-small output size)', () => {
    const vec = Array.from({ length: 1536 }, (_, i) => Math.sin(i));
    const buf = encodeEmbedding(vec);
    const back = decodeEmbedding(buf);
    expect(back.length).toBe(1536);
    expect(back[0]).toBeCloseTo(vec[0], 5);
  });
});

describe('getRelevantKnowledge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueryRaw.mockRejectedValue(new Error('pgvector unavailable in tests'));
    mockEmbeddingsCreate.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
  });

  it('returns keyword results when no embedder key is provided', async () => {
    const result = await getRelevantKnowledge('bot-1', KB, 'sone con agua', undefined);
    expect(result).toContain('Agua en suenos');
    expect(result).not.toContain('Volar en suenos');
  });

  it('returns empty string when nothing matches', async () => {
    const result = await getRelevantKnowledge('bot-1', KB, 'dinosaurio jurasico', undefined);
    expect(result).toBe('');
  });

  it('returns empty string for empty knowledge base', async () => {
    const result = await getRelevantKnowledge('bot-1', [], 'serpiente', undefined);
    expect(result).toBe('');
  });

  it('uses semantic retrieval when embedder key is provided and entries have embeddings', async () => {
    const vec1 = [1, 0, 0, 0];
    const vec2 = [0, 1, 0, 0];
    const vec3 = [0, 0, 1, 0];
    const queryVec = [1, 0.1, 0, 0];

    const kbWithEmbeddings: BotKnowledge[] = [
      makeEntry('s1', 'Serpientes', 'Transformacion', [], vec1),
      makeEntry('s2', 'Volar', 'Libertad', [], vec2),
      makeEntry('s3', 'Agua', 'Emociones', [], vec3),
    ];

    mockEmbeddingsCreate.mockResolvedValueOnce({ data: [{ embedding: queryVec }] });

    const result = await getRelevantKnowledge('bot-1', kbWithEmbeddings, 'serpiente', 'fake-key');
    expect(mockQueryRaw).toHaveBeenCalled();
    expect(result).toContain('Serpientes');
    expect(result).not.toContain('Volar');
  });

  it('falls back to keyword search when semantic fails (API error)', async () => {
    const kbWithEmbeddings: BotKnowledge[] = [
      makeEntry('s1', 'Serpientes', 'Transformacion y peligro', [], [1, 0, 0]),
    ];

    mockEmbeddingsCreate.mockRejectedValueOnce(new Error('OpenAI API error'));
    mockEmbeddingsCreate.mockRejectedValueOnce(new Error('OpenAI API error'));

    const result = await getRelevantKnowledge('bot-1', kbWithEmbeddings, 'serpiente transformacion', 'fake-key');
    expect(result).toContain('Serpientes');
  });
});

describe('previewRelevantKnowledge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueryRaw.mockRejectedValue(new Error('pgvector unavailable in tests'));
  });

  it('returns keyword mode and matching entries when there is no embedder key', async () => {
    const result = await previewRelevantKnowledge('bot-1', KB, 'serpientes transformacion', undefined);
    expect(result.mode).toBe('keyword');
    expect(result.entries.map((entry) => entry.id)).toContain('e1');
    expect(result.formatted).toContain('Serpientes en suenos');
  });
});

describe('generateEmbedding', () => {
  beforeEach(() => {
    mockEmbeddingsCreate.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
  });

  it('calls the OpenAI embeddings API with the correct model', async () => {
    const result = await generateEmbedding('test text', 'sk-test', 'text-embedding-3-small');
    expect(result).toEqual([0.1, 0.2, 0.3]);
    expect(mockEmbeddingsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'text-embedding-3-small', input: 'test text' }),
    );
  });
});

describe('PDF extraction and chunking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('normalizes extracted PDF text', async () => {
    mockPdfParse.mockResolvedValueOnce({ text: 'Titulo\r\n\r\nLinea 1   \nLinea 2\n\n\nLinea 3' });
    const text = await extractTextFromPdf(Buffer.from('fake pdf'));
    expect(text).toBe('Titulo\n\nLinea 1\nLinea 2\n\nLinea 3');
  });

  it('splits long PDF text into titled chunks', () => {
    const text = [
      'Primer parrafo con bastante texto para obligar chunking.',
      'Segundo parrafo con aun mas contenido para dividirlo en varias partes.',
      'Tercer parrafo para cerrar el documento.',
    ].join('\n\n');

    const chunks = buildKnowledgeChunksFromText('Manual', text, 70, ['pdf']);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].title).toContain('Manual');
    expect(chunks.every((chunk) => chunk.tags.includes('pdf'))).toBe(true);
  });

  it('adds hidden import metadata tags to uploaded chunks', () => {
    const chunks = attachImportMetadataToChunks(
      buildKnowledgeChunksFromText('Manual', 'Primer bloque\n\nSegundo bloque', 20, ['pdf']),
      'source-123',
    );
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((chunk) => chunk.tags.includes('__source:source-123'))).toBe(true);
    expect(chunks[0]?.tags.some((tag) => tag.startsWith('__chunk:'))).toBe(true);
  });

  it('detects supported document formats by filename or mimetype', () => {
    expect(getSupportedDocumentExtension('archivo.docx', 'application/octet-stream')).toBe('docx');
    expect(getSupportedDocumentExtension(undefined, 'application/vnd.ms-excel')).toBe('xls');
    expect(getSupportedDocumentExtension('captura.png', 'application/octet-stream')).toBe('png');
    expect(getSupportedDocumentExtension('desconocido.bin', 'application/octet-stream')).toBeNull();
  });

  it('rejects OCR on unsupported providers', async () => {
    await expect(extractTextFromImage(Buffer.from('img'), 'png', 'mistral', 'fake-key', 'mistral-small')).rejects.toThrow(
      'OCR is not supported for provider "mistral"',
    );
  });
});

describe('clearEmbeddingVector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clears the pgvector column for a knowledge row', async () => {
    await clearEmbeddingVector('knowledge-1');
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
  });
});
