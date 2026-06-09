# Runbook: Encryption Key Rotation

## When to rotate keys

Rotate encryption keys when:

- A key may have been exposed (e.g., accidental commit, leaked environment variable, compromised infrastructure).
- Your security policy requires periodic rotation (e.g., annually).
- You are migrating from the legacy single-key (`FIELD_ENCRYPTION_KEY`) setup to the versioned multi-key system.

Key rotation is zero-downtime: during the migration window, old ciphertext is decryptable with the old key and new writes use the new key. The re-encryption jobs run in the background without service interruption.

---

## How the key system works

The platform uses AES-256-GCM. Each encrypted blob stores a Key ID (KID) in a two-byte magic-prefixed header:

```
MAGIC(2) + KID(1) + IV(12) + TAG(16) + CIPHERTEXT
```

Legacy blobs (created before the versioned format was introduced) have no magic prefix and are always decrypted with KID 0.

Two environment variables control the key material:

- `ENCRYPTION_KEYS` — JSON map of KID (integer 0–255) to base64-encoded 32-byte key, e.g. `{"0":"<base64>","1":"<base64>"}`. Overrides the legacy `FIELD_ENCRYPTION_KEY` variable for KID 0 if both are set.
- `ENCRYPTION_CURRENT_KID` — integer (default `0`). All new encryptions use this KID. Old KIDs remain readable as long as their key is present in `ENCRYPTION_KEYS`.

---

## Step 1: Generate a new key

Generate a cryptographically random 32-byte key and base64-encode it:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Note the output; this is your new key value. Assign it a new KID (one higher than your current maximum, e.g., if you have KID `0`, use KID `1`).

---

## Step 2: Add the new key to ENCRYPTION_KEYS

Update the `ENCRYPTION_KEYS` environment variable to include both the old key and the new key. **Do not remove the old key yet** — existing ciphertext still needs it.

Example: rotating from KID 0 to KID 1:

```
ENCRYPTION_KEYS={"0":"<existing-base64-key>","1":"<new-base64-key>"}
```

Do not change `ENCRYPTION_CURRENT_KID` yet. This step just makes the new key available.

---

## Step 3: Set ENCRYPTION_CURRENT_KID to the new KID

```
ENCRYPTION_CURRENT_KID=1
```

From this point, all new encryptions use KID 1. Existing blobs with KID 0 are still readable.

---

## Step 4: Deploy

Deploy both the API service and the Worker service with the updated environment variables. The `releaseCommand` (`node dist/migrate.js`) runs before the new API comes up — no schema changes are needed for key rotation.

Verify the deployment succeeded:
```
GET /health
```

Expected response: `{ "status": "ok", "db": true, "redis": true }`

---

## Step 5: Re-encrypt credentials and org secrets

This endpoint re-encrypts bot LLM API keys, channel credentials, integration credentials, and org Sentry DSNs. Blobs already on the current KID are skipped (idempotent).

```
POST /admin/crypto/reencrypt
Authorization: x-admin-key: $ADMIN_API_KEY
```

Response:
```json
{
  "currentKid": 1,
  "reencrypted": 47,
  "skipped": 0,
  "failed": 0
}
```

If `failed > 0`, check platform Sentry for details. The endpoint can be called again safely — it will skip blobs already migrated.

---

## Step 6: Re-encrypt message bodies (paginated)

`Message.bodyEnc` is excluded from Step 5 because large installations may have millions of rows. Use the cursor-based paginated endpoint instead. Call it in a loop until `done: true`.

```
POST /admin/crypto/reencrypt-messages
Authorization: x-admin-key: $ADMIN_API_KEY
Content-Type: application/json

{ "batchSize": 200 }
```

Response:
```json
{
  "currentKid": 1,
  "reencrypted": 200,
  "skipped": 0,
  "failed": 0,
  "nextCursor": "cma7xyz...",
  "done": false
}
```

Pass `nextCursor` in the next request body. Repeat until `done: true`:

```json
{ "batchSize": 200, "cursor": "cma7xyz..." }
```

Tips:
- Default `batchSize` is 100; maximum is 500. Larger batches are faster but put more load on the DB.
- The endpoint processes rows in ascending `id` order — safe to pause and resume at any time.
- If `failed > 0` in any batch, the problematic row is logged and skipped. The cursor still advances. Re-run from the same cursor to retry failed rows (the skipped rows will fail again until the underlying issue is resolved).

Example shell loop (with `jq` and `curl`):
```bash
CURSOR=""
while true; do
  BODY=$([ -z "$CURSOR" ] && echo '{"batchSize":200}' || echo "{\"batchSize\":200,\"cursor\":\"$CURSOR\"}")
  RESP=$(curl -s -X POST https://your-api/admin/crypto/reencrypt-messages \
    -H "x-admin-key: $ADMIN_API_KEY" \
    -H "content-type: application/json" \
    -d "$BODY")
  echo "$RESP"
  DONE=$(echo "$RESP" | jq -r '.done')
  [ "$DONE" = "true" ] && break
  CURSOR=$(echo "$RESP" | jq -r '.nextCursor')
done
```

---

## Step 7: Remove the old key (optional)

Once all blobs have been migrated to the new KID, you can remove the old key from `ENCRYPTION_KEYS` to prevent any future use:

```
ENCRYPTION_KEYS={"1":"<new-base64-key>"}
```

**Before removing the old key:**
- Confirm the re-encryption jobs in Steps 5 and 6 completed with `failed: 0`.
- Keep the old key in a secure vault for at least 30 days as a recovery backstop.
- Do not remove KID 0 if any legacy-format blobs (created before the versioned format) exist — these always use KID 0 for decryption.

Deploy the updated `ENCRYPTION_KEYS`. The system will throw at startup if any encrypted blob references a KID that has no configured key.
