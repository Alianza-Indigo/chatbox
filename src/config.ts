import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  FIELD_ENCRYPTION_KEY: z.string().min(1),
  // HMAC-SHA256 pepper for phone hashes — required in production to prevent
  // dictionary attacks against the low-entropy phone number space.
  PHONE_HASH_SECRET: z.string().min(32).optional(),
  SAFETY_PROVIDER_API_KEY: z.string().optional(),
  META_APP_SECRET: z.string().min(1),
  META_API_VERSION: z.string().default('v21.0'),
  WEBHOOK_VERIFY_TOKEN: z.string().min(1),
  // Minimum 32 chars to prevent weak key attacks
  ADMIN_API_KEY: z.string().min(32),
  // Comma-separated email allowlist that should receive platform superadmin access
  // on normal JWT login, without changing the org-level DB role.
  SUPERADMIN_EMAILS: z.string().optional().transform((value) => {
    if (!value) return [];
    return Array.from(new Set(
      value
        .split(',')
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    ));
  }),
  JWT_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().default('chatbox-api'),
  JWT_AUDIENCE: z.string().default('chatbox-clients'),
  META_APP_ID: z.string().optional(), // required only for Embedded Signup
  POLICY_VERSION: z.string().default('1.0'),
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Optional: receives structured JSON alerts (Slack/Make.com/Zapier incoming webhook URL)
  WEBHOOK_ALERT_URL: z.string().url().optional(),
  // Sentry DSN for error tracking — omit to disable (e.g. in local dev)
  SENTRY_DSN: z.string().url().optional(),
  // Multi-key envelope encryption: JSON map of kid→base64-encoded 32-byte key
  // e.g. '{"0":"<base64>","1":"<base64>"}'. Use ENCRYPTION_CURRENT_KID to select
  // the active key for new encryptions. Falls back to FIELD_ENCRYPTION_KEY (kid 0).
  ENCRYPTION_KEYS: z.string().optional(),
  ENCRYPTION_CURRENT_KID: z.coerce.number().int().min(0).default(0),
  // Safety fail-closed: when 'true', bots with safetyLevel='strict' block the message
  // if the LLM safety classifier is unavailable, instead of falling back to keyword-only.
  SAFETY_FAIL_CLOSED: z.string().optional().transform(v => v?.toLowerCase() === 'true'),
  // Meta webhook replay-protection window in seconds (0 = disabled).
  // Messages with a timestamp older than this are logged as stale and skipped.
  WEBHOOK_REPLAY_WINDOW_SECS: z.coerce.number().int().min(0).default(300),
  // Public base URL of the API (e.g. https://api.example.com). Required for
  // microsaas mode: it builds the payment-provider notification_url so memberships
  // activate automatically. Omit to disable automatic activation (manual reconcile).
  PUBLIC_BASE_URL: z.string().url().optional(),
});

function loadConfig() {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new Error(`Missing or invalid environment variables: ${missing}`);
  }
  const cfg = result.data;
  if (cfg.NODE_ENV === 'production' && !cfg.PHONE_HASH_SECRET) {
    throw new Error('PHONE_HASH_SECRET is required in production (prevents phone number dictionary attacks)');
  }
  return cfg;
}

export const config = loadConfig();
