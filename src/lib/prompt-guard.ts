/**
 * Prompt injection detection.
 *
 * Scans user input for patterns that attempt to override the bot's system
 * prompt, extract instructions, or jailbreak the model. Detected attempts are
 * blocked before reaching the LLM, logged, and counted in metrics.
 *
 * This is a defense-in-depth layer — the LLM's own instruction-following
 * (and the system prompt) are the primary protection. This adds a fast,
 * platform-controlled pre-filter that cannot be disabled by the tenant.
 */

export interface InjectionDetection {
  detected: boolean;
  type?: string;
}

const INJECTION_PATTERNS: Array<{ pattern: RegExp; type: string }> = [
  // Instruction override
  { pattern: /ignore\s+(all\s+)?previous\s+instructions?/i, type: 'instruction_override' },
  { pattern: /ignore\s+(the\s+)?(above|prior|earlier)/i, type: 'instruction_override' },
  { pattern: /disregard\s+(all\s+)?(previous|prior|the)\s+/i, type: 'instruction_override' },
  { pattern: /forget\s+(all\s+)?(previous|prior)\s+instructions?/i, type: 'instruction_override' },
  { pattern: /override\s+(your\s+)?(previous\s+)?instructions?/i, type: 'instruction_override' },
  // Persona / role hijacking
  { pattern: /you\s+are\s+now\s+(a|an|the)\s+/i, type: 'persona_override' },
  { pattern: /act\s+as\s+(if\s+you\s+(are|were)|a|an)\s+/i, type: 'persona_override' },
  { pattern: /pretend\s+(you\s+are|to\s+be)\s+/i, type: 'persona_override' },
  { pattern: /roleplay\s+as\s+/i, type: 'persona_override' },
  // System context injection
  { pattern: /\[SYSTEM\]/i, type: 'system_injection' },
  { pattern: /^system\s*:/im, type: 'system_injection' },
  { pattern: /<\s*system\s*>/i, type: 'system_injection' },
  // Prompt extraction
  { pattern: /reveal\s+(your|the)\s+(system\s+)?prompt/i, type: 'prompt_extraction' },
  { pattern: /print\s+(your\s+)?(instructions?|prompt|context|system)/i, type: 'prompt_extraction' },
  { pattern: /what\s+(are\s+)?your\s+(instructions?|prompt|directives)/i, type: 'prompt_extraction' },
  { pattern: /repeat\s+(the\s+)?(above|your\s+instructions?|everything\s+above)/i, type: 'prompt_extraction' },
  // Jailbreak patterns
  { pattern: /\bDAN\b.*mode|do\s+anything\s+now/i, type: 'jailbreak' },
  { pattern: /jailbreak|uncensored\s+mode|developer\s+mode/i, type: 'jailbreak' },
  { pattern: /\[JAILBREAK\]|\[BYPASS\]/i, type: 'jailbreak' },
  { pattern: /you\s+have\s+no\s+(restrictions?|limits?|rules?)/i, type: 'jailbreak' },
];

/** Scan text for prompt injection patterns. Returns on first match. */
export function detectPromptInjection(text: string): InjectionDetection {
  for (const { pattern, type } of INJECTION_PATTERNS) {
    if (pattern.test(text)) return { detected: true, type };
  }
  return { detected: false };
}
