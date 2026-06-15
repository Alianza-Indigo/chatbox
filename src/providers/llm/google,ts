import { GoogleGenAI, ApiError } from '@google/genai';
import type { Content } from '@google/genai';
import type { LLMProvider } from './types';
import { LLMCredentialError, LLMRateLimitError } from './types';
import { recordLLMUsage, recordLLMError } from '../../services/metrics.service';
import type { LLMCompletionInput, LLMCompletionOutput } from '../../types';

export class GoogleProvider implements LLMProvider {
  async complete(input: LLMCompletionInput): Promise<LLMCompletionOutput> {
    const client = new GoogleGenAI({ apiKey: input.apiKey });

    // Gemini uses 'model' for assistant turns; the final user message is appended last.
    const contents: Content[] = [
      ...input.history.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      { role: 'user', parts: [{ text: input.userMessage }] },
    ];

    const startMs = Date.now();
    let response;
    try {
      response = await client.models.generateContent({
        model: input.model,
        contents,
        config: {
          systemInstruction: input.systemPrompt,
          maxOutputTokens: (input.params?.max_tokens as number | undefined) ?? 1024,
          temperature: input.params?.temperature as number | undefined,
        },
      });
    } catch (err) {
      recordLLMError('google', isRateLimit(err) ? 'rate_limit' : 'api_error');
      throw translateError(err);
    }

    const durationMs = Date.now() - startMs;
    const inputTokens = response.usageMetadata?.promptTokenCount ?? 0;
    const outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
    recordLLMUsage('google', input.model, durationMs, inputTokens, outputTokens);

    return {
      text: response.text ?? '',
      usage: { inputTokens, outputTokens },
    };
  }
}

function isRateLimit(err: unknown): boolean {
  return err instanceof ApiError && err.status === 429;
}

function translateError(err: unknown): Error {
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 403) {
      return new LLMCredentialError(`Google authentication failed: ${err.message}`);
    }
    if (err.status === 429) {
      return new LLMRateLimitError(`Google rate limit: ${err.message}`);
    }
  }
  return err instanceof Error ? err : new Error(String(err));
}
