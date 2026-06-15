import type { LLMProvider } from './types';
import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';
import { GoogleProvider } from './google';

export { LLMCredentialError, LLMRateLimitError } from './types';
export type { LLMProvider };

export const REGISTERED_PROVIDERS = ['anthropic', 'openai', 'google'] as const;
export type RegisteredProvider = typeof REGISTERED_PROVIDERS[number];

const registry = new Map<string, LLMProvider>();

registry.set('anthropic', new AnthropicProvider());
registry.set('openai', new OpenAIProvider());
registry.set('google', new GoogleProvider());

export function getLLMProvider(providerName: string): LLMProvider {
  const provider = registry.get(providerName);
  if (!provider) {
    throw new Error(`Unknown LLM provider: "${providerName}". Registered: ${[...registry.keys()].join(', ')}`);
  }
  return provider;
}

export function registerLLMProvider(name: string, provider: LLMProvider): void {
  registry.set(name, provider);
}
