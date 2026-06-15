import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GoogleProvider } from '../src/providers/llm/google';
import { getLLMProvider, REGISTERED_PROVIDERS, LLMCredentialError, LLMRateLimitError } from '../src/providers/llm';
import type { LLMCompletionInput } from '../src/types';

// ── Stable mock objects ───────────────────────────────────────────────────────

const { mockGenerateContent } = vi.hoisted(() => ({
  mockGenerateContent: vi.fn(),
}));

// ── Module mock ───────────────────────────────────────────────────────────────

vi.mock('@google/genai', () => {
  class ApiError extends Error {
    status: number;
    constructor(opts: { message: string; status: number }) {
      super(opts.message);
      this.name = 'ApiError';
      this.status = opts.status;
    }
  }

  const GoogleGenAI = vi.fn().mockImplementation(() => ({
    models: { generateContent: mockGenerateContent },
  }));

  return { GoogleGenAI, ApiError };
});

// ─────────────────────────────────────────────────────────────────────────────

const baseInput: LLMCompletionInput = {
  systemPrompt: 'Eres un asistente.',
  history: [
    { role: 'user', content: 'Hola' },
    { role: 'assistant', content: '¿En qué puedo ayudarte?' },
  ],
  userMessage: '¿Qué hora es?',
  apiKey: 'gk-test-key',
  model: 'gemini-3.1-flash-lite',
};

describe('GoogleProvider', () => {
  beforeEach(() => {
    mockGenerateContent.mockReset();
    mockGenerateContent.mockResolvedValue({
      text: 'Son las tres de la tarde.',
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7 },
    });
  });

  it('returns text and token usage from Gemini', async () => {
    const provider = new GoogleProvider();
    const result = await provider.complete(baseInput);

    expect(result.text).toBe('Son las tres de la tarde.');
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 7 });
  });

  it('maps assistant history turns to the Gemini "model" role and appends the user message', async () => {
    const provider = new GoogleProvider();
    await provider.complete(baseInput);

    expect(mockGenerateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-3.1-flash-lite',
        contents: [
          { role: 'user', parts: [{ text: 'Hola' }] },
          { role: 'model', parts: [{ text: '¿En qué puedo ayudarte?' }] },
          { role: 'user', parts: [{ text: '¿Qué hora es?' }] },
        ],
        config: expect.objectContaining({ systemInstruction: 'Eres un asistente.' }),
      }),
    );
  });

  it('throws LLMCredentialError on auth failure (401/403)', async () => {
    const { ApiError } = await import('@google/genai');
    mockGenerateContent.mockRejectedValueOnce(new ApiError({ message: 'invalid api key', status: 401 }));

    const provider = new GoogleProvider();
    await expect(provider.complete(baseInput)).rejects.toThrow(LLMCredentialError);
  });

  it('throws LLMRateLimitError on 429', async () => {
    const { ApiError } = await import('@google/genai');
    mockGenerateContent.mockRejectedValueOnce(new ApiError({ message: 'quota exceeded', status: 429 }));

    const provider = new GoogleProvider();
    await expect(provider.complete(baseInput)).rejects.toThrow(LLMRateLimitError);
  });
});

describe('LLM provider registry', () => {
  it('registers google alongside anthropic and openai', () => {
    expect(REGISTERED_PROVIDERS).toContain('google');
  });

  it('resolves google to GoogleProvider', () => {
    expect(getLLMProvider('google')).toBeInstanceOf(GoogleProvider);
  });

  it('throws for unknown provider', () => {
    expect(() => getLLMProvider('mistral')).toThrow('Unknown LLM provider');
  });
});
