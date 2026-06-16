import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

// Isolated registry — avoids polluting the global default registry in tests
export const registry = new Registry();
registry.setDefaultLabels({ service: 'chatbox' });

// Collect Node.js runtime metrics (heap, GC, event loop lag, etc.)
if (process.env.NODE_ENV !== 'test') {
  collectDefaultMetrics({ register: registry });
}

// ─── LLM ─────────────────────────────────────────────────────────────────────

export const llmDurationMs = new Histogram({
  name: 'chatbox_llm_request_duration_ms',
  help: 'LLM API call latency in milliseconds',
  labelNames: ['provider', 'model'] as const,
  buckets: [100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000],
  registers: [registry],
});

export const llmInputTokens = new Counter({
  name: 'chatbox_llm_input_tokens_total',
  help: 'Total input tokens consumed across all LLM calls',
  labelNames: ['provider', 'model'] as const,
  registers: [registry],
});

export const llmOutputTokens = new Counter({
  name: 'chatbox_llm_output_tokens_total',
  help: 'Total output tokens generated across all LLM calls',
  labelNames: ['provider', 'model'] as const,
  registers: [registry],
});

export const llmCostUsd = new Counter({
  name: 'chatbox_llm_estimated_cost_usd_total',
  help: 'Estimated LLM spend in USD based on public per-token pricing',
  labelNames: ['provider', 'model'] as const,
  registers: [registry],
});

export const llmErrors = new Counter({
  name: 'chatbox_llm_errors_total',
  help: 'LLM API errors by provider and error type',
  labelNames: ['provider', 'error_type'] as const,
  registers: [registry],
});

// ─── Meta / WhatsApp ─────────────────────────────────────────────────────────

export const metaApiErrors = new Counter({
  name: 'chatbox_meta_api_errors_total',
  help: 'Meta (WhatsApp Cloud API) errors by HTTP status code',
  labelNames: ['status_code'] as const,
  registers: [registry],
});

// ─── Queue ───────────────────────────────────────────────────────────────────

export const dlqDepth = new Gauge({
  name: 'chatbox_dlq_depth',
  help: 'Current number of jobs waiting in the dead-letter queue',
  registers: [registry],
});

// ─── Business ────────────────────────────────────────────────────────────────

export const quotaBlocks = new Counter({
  name: 'chatbox_quota_blocks_total',
  help: 'Inbound messages rejected because the org monthly quota was exceeded',
  registers: [registry],
});

export const safetyBlocks = new Counter({
  name: 'chatbox_safety_blocks_total',
  help: 'Messages intercepted by the safety classifier',
  labelNames: ['action_taken'] as const,
  registers: [registry],
});

export const messagesProcessed = new Counter({
  name: 'chatbox_messages_processed_total',
  help: 'Total inbound messages fully processed (past all gates)',
  registers: [registry],
});

export const promptInjectionBlocks = new Counter({
  name: 'chatbox_prompt_injection_blocks_total',
  help: 'Messages blocked due to detected prompt injection attempts',
  labelNames: ['type'] as const,
  registers: [registry],
});

export const staleWebhooks = new Counter({
  name: 'chatbox_stale_webhooks_total',
  help: 'Inbound webhook messages skipped because their timestamp exceeded the replay window',
  registers: [registry],
});

export const membershipBlocks = new Counter({
  name: 'chatbox_membership_blocks_total',
  help: 'Messages blocked by the end-user paywall (microsaas mode) per organization',
  labelNames: ['org_id'] as const,
  registers: [registry],
});

export const membershipActivations = new Counter({
  name: 'chatbox_membership_activations_total',
  help: 'End-user memberships activated via a payment-provider webhook per organization',
  labelNames: ['org_id'] as const,
  registers: [registry],
});

// ─── Per-tenant counters ──────────────────────────────────────────────────────
// These provide per-org observability without modifying the existing global metrics.

export const orgMessagesProcessed = new Counter({
  name: 'chatbox_org_messages_processed_total',
  help: 'Messages fully processed per organization',
  labelNames: ['org_id'] as const,
  registers: [registry],
});

export const orgQuotaBlocks = new Counter({
  name: 'chatbox_org_quota_blocks_total',
  help: 'Quota-exceeded blocks per organization',
  labelNames: ['org_id'] as const,
  registers: [registry],
});

export const orgSafetyBlocks = new Counter({
  name: 'chatbox_org_safety_blocks_total',
  help: 'Safety blocks per organization and action',
  labelNames: ['org_id', 'action_taken'] as const,
  registers: [registry],
});

export const orgLlmErrors = new Counter({
  name: 'chatbox_org_llm_errors_total',
  help: 'LLM errors per organization, provider, and error type',
  labelNames: ['org_id', 'provider', 'error_type'] as const,
  registers: [registry],
});

// ─── Cost estimation table (USD per 1M tokens, Q1 2025) ──────────────────────
// Keys are substrings matched against the model name (longest match wins).

const COST_INPUT_PER_M: [string, number][] = [
  ['claude-opus-4', 15.0],
  ['claude-sonnet-4', 3.0],
  ['claude-haiku-4', 0.80],
  ['claude-haiku', 0.25],
  ['claude-sonnet', 3.0],
  ['claude-opus', 15.0],
  ['gpt-4o-mini', 0.15],
  ['gpt-4o', 2.50],
  ['gpt-4', 30.0],
  ['gpt-3.5', 0.50],
  ['gemini-3.1-flash-lite', 0.10],
  ['flash-lite', 0.10],
  ['gemini-3.1-flash', 0.30],
  ['gemini-flash', 0.30],
  ['gemini-pro', 1.25],
  ['gemini', 0.30],
];

const COST_OUTPUT_PER_M: [string, number][] = [
  ['claude-opus-4', 75.0],
  ['claude-sonnet-4', 15.0],
  ['claude-haiku-4', 4.0],
  ['claude-haiku', 1.25],
  ['claude-sonnet', 15.0],
  ['claude-opus', 75.0],
  ['gpt-4o-mini', 0.60],
  ['gpt-4o', 10.0],
  ['gpt-4', 60.0],
  ['gpt-3.5', 1.50],
  ['gemini-3.1-flash-lite', 0.40],
  ['flash-lite', 0.40],
  ['gemini-3.1-flash', 2.50],
  ['gemini-flash', 2.50],
  ['gemini-pro', 10.0],
  ['gemini', 2.50],
];

function lookupCost(table: [string, number][], model: string): number {
  const lower = model.toLowerCase();
  // Iterate in declared order (most-specific first)
  for (const [key, cost] of table) {
    if (lower.includes(key)) return cost;
  }
  return 1.0; // unknown model — conservative fallback
}

// ─── Helper functions called by providers / services ─────────────────────────

export function recordLLMUsage(
  provider: string,
  model: string,
  durationMs: number,
  inputTokens: number,
  outputTokens: number,
): void {
  const labels = { provider, model };
  llmDurationMs.observe(labels, durationMs);
  if (inputTokens > 0) llmInputTokens.inc(labels, inputTokens);
  if (outputTokens > 0) llmOutputTokens.inc(labels, outputTokens);

  const inputCost = (inputTokens / 1_000_000) * lookupCost(COST_INPUT_PER_M, model);
  const outputCost = (outputTokens / 1_000_000) * lookupCost(COST_OUTPUT_PER_M, model);
  if (inputCost + outputCost > 0) llmCostUsd.inc(labels, inputCost + outputCost);
}

export function recordLLMError(provider: string, errorType: string): void {
  llmErrors.inc({ provider, error_type: errorType });
}

export function recordMetaError(statusCode: number): void {
  metaApiErrors.inc({ status_code: String(statusCode) });
}

export function recordQuotaBlock(orgId?: string): void {
  quotaBlocks.inc();
  if (orgId) orgQuotaBlocks.inc({ org_id: orgId });
}

export function recordSafetyBlock(actionTaken: string, orgId?: string): void {
  safetyBlocks.inc({ action_taken: actionTaken });
  if (orgId) orgSafetyBlocks.inc({ org_id: orgId, action_taken: actionTaken });
}

export function recordMessageProcessed(orgId?: string): void {
  messagesProcessed.inc();
  if (orgId) orgMessagesProcessed.inc({ org_id: orgId });
}

export function recordPromptInjectionBlock(type: string): void {
  promptInjectionBlocks.inc({ type });
}

export function recordStaleWebhook(): void {
  staleWebhooks.inc();
}

export function recordMembershipBlock(orgId: string): void {
  membershipBlocks.inc({ org_id: orgId });
}

export function recordMembershipActivation(orgId: string): void {
  membershipActivations.inc({ org_id: orgId });
}

export function recordOrgLlmError(orgId: string, provider: string, errorType: string): void {
  orgLlmErrors.inc({ org_id: orgId, provider, error_type: errorType });
}

export function updateDLQDepth(depth: number): void {
  dlqDepth.set(depth);
}
