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
  JWT_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().default('chatbox-api'),
  JWT_AUDIENCE: z.string().default('chatbox-clients'),
  META_APP_ID: z.string().optional(), // required only for Embedded Signup
  POLICY_VERSION: z.string().default('1.0'),
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Optional: receives structured JSON alerts (Slack/Make.com/Zapier incoming webhook URL)
  WEBHOOK_ALERT_URL: z.string().url().optional(),
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
