import Anthropic from '@anthropic-ai/sdk';
import type { ClassificationResult } from '../types';

// Platform-controlled safety classifier — deliberately independent of whatever
// LLM a client chose for their bot. A weak or uncensored client model cannot
// degrade this layer.
//
// Two-tier strategy:
//   1. Fast synchronous keyword scan (always runs, no network call)
//   2. Async LLM-based contextual classification using the PLATFORM key
//      (SAFETY_PROVIDER_API_KEY) — not the client's key. Runs only when the
//      keyword scan returns no result AND the key is configured.
//
// Fallback policy: if the LLM classifier errors, fall back to the keyword
// result rather than blocking all normal conversations.

const CRISIS_PATTERNS: Array<{ pattern: RegExp; category: string }> = [
  // ── Spanish: suicidal ideation ─────────────────────────────────────────────
  { pattern: /\bsuicid[aeiou]/i, category: 'suicide_risk' },
  { pattern: /\bmatarme\b|\bme\s+quiero\s+matar\b|\bme\s+voy\s+a\s+matar\b/i, category: 'suicide_risk' },
  { pattern: /\bquiero\s+(morirme?|morir)\b|\bme\s+quiero\s+morir\b|\bdeseo\s+morir\b/i, category: 'suicide_risk' },
  { pattern: /quitarme\s+la\s+vida|acabar\s+con\s+mi\s+vida|fin\s+(a\s+)?mi\s+vida/i, category: 'suicide_risk' },
  { pattern: /no\s+quiero\s+(seguir\s+)?vivir|ya\s+no\s+quiero\s+vivir/i, category: 'suicide_risk' },
  { pattern: /pastillas?\s+para\s+(morir|matarme|suicidarme)/i, category: 'suicide_risk' },
  { pattern: /\btirarme\s+(de|desde|por)\b|\bcolgarme\b|\bahog[ae]rme\b/i, category: 'suicide_risk' },
  // ── Spanish: self-harm ─────────────────────────────────────────────────────
  { pattern: /hacerme\s+da[ñn]o|lastimarme|cortarme\s+las?\s+venas?/i, category: 'self_harm' },
  { pattern: /\bme\s+corto\b|\bme\s+lastimo\b|\bme\s+hiero\b/i, category: 'self_harm' },
  // ── Spanish: imminent danger ───────────────────────────────────────────────
  { pattern: /voy\s+a\s+(matar|atacar|herir)\s+(a\s+alguien|a\s+una\s+persona)/i, category: 'violence_risk' },
  // ── English ────────────────────────────────────────────────────────────────
  { pattern: /\b(kill|end)\s+my(self|\s+own\s+life|\s+life)\b/i, category: 'suicide_risk' },
  { pattern: /\bwant\s+to\s+die\b|\bwanna\s+die\b|\bgoing\s+to\s+kill\s+myself\b/i, category: 'suicide_risk' },
  { pattern: /\bcut\s+myself\b|\bhurt\s+myself\b|\bself[- ]harm\b/i, category: 'self_harm' },
  { pattern: /\btake\s+my\s+(own\s+)?life\b/i, category: 'suicide_risk' },
];

const LLM_CLASSIFICATION_PROMPT = `You are a safety classifier for a mental health application. Your ONLY job is to determine if the user message indicates an active mental health crisis: suicidal ideation, active self-harm intent, or immediate danger to self or others.

Rules:
- ONLY flag as crisis if the message contains EXPLICIT indicators (not metaphors, not general sadness, not frustration)
- "I want to die" = crisis. "This is killing me" (figurative) = NOT crisis.
- Respond ONLY with valid JSON. No other text.

Response format:
{"isCrisis": boolean, "category": "suicide_risk" | "self_harm" | "violence_risk" | null}`;

// 'strict'   — keyword scan + always run LLM tier (even on keyword miss)
// 'standard' — keyword scan + LLM only when no keyword match (default)
// 'minimal'  — keyword scan only, never escalate to LLM
export type SafetyLevel = 'strict' | 'standard' | 'minimal';

/**
 * Thrown when safetyLevel='strict' AND SAFETY_FAIL_CLOSED=true AND the LLM
 * classifier is unavailable. The caller should block the message and inform
 * the user that the service is temporarily unavailable.
 */
export class SafetyServiceUnavailableError extends Error {
  constructor() {
    super('Safety LLM classifier unavailable (fail-closed mode active)');
    this.name = 'SafetyServiceUnavailableError';
  }
}

export class SafetyClassifier {
  private llmClient?: Anthropic;
  private llmClientKey?: string; // track which key the cached client was built with

  classify(text: string): ClassificationResult {
    for (const { pattern, category } of CRISIS_PATTERNS) {
      if (pattern.test(text)) return { isCrisis: true, category };
    }
    return { isCrisis: false };
  }

  async classifyAsync(text: string, safetyLevel: SafetyLevel = 'standard'): Promise<ClassificationResult> {
    // Fast keyword check always runs first — no network, no latency
    const keywordResult = this.classify(text);

    // minimal: keyword only — LLM tier disabled for this bot
    if (safetyLevel === 'minimal') return keywordResult;

    // standard: escalate to LLM only when keyword scan found nothing
    if (safetyLevel === 'standard' && keywordResult.isCrisis) return keywordResult;

    // strict or standard-with-no-keyword-match: run LLM tier
    const platformKey = process.env.SAFETY_PROVIDER_API_KEY;
    if (!platformKey) return keywordResult;

    try {
      return await this.classifyWithLLM(text, platformKey);
    } catch {
      // Fail-closed mode: strict bots block the message when the LLM classifier is down.
      // Default is fail-open (keyword result) to avoid blocking normal conversations.
      if (safetyLevel === 'strict' && process.env.SAFETY_FAIL_CLOSED === 'true') {
        throw new SafetyServiceUnavailableError();
      }
      return keywordResult;
    }
  }

  private async classifyWithLLM(text: string, apiKey: string): Promise<ClassificationResult> {
    if (!this.llmClient || this.llmClientKey !== apiKey) {
      this.llmClient = new Anthropic({ apiKey });
      this.llmClientKey = apiKey;
    }

    const response = await this.llmClient.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 80,
      system: LLM_CLASSIFICATION_PROMPT,
      messages: [{ role: 'user', content: text }],
    });

    const raw = response.content[0].type === 'text' ? response.content[0].text.trim() : '{}';
    try {
      const parsed = JSON.parse(raw) as { isCrisis: boolean; category?: string | null };
      return { isCrisis: Boolean(parsed.isCrisis), category: parsed.category ?? undefined };
    } catch {
      return { isCrisis: false }; // fail open — malformed LLM JSON is not a crisis
    }
  }

  // Reset the cached LLM client (e.g., when the platform key is rotated)
  resetClient(): void {
    this.llmClient = undefined;
    this.llmClientKey = undefined;
  }
}

export const safetyClassifier = new SafetyClassifier();
