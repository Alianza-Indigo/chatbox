# Runbook: DLQ Inspection and Replay

## What is the DLQ?

The Dead-Letter Queue (DLQ) is a separate BullMQ queue (`chatbox-dlq`) that holds inbound message jobs that exhausted all retry attempts on the main processing queue. A job lands in the DLQ when:

- It failed on every attempt (default: 3 attempts with exponential backoff starting at 2 s).
- The failure was not a transient lock-contention issue — lock retries are handled separately with up to 5 reschedules before the job is dropped.

When a job moves to the DLQ, two things happen automatically:
1. A `dlq_job_added` alert is sent to `WEBHOOK_ALERT_URL` (see Alerting section below).
2. Platform Sentry captures the final exception with the `phoneId` and `jobId` as tags.
3. If the phone number maps to a known bot, the exception is also sent to that tenant's Sentry.

PII is safe in the DLQ: the `from` (end-user phone) and `textBody` fields remain encrypted throughout.

---

## Required permissions

All DLQ endpoints require a superadmin JWT or the `x-admin-key: $ADMIN_API_KEY` header.

---

## Step 1: Check DLQ depth

Get a count before deciding whether to investigate.

```
GET /admin/dlq/count
```

Response:
```json
{ "count": 7 }
```

A non-zero count does not always require immediate action. Cross-reference with the Prometheus `dlq_depth` gauge and the Sentry error timeline before proceeding.

---

## Step 2: List jobs

Retrieve the newest 100 jobs. PII fields are not returned — only metadata.

```
GET /admin/dlq
```

Response shape per job:
```json
{
  "id": "dlq-abc123",
  "name": "failed-message",
  "data": {
    "phoneId": "1234567890",
    "waMessageId": "wamid.xxx",
    "messageType": "text",
    "timestamp": 1749400000000
  },
  "failedReason": "LLMCredentialError: 401 Unauthorized",
  "attemptsMade": 3,
  "addedAt": "2026-06-09T10:23:00.000Z"
}
```

**Triage checklist:**
- `failedReason` ending in `LLMCredentialError` — the bot's API key is bad. Fix the credential first (update the bot via `PUT /admin/bots/:id`), then replay.
- `failedReason` ending in `LLMRateLimitError` — the tenant is rate-limited by their LLM provider. Wait before replaying.
- `failedReason` with `ECONNREFUSED` or `ETIMEDOUT` — transient network issue. Replay immediately.
- Multiple jobs sharing the same `phoneId` — check whether the bot is in `credential_error` status before replaying in bulk.

---

## Step 3: Replay a single job

Re-enqueues the job onto the main processing queue with 3 fresh attempts (exponential backoff, 2 s base), then removes it from the DLQ.

```
POST /admin/dlq/:jobId/retry
```

Response:
```json
{ "requeued": true, "jobId": "dlq-abc123" }
```

The re-enqueued job will be processed by the next available worker. The encrypted PII payload is carried over as-is — no re-encryption needed.

**Note:** If the root cause has not been resolved (e.g., the bot credential is still invalid), the job will fail again and a new DLQ entry will be created.

---

## Step 4: Discard a single job

Permanently removes a job from the DLQ without replaying it. Use when the message is no longer relevant (e.g., the conversation is stale, the end user already received a response through another channel).

```
DELETE /admin/dlq/:jobId
```

Response: `204 No Content`

---

## Step 5: Bulk purge old jobs

Two options:

**Purge jobs older than N hours** (recommended — surgical):
```
DELETE /admin/dlq?olderThanHours=72
```

**Drain everything** (use with caution — irreversible):
```
DELETE /admin/dlq
```

Response:
```json
{ "removed": 42, "olderThanHours": 72 }
```

When to bulk purge:
- After an extended outage where messages are too old to be useful (e.g., older than 24–48 h for most chat use cases).
- After fixing a systemic issue (e.g., all jobs failed because of a bad deploy) and replaying the recent ones manually.

---

## Alerting: what WEBHOOK_ALERT_URL sends

When a job is moved to the DLQ, the platform posts the following JSON payload to `WEBHOOK_ALERT_URL` within the same job `failed` event handler:

```json
{
  "event": "dlq_job_added",
  "jobId": "abc123",
  "phoneId": "1234567890",
  "timestamp": "2026-06-09T10:23:00.000Z"
}
```

`phoneId` is the Meta phone number ID (the business number), not the end-user's phone. No message content or user PII is included.

If `WEBHOOK_ALERT_URL` is not set, the payload is still logged at `error` level via pino — check Railway/platform logs for `alert:dlq_job_added`.

---

## When to retry vs. escalate

| Scenario | Action |
|---|---|
| Transient network error to Meta or LLM | Retry immediately |
| LLM rate limit (`LLMRateLimitError`) | Wait 10–30 min, then retry |
| Bad LLM credential (`LLMCredentialError`) | Fix credential, verify bot status is `active`, then retry |
| DB connection error during processing | Verify DB is healthy (`GET /health`), then retry |
| Job fails again after retry | Check platform Sentry and tenant Sentry for root cause; escalate if persistent |
| More than ~50 jobs in DLQ unexpectedly | Likely a systemic issue — check recent deploy, LLM provider status page, and Meta API status before replaying |
| Stale messages (> 24 h old) | Purge rather than replay unless the tenant specifically requests recovery |
