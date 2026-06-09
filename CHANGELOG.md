# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
