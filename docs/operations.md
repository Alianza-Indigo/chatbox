# Operations Guide

## Environment variables

### Required

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (`postgresql://user:pass@host:5432/db`) |
| `REDIS_URL` | Redis connection string (`redis://host:6379`) |
| `FIELD_ENCRYPTION_KEY` | Base64-encoded 32-byte AES-256 key (legacy KID 0). Required if `ENCRYPTION_KEYS` does not provide a KID 0 entry. |
| `META_APP_SECRET` | WhatsApp App Secret from Meta Developer Console. Used to verify HMAC-SHA256 webhook signatures. |
| `WEBHOOK_VERIFY_TOKEN` | Arbitrary string configured in the Meta webhook settings. Must match what Meta sends on `GET /webhook/whatsapp/:phoneId`. |
| `ADMIN_API_KEY` | Minimum 32 characters. Used as the superadmin bypass token (`x-admin-key` header) and to protect `/docs` and `/metrics`. |
| `JWT_SECRET` | Minimum 32 characters. Signs and verifies org user JWTs. |
| `NODE_ENV` | `production`, `development`, or `test`. Production enforces `PHONE_HASH_SECRET`. |
| `PHONE_HASH_SECRET` | Minimum 32 characters. HMAC-SHA256 pepper for end-user phone hashes. **Required in `NODE_ENV=production`** to prevent dictionary attacks on the low-entropy phone number space. |

### Optional

| Variable | Default | Description |
|---|---|---|
| `ENCRYPTION_KEYS` | — | JSON map of KID → base64 key for multi-key rotation support: `{"0":"<b64>","1":"<b64>"}`. Overrides `FIELD_ENCRYPTION_KEY` for KID 0 when present. |
| `ENCRYPTION_CURRENT_KID` | `0` | Integer (0–255). New encryptions use this KID. All listed KIDs in `ENCRYPTION_KEYS` remain readable. |
| `SAFETY_PROVIDER_API_KEY` | — | Anthropic API key used by the platform-level safety classifier's LLM tier. If unset, classifier runs in keyword-only mode. |
| `SENTRY_DSN` | — | Platform Sentry DSN for infrastructure errors (5xx, exhausted jobs). Omit to disable. |
| `WEBHOOK_ALERT_URL` | — | HTTP endpoint for structured JSON alerts (Slack incoming webhook, Make.com, Zapier). Receives `dlq_job_added`, `credential_error`, `llm_failure` events. |
| `META_APP_ID` | — | Meta App ID. Required only if using the Embedded Signup flow for channel onboarding. |
| `META_API_VERSION` | `v21.0` | Meta Graph API version used for all WhatsApp Cloud API calls. |
| `JWT_ISSUER` | `chatbox-api` | JWT `iss` claim. |
| `JWT_AUDIENCE` | `chatbox-clients` | JWT `aud` claim. |
| `POLICY_VERSION` | `1.0` | Consent policy version embedded in onboarding messages. |
| `PORT` | `3000` | HTTP port for the Fastify server. |

---

## Railway deployment

### Architecture

Two Railway services share the same repository and the same `DATABASE_URL` / `REDIS_URL`:

1. **API service** — runs the Fastify HTTP server (`npm run start` → `node dist/server.js`). Handles webhook ingestion, admin CRUD, health, and metrics.
2. **Worker service** — runs the BullMQ consumer (`node dist/worker.js`). Processes inbound messages, calls LLMs, sends WhatsApp replies.

### API service setup

The `railway.toml` in the repo root configures this service automatically:

```toml
[build]
builder = "nixpacks"
buildCommand = "npm ci && npx prisma generate && npm run build"

[deploy]
releaseCommand = "node dist/migrate.js"
startCommand = "npm run start"
healthcheckPath = "/health"
healthcheckTimeout = 30
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 3
```

Set all required environment variables in the Railway service settings. Railway injects `DATABASE_URL` and `REDIS_URL` automatically if you attach the matching Railway plugins to the service.

### Worker service setup

1. In the Railway project, click **Add Service → GitHub Repo** and select the same repository.
2. In the service settings, override the start command: `node dist/worker.js`.
3. Remove the healthcheck path — the worker has no HTTP port.
4. Attach the same Railway PostgreSQL and Redis plugins (or share the environment variables manually).
5. Set all required environment variables (same set as the API service, minus `PORT`).

The worker does not serve HTTP traffic and does not need a public domain.

---

## How migrations work

Prisma migrations are applied automatically before each API deployment via Railway's `releaseCommand`:

```
node dist/migrate.js
```

This runs `prisma migrate deploy` against `DATABASE_URL`. Railway executes the release command between the build finishing and the new deployment going live, ensuring the schema is in sync before traffic is routed to the new version.

To run migrations manually (e.g., against a local or staging DB):
```bash
npx prisma migrate deploy
```

To create a new migration during development:
```bash
npx prisma migrate dev --name describe-your-change
```

Never run `prisma migrate dev` against a production database.

---

## Monitoring

### Health endpoint

```
GET /health
```

Checks both PostgreSQL (`SELECT 1`) and Redis (`PING`) connectivity. Returns HTTP 200 when healthy:

```json
{ "status": "ok", "db": true, "redis": true, "ts": 1749400000000 }
```

Returns HTTP 503 with `"status": "degraded"` if either dependency is unreachable. Railway uses this endpoint for readiness checks (`healthcheckPath = "/health"`).

### Prometheus metrics

```
GET /metrics
Header: x-admin-key: $ADMIN_API_KEY
```

Returns a Prometheus text exposition (content-type `text/plain; version=0.0.4`). Use an isolated registry — no global `prom-client` state is shared.

Key metrics exported:

| Metric | Type | Description |
|---|---|---|
| `llm_request_duration_seconds` | Histogram | End-to-end LLM call duration |
| `llm_tokens_total` | Counter | Tokens consumed (labeled by `direction`: input/output) |
| `llm_cost_usd_total` | Counter | Estimated cost per LLM call |
| `llm_errors_total` | Counter | LLM call errors (labeled by `errorType`) |
| `meta_errors_total` | Counter | WhatsApp send errors |
| `quota_blocks_total` | Counter | Messages blocked by monthly quota |
| `safety_blocks_total` | Counter | Messages blocked by safety classifier |
| `dlq_depth` | Gauge | Current number of jobs in the DLQ |
| `messages_processed_total` | Counter | Successfully sent outbound messages |

For production Prometheus scraping, add network-level access restrictions in addition to the `x-admin-key` header check. The header check alone is not sufficient if the `/metrics` path is publicly routable.

### Sentry

Two independent Sentry instances operate in parallel:

- **Platform Sentry** (`SENTRY_DSN`): captures infrastructure errors (5xx HTTP responses, exhausted BullMQ jobs, unhandled worker exceptions). Set once at the platform level.
- **Tenant Sentry** (`Organization.sentryDsnEnc`): each organization can configure their own Sentry DSN via `PUT /admin/organizations/:id` with a `sentryDsn` body field. The DSN is stored encrypted. Tenant exceptions (bot errors, credential failures) are routed to the correct tenant DSN automatically.

### API documentation

```
GET /docs
Header: x-admin-key: $ADMIN_API_KEY
```

Serves the Swagger UI (static OpenAPI 3.0 spec from `src/openapi.ts`).

---

## Adding a new tenant

### Step 1: Create an organization

```
POST /admin/organizations
Content-Type: application/json
x-admin-key: $ADMIN_API_KEY

{
  "name": "Acme Corp",
  "plan": "pro",
  "msgQuota": 5000,
  "sentryDsn": "https://xxx@sentry.io/yyy"  // optional
}
```

Note the returned `id` — this is the `orgId` used in subsequent steps.

### Step 2: Create a user for the organization

```
POST /admin/organizations/:orgId/members
Content-Type: application/json
x-admin-key: $ADMIN_API_KEY

{
  "email": "admin@acme.com",
  "password": "securepassword",
  "role": "owner"
}
```

### Step 3: Create a bot

```
POST /admin/bots
Content-Type: application/json
Authorization: Bearer <org-user-jwt>

{
  "name": "Acme Support Bot",
  "llmProvider": "openai",
  "llmModel": "gpt-4o",
  "llmApiKey": "<tenant-openai-key>",
  "systemPrompt": "You are a helpful support agent for Acme Corp.",
  "safetyLevel": "standard",
  "locale": "es",
  "historyWindow": 10
}
```

Note the returned `id` — this is the `botId`.

### Step 4: Configure a WhatsApp channel

Obtain the Meta Cloud API credentials from the tenant's Meta Developer Console: `phoneNumberId`, `accessToken`, and `wabaId`.

```
POST /admin/channels
Content-Type: application/json
Authorization: Bearer <org-user-jwt>

{
  "botId": "<botId>",
  "provider": "meta_cloud",
  "phoneId": "<meta-phone-number-id>",
  "credentials": {
    "accessToken": "<permanent-access-token>",
    "wabaId": "<whatsapp-business-account-id>",
    "phoneNumberId": "<phone-number-id>"
  }
}
```

### Step 5: Configure the Meta webhook

In the Meta Developer Console, set the webhook URL to:

```
https://your-api-domain/webhook/whatsapp/<phoneNumberId>
```

Set the verify token to the value of `WEBHOOK_VERIFY_TOKEN`. Subscribe to the `messages` field.

### Step 6: Verify

Send a test WhatsApp message to the business number. Check:
- `GET /health` returns `ok`.
- Platform logs show the job being enqueued and processed.
- The bot replies via WhatsApp.

---

## Quota management

Each organization has a `msgQuota` field (integer, monthly limit) and a `msgUsed` counter that resets atomically at the start of each calendar month.

- `msgQuota = 0` means **unlimited** — the counter is incremented but never checked against a cap.
- When a message would exceed the quota, the end user receives a Spanish-language message: "El servicio ha alcanzado su límite mensual de mensajes. Contacta al administrador." The job is not retried.
- Quota blocks are tracked in the `quota_blocks_total` Prometheus counter.

To update a quota (superadmin only):

```
PUT /admin/organizations/:id
x-admin-key: $ADMIN_API_KEY

{ "msgQuota": 10000 }
```

To check current usage, read the `msgUsed` and `currentPeriodStart` fields from `GET /admin/organizations/:id`.

---

## Backup guidance

### PostgreSQL

Use `pg_dump` for logical backups:

```bash
pg_dump $DATABASE_URL --format=custom --file=chatbox_$(date +%Y%m%d_%H%M%S).dump
```

For Railway Postgres, enable automated backups in the Railway dashboard (available on paid plans). Store backups off-platform (e.g., S3, GCS) for disaster recovery.

Restore:
```bash
pg_restore --dbname=$DATABASE_URL --clean chatbox_<timestamp>.dump
```

After restore, verify the schema version matches the codebase:
```bash
npx prisma migrate status
```

### Redis

Redis is used for:
1. BullMQ job queues (transient — jobs are replayed from the DLQ or retried by Meta).
2. Conversation mutex locks (short TTL, 90 s — will auto-expire on recovery).
3. Pub/sub (stateless).

Redis data loss after a restart is generally acceptable: in-flight jobs are re-delivered by BullMQ's worker acknowledgement mechanism, and conversation locks expire within 90 seconds. However, if you want durability:

- Enable **RDB snapshots** (`save 900 1 300 10 60 10000`) in your Redis config for point-in-time recovery.
- Enable **AOF persistence** (`appendonly yes`) for near-zero data loss.

For Railway Redis, persistence settings are managed in the Railway dashboard under the Redis service configuration.
