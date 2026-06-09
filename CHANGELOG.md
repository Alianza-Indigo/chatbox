# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [0.3.0] - 2026-06-09

### Added

- **Complete OpenAPI 3.0 spec** (`src/openapi.ts`): all 50+ routes documented with accurate request/response schemas, 13 Swagger UI tags, and component schemas for every resource type. Covers Bots, Channels, Knowledge, Integrations, Users/ARCO, Feedback, Proactive, Organizations, DLQ, and Crypto endpoints. Available at `/docs` (protected by `x-admin-key`).

- **Prisma enums** (migration `20260609000000_enums_retention_ratelimit`): converted 7 `String` columns to proper PostgreSQL enums for compile-time and DB-level type safety: `OrgPlan`, `OrgUserRole`, `BotStatus`, `BotSafetyLevel`, `ChannelStatus`, `MessageDirection`, `MessageInputType`.

- **Safety fail-closed mode** (`SAFETY_FAIL_CLOSED=true`): bots configured with `safetyLevel=strict` now block messages with a 503-style `SafetyServiceUnavailableError` when the LLM classifier is unreachable, instead of silently falling back to keyword-only detection.

- **Prompt injection detection** (`src/lib/prompt-guard.ts`): 17-category regex guard runs on all inbound text (post-STT) before the LLM call. Detected injections are blocked and logged; attempts are counted in the `chatbox_prompt_injection_blocks_total` metric.

- **Webhook replay protection**: inbound webhook messages with a `timestamp` older than `WEBHOOK_REPLAY_WINDOW_SECS` (default 300 s) are silently dropped and counted in `chatbox_stale_webhooks_total`. Set to `0` to disable.

- **Per-org Prometheus metrics**: `chatbox_org_messages_processed_total`, `chatbox_org_quota_blocks_total`, `chatbox_org_safety_blocks_total`, and `chatbox_org_llm_errors_total` — all labelled by `org_id` for per-tenant observability.

- **ARCO compliance endpoints**: `GET /:botId/users/:userId/export` (Derecho de Acceso — full decrypted data export), `PUT /:botId/users/:userId/rectify` (Derecho de Rectificación — update locale), and `DELETE /:botId/users/:userId/data` (Derecho de Supresión — full erasure). All create audit log entries.

- **Prompt versioning & rollback**: `POST /admin/bots/:id/prompt` appends a `BotPromptVersion` row and updates `bot.systemPrompt` atomically. `GET /admin/bots/:id/prompts` lists history. `POST /admin/bots/:id/rollback/:version` applies any prior version as a new version (non-destructive).

- **Bot branding CRUD** (`GET/PUT /admin/bots/:id/branding`): per-bot white-label config (company name, logo, colors, privacy/terms URLs).

- **Bot commands CRUD** (`GET/POST /admin/bots/:id/commands`, `PUT/DELETE /admin/bots/:id/commands/:cmdId`): keyword-triggered static or action responses.

- **Crisis config CRUD** (`GET/PUT /admin/bots/:id/crisis-config`): per-bot, per-country crisis helpline configuration, replacing the hardcoded Mexican fallback.

- **Meta Embedded Signup** (`POST /admin/bots/:botId/channels/embedded-signup`): exchanges Meta OAuth code for an access token and upserts the channel in a single call.

- **Feedback aggregation** (`GET /admin/bots/:botId/feedback`, `GET .../feedback/stats`): lists ratings and computes count/average/distribution.

- **Credential error dashboard** (`GET /admin/credential-errors`): lists bots in `credential_error` state scoped to the caller's org.

- **Operations runbooks** (`docs/runbooks/`): incident response, key rotation, DLQ replay, and key-rotation procedures with step-by-step instructions.

- **CI hardening** (`.github/workflows/ci.yml`): added `npx prisma validate`, `npm audit --audit-level=high`, and a TruffleHog secret-scanning job on all pushes.

- **Schema fields**: `Organization.msgRetentionDays` (nullable Int — message retention policy), `Bot.webhookRateLimit` (nullable Int — per-bot req/min cap overriding the global 60).

### Changed

- `Organization.plan` uses `OrgPlan` enum (`free`/`pro`/`enterprise`) — was String.
- `OrgUser.role` uses `OrgUserRole` enum (`owner`/`admin`/`editor`) — was String.
- `Bot.status` uses `BotStatus` enum — was String.
- `Bot.safetyLevel` uses `BotSafetyLevel` enum — was String.
- `Channel.status` uses `ChannelStatus` enum — was String.
- `Message.direction` uses `MessageDirection` enum — was String.
- `Message.inputType` uses `MessageInputType` enum — was String.
- `recordQuotaBlock`, `recordSafetyBlock`, `recordMessageProcessed` now accept an optional `orgId` parameter.

---

## [0.2.0] - 2026-06-09

### Added

- **Message body re-encryption endpoint** (`POST /admin/crypto/reencrypt-messages`): cursor-based paginated re-encryption of `Message.bodyEnc` blobs. Call in a loop with the returned `nextCursor` until `done: true`. Supports configurable `batchSize` (default 100, max 500). This unblocks key rotation for installations with large message histories.

- **DLQ bulk-purge by age** (`DELETE /admin/dlq?olderThanHours=N`): removes DLQ jobs older than the given number of hours using BullMQ's `clean()` API. Omit the query parameter to drain everything. Responds with `{ removed, olderThanHours }`. Replaces the previous all-or-nothing drain for more surgical cleanup.

### Fixed

- **Outbound message idempotency on retry**: if a worker attempt successfully called the LLM and persisted the outbound `Message` row but then failed before or during `sendText`, a subsequent retry now reuses the stored response instead of calling the LLM again. This prevents duplicate LLM charges and avoids sending inconsistent replies on retry. The idempotency key is `out-${waMessageId}`.

- **Knowledge in-process cosine fallback warning**: the `semanticRetrieval` function now emits a structured `logger.warn` when the in-process O(N) cosine scan runs against a knowledge base larger than 5 000 entries, prompting operators to enable pgvector for that bot.

---

## [0.1.0] - 2026-01-01

### Added

Initial release of the Chatbox multi-tenant WhatsApp chatbot platform.

- **Multi-tenant architecture**: organizations bring their own LLM API keys, WhatsApp channel credentials, and optional Sentry DSN. No shared per-customer secrets are held by the platform.
- **Message ingestion pipeline**: Meta Cloud API webhook (`POST /webhook/whatsapp/:phoneId`) validates HMAC-SHA256 signatures, deduplicates by `waMessageId`, and enqueues jobs to BullMQ before acknowledging the webhook.
- **Worker with per-conversation mutex**: BullMQ worker processes inbound messages with `concurrency: 10`. A Redis `SET NX` lock keyed on `(phoneId, from)` ensures messages from the same user are processed in order even under concurrency.
- **Crisis detection**: platform-controlled two-tier safety classifier (keyword patterns + optional LLM tier using the platform's own key) runs before and after LLM calls, independent of the tenant's chosen model. Detected crises bypass the LLM entirely and send country-appropriate crisis lines.
- **Quota management**: per-organization monthly message quota with atomic conditional SQL increments. `msgQuota = 0` means unlimited.
- **Encrypted PII**: end-user phone numbers and message bodies are encrypted with AES-256-GCM before entering Redis/BullMQ or PostgreSQL. Versioned wire format with KID header supports key rotation without downtime.
- **Knowledge base with pgvector**: per-bot knowledge entries with 1536-dim embeddings, HNSW index (cosine). Three-tier retrieval: DB-side ANN search via pgvector → in-process cosine similarity → keyword fallback.
- **Admin API**: full CRUD for organizations, bots, channels, knowledge, users, integrations. JWT authentication with superadmin bypass via `ADMIN_API_KEY` header.
- **Dead-letter queue**: exhausted jobs are moved to a DLQ for manual inspection and replay. Alerts delivered to `WEBHOOK_ALERT_URL` (Slack/Make.com/Zapier) and platform Sentry.
- **Observability**: Prometheus metrics (`/metrics`) for LLM duration, token counts, costs, error rates, quota blocks, safety blocks, and DLQ depth. Per-tenant Sentry integration.
- **Railway deployment**: `railway.toml` configures the web service with Nixpacks, Prisma generation, migration release command, and `/health` healthcheck. Worker runs as a separate Railway service.
