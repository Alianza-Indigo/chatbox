# Runbook: Incident Response

## Escalation channels

| Channel | Use for |
|---|---|
| Platform Sentry (`SENTRY_DSN`) | Infrastructure errors: 5xx responses, exhausted BullMQ jobs, unhandled worker exceptions |
| Tenant Sentry (`Organization.sentryDsnEnc`) | Bot-level errors: `LLMCredentialError`, `LLMRateLimitError`, `job_exhausted` per tenant |
| `WEBHOOK_ALERT_URL` | Real-time alerts to Slack/Make.com/Zapier: `dlq_job_added`, `credential_error`, `llm_failure` |
| Railway logs | Raw pino JSON logs; correlate by `requestId` field across HTTP → queue → worker |

All structured alerts include a `timestamp` field. `requestId` (UUID) is echoed on every HTTP response as `X-Request-Id` and propagated through the queue payload for end-to-end tracing.

---

## Redis down

### Symptoms

- `GET /health` returns `{ "status": "degraded", "redis": false }` with HTTP 503.
- Worker process may crash or fail to acquire conversation locks.
- New inbound webhooks return 500 after the producer attempts to enqueue.
- No new messages are processed; the main queue stalls.

### Impact

- All inbound message processing stops. WhatsApp messages are accepted by Meta but queued there until the webhook is retried (Meta retries for up to 24 hours).
- Admin API endpoints that do not touch Redis continue to work (CRUD, health DB path).
- Messages already in-flight in BullMQ may be re-delivered by Redis once it recovers, depending on the outage duration and persistence configuration.

### Recovery steps

1. Verify Redis connectivity from the Railway environment: check the Railway Redis service status page or run a health probe against `REDIS_URL`.
2. If using Railway Redis, check for Railway platform incidents at https://status.railway.app.
3. Once Redis is restored, `GET /health` should return `{ "status": "ok" }` within seconds — the health check uses a live `PING`.
4. The BullMQ worker reconnects automatically using the `ioredis` retry strategy. No restart required in most cases.
5. If the worker process exited, Railway's `restartPolicyType: ON_FAILURE` will restart it. Confirm in Railway logs.
6. Check the DLQ (`GET /admin/dlq/count`) for jobs that exhausted retries during the outage and replay as needed (see `dlq-replay.md`).

---

## Database down

### Symptoms

- `GET /health` returns `{ "status": "degraded", "db": false }` with HTTP 503.
- Admin API endpoints return 500.
- Worker jobs fail with Prisma connection errors and retry; after exhausting retries they move to the DLQ.
- Platform Sentry captures Prisma `P1001` (connection refused) or `P1002` (timeout) errors.

### Impact

- The HTTP API returns 503 for all endpoints requiring DB access. The `/health` endpoint remains reachable (it handles DB failure gracefully).
- Worker processing is blocked: every job that touches the DB will fail and retry, eventually landing in the DLQ.
- Webhook ingestion may still accept and enqueue messages (the producer only writes to Redis), but processing will not advance until the DB is restored.

### Recovery steps

1. Check the Railway PostgreSQL service status. If using Railway Postgres, inspect the service logs for crash/OOM signals.
2. If the database is healthy but Railway's internal network is disrupted, wait for Railway to restore routing (check https://status.railway.app).
3. Once connectivity is restored, the Prisma client reconnects automatically on the next query.
4. Verify recovery: `GET /health` should return `{ "db": true }`.
5. Check the DLQ for jobs that exhausted retries during the outage. Review `failedReason` values — jobs with DB connection errors are safe to replay. See `dlq-replay.md`.
6. If the DB required a failover or restore from backup, run `node dist/migrate.js` against the restored instance before replaying any DLQ jobs to ensure schema is current.

---

## WhatsApp (Meta Cloud API) unavailable

### Symptoms

- `channelProvider.sendText()` throws with HTTP 5xx from `graph.facebook.com`.
- Worker jobs fail at the send step (after LLM has already responded) and retry.
- `llm_failure` or generic error alerts appear in `WEBHOOK_ALERT_URL`.
- Meta's webhook delivery may also pause or delay during a Meta outage.

### Impact

- Bot responses are generated but cannot be delivered. The job retries with exponential backoff (up to 3 attempts).
- Inbound webhook ingestion from Meta may slow or stop depending on the nature of the outage.
- Once retries are exhausted, jobs move to the DLQ with the send error as `failedReason`.

### Recovery steps

1. Confirm the outage is on Meta's side: check https://developers.facebook.com/status/ and https://metastatus.com.
2. During the outage, do not drain the DLQ — jobs contain the original message payloads and should be replayed once Meta recovers.
3. Once Meta is restored, replay DLQ jobs via `POST /admin/dlq/:jobId/retry`. For jobs where the LLM response was already generated and persisted (outbound idempotency key `out-${waMessageId}` exists), the retry will skip the LLM call and go straight to send.
4. For a large volume of DLQ jobs after a prolonged Meta outage, replay in batches. Monitor `WEBHOOK_ALERT_URL` for `dlq_job_added` alerts to confirm jobs are not re-failing.
5. If Meta's retry of the original webhooks delivers duplicates, BullMQ's `jobId: wa-${waMessageId}` deduplication prevents double-processing.

---

## LLM provider down

### Symptoms

- Worker jobs fail with errors from the LLM provider API (OpenAI, Anthropic, etc.).
- `LLMRateLimitError`: 429 from the LLM provider. Bot continues processing — the error triggers a retry and a `llm_failure` alert.
- `LLMCredentialError`: 401/403 from the LLM provider. Bot status is set to `credential_error` in the DB, bot goes silent (messages are dropped), and a `credential_error` alert fires to `WEBHOOK_ALERT_URL` and tenant Sentry.
- Generic LLM errors (5xx from the provider): job is retried and a `llm_failure` alert fires.

### Impact for LLMRateLimitError

- The job retries up to 3 times with exponential backoff. If all retries fail, it moves to the DLQ.
- Other bots on the same platform are unaffected.

### Impact for LLMCredentialError

- The specific bot stops processing all new messages silently until the credential is fixed.
- Bot status in DB is `credential_error`; the bot will not process messages even after a worker restart.

### Recovery steps (rate limit)

1. Check the LLM provider's status page (e.g., https://status.openai.com or https://status.anthropic.com).
2. If the rate limit is a soft cap (HTTP 429 with `Retry-After`), wait and then replay DLQ jobs.
3. If the tenant is consistently hitting rate limits, increase their quota tier with the LLM provider or reduce `historyWindow` to shorten context.

### Recovery steps (credential error)

1. Obtain the correct API key from the tenant.
2. Update the bot credential: `PUT /admin/bots/:id` with the new `llmApiKey`.
3. The bot status is automatically reset to `active` on the next successful LLM call via the bot cache invalidation. Confirm by checking `GET /admin/bots/:id` and verifying `status: "active"`.
4. Replay any DLQ jobs for that bot's `phoneId`.

---

## Safety service (SafetyClassifier) down or degraded

### Behavior by design

The safety classifier is designed to **fail open** (not fail closed) on LLM-tier errors:

- **Keyword tier** (synchronous, no network): always runs. Cannot fail due to network issues.
- **LLM tier** (`SAFETY_PROVIDER_API_KEY`): if the Anthropic API call fails (network error, timeout, malformed response), the classifier returns the keyword-tier result rather than blocking the message. This is intentional — a classifier outage should not silence all bots.

There is no `SAFETY_FAIL_CLOSED` flag in the current implementation. The fail-open behavior is hardcoded for the LLM tier.

### Symptoms

- Errors from the Anthropic safety API (`claude-haiku`) are silently swallowed at the classifier level (not surfaced to Sentry or alerts). They will appear in pino logs at `warn` level if the classifier call throws.
- No change in end-user behavior during safety LLM outages, provided keyword patterns are up to date.

### Actions

1. If `SAFETY_PROVIDER_API_KEY` is invalid or expired, update it in the environment. The `SafetyClassifier` lazily builds its Anthropic client and will pick up the new key on the next request after a process restart. Call `safetyClassifier.resetClient()` programmatically if a hot reload path is available.
2. If you suspect the keyword tier is insufficient for active threats, temporarily set `safetyLevel: 'minimal'` on affected bots (keyword-only, no LLM escalation) to reduce noise, or `safetyLevel: 'strict'` to force LLM classification on every message.
3. Monitor platform Sentry for unexpected crisis events that may indicate the classifier is under-detecting.
