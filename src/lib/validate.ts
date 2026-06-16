import { z } from 'zod';
import { REGISTERED_PROVIDERS } from '../providers/llm';

/**
 * Parse and validate a request body against a Zod schema.
 * Throws a 400-statusCode error on failure — caught by Fastify's setErrorHandler.
 */
export function parseBody<T>(schema: z.ZodSchema<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    throw Object.assign(
      new Error(result.error.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')),
      { statusCode: 400, validationDetails: result.error.flatten() },
    );
  }
  return result.data;
}

// ── Auth ──────────────────────────────────────────────────────────────────

export const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  orgName: z.string().min(1),
});

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// ── Bots ──────────────────────────────────────────────────────────────────

const BrandingSchema = z.object({
  companyName: z.string().optional(),
  logoUrl: z.string().url().optional(),
  primaryColor: z.string().optional(),
  website: z.string().optional(),
  supportContact: z.string().optional(),
  privacyPolicyUrl: z.string().url().optional(),
  termsUrl: z.string().url().optional(),
});

// Microsaas-mode config carried inside Bot.identity.membership. Optional fields
// fall back to service defaults; only validated for shape when present.
export const MembershipConfigSchema = z.object({
  enabled: z.boolean(),
  freeMessages: z.number().int().min(0).optional(),
  durationDays: z.number().int().min(1).optional(),
  price: z.number().min(0).optional(),
  currency: z.string().min(3).max(3).optional(),
  title: z.string().min(1).max(120).optional(),
  paywallMessage: z.string().max(1000).optional(),
});

// identity is a free-form config bag, but validate identity.membership when set.
const IdentitySchema = z.record(z.unknown()).superRefine((val, ctx) => {
  if (val.membership !== undefined) {
    const res = MembershipConfigSchema.safeParse(val.membership);
    if (!res.success) {
      for (const issue of res.error.issues) {
        ctx.addIssue({ ...issue, path: ['membership', ...issue.path] });
      }
    }
  }
});

export const CreateBotSchema = z.object({
  orgId: z.string().uuid().optional(),
  name: z.string().min(1),
  locale: z.string().optional(),
  systemPrompt: z.string().optional(),
  identity: IdentitySchema.optional(),
  onboardingMsg: z.string().optional(),
  historyWindow: z.number().int().min(1).max(50).optional(),
  llmProvider: z.enum(REGISTERED_PROVIDERS).optional(),
  llmModel: z.string().optional(),
  llmApiKey: z.string().optional(),
  llmParams: z.record(z.unknown()).optional(),
  safetyLevel: z.enum(['strict', 'standard', 'minimal']).optional(),
  branding: BrandingSchema.optional(),
});

export const UpdateBotSchema = z.object({
  name: z.string().min(1).optional(),
  locale: z.string().optional(),
  status: z.enum(['draft', 'active', 'paused', 'credential_error']).optional(),
  identity: IdentitySchema.optional(),
  onboardingMsg: z.string().optional(),
  historyWindow: z.number().int().min(1).max(50).optional(),
  llmProvider: z.enum(REGISTERED_PROVIDERS).optional(),
  llmModel: z.string().optional(),
  llmApiKey: z.string().optional(),
  llmParams: z.record(z.unknown()).optional(),
  safetyLevel: z.enum(['strict', 'standard', 'minimal']).optional(),
});

export const PromptSchema = z.object({
  systemPrompt: z.string().min(1),
});

export { BrandingSchema };

export const CommandSchema = z.object({
  trigger: z.string().min(1),
  responseType: z.enum(['static', 'action']),
  payload: z.record(z.unknown()),
});

export const CrisisConfigSchema = z.object({
  configs: z.array(z.object({
    country: z.string().min(1),
    lines: z.array(z.object({
      name: z.string().min(1),
      phone: z.string().min(1),
      hours: z.string().optional(),
    })),
    enabled: z.boolean().optional(),
  })).min(1),
});

// ── Channels ──────────────────────────────────────────────────────────────

export const CreateChannelSchema = z.object({
  provider: z.string().min(1),
  phoneId: z.string().min(1),
  accessToken: z.string().min(1),
  businessAccountId: z.string().optional(),
  verifyToken: z.string().min(1),
});

export const UpdateChannelSchema = z.object({
  status: z.enum(['connected', 'pending', 'error']).optional(),
  verifyToken: z.string().min(1).optional(),
  accessToken: z.string().min(1).optional(),
  businessAccountId: z.string().optional(),
});

export const EmbeddedSignupSchema = z.object({
  code: z.string().min(1),
  phoneId: z.string().min(1),
  verifyToken: z.string().min(1),
  redirectUri: z.string().url().optional(),
});

// ── Integrations ──────────────────────────────────────────────────────────

export const CreateIntegrationSchema = z.object({
  kind: z.string().min(1),
  provider: z.string().min(1),
  apiKey: z.string().min(1),
}).passthrough();

export const UpdateIntegrationSchema = z.object({
  status: z.enum(['active', 'inactive']).optional(),
  apiKey: z.string().min(1).optional(),
});

// ── Organizations ─────────────────────────────────────────────────────────

export const CreateOrgSchema = z.object({
  name: z.string().min(1),
  plan: z.enum(['free', 'pro', 'enterprise']).optional(),
  msgQuota: z.number().int().min(0).optional(),
  sentryDsn: z.string().url().optional(), // tenant's own Sentry DSN — stored encrypted
});

export const UpdateOrgSchema = z.object({
  name: z.string().min(1).optional(),
  plan: z.enum(['free', 'pro', 'enterprise']).optional(),
  msgQuota: z.number().int().min(0).optional(),
  sentryDsn: z.string().url().optional().nullable(), // null = clear the DSN
});

export const InviteMemberSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  role: z.enum(['owner', 'admin', 'editor']).optional(),
});

export const UpdateMemberRoleSchema = z.object({
  role: z.enum(['owner', 'admin', 'editor']),
});

// ── Knowledge ─────────────────────────────────────────────────────────────

export const KnowledgeSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(50_000), // ~50 KB limit prevents OOM attacks
  tags: z.array(z.string().max(50)).max(20).optional(),
});

export const UpdateKnowledgeSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  content: z.string().min(1).max(50_000).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
});

// ── Users ─────────────────────────────────────────────────────────────────

export const PatchUserSchema = z.object({
  paused: z.boolean(),
});

// ── Proactive ─────────────────────────────────────────────────────────────

export const ProactiveSchema = z.object({
  to: z.string().min(1),
  templateName: z.string().min(1),
  languageCode: z.string().min(2),
  components: z.array(z.unknown()).optional(),
  channelId: z.string().uuid().optional(),
});
