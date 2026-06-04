import type { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@prisma/client';
import { db } from '../../db';
import { encrypt } from '../../crypto';
import { invalidateBotCache } from '../../services/bot.service';

const botRoutes: FastifyPluginAsync = async (fastify) => {
  // Org isolation for /:id sub-routes (params.id, not params.botId caught by parent)
  fastify.addHook('preHandler', async (req, reply) => {
    if (!req.user || req.user.isSuperadmin) return;
    const params = req.params as Record<string, string>;
    const botId = params.id;
    if (!botId) return;
    const bot = await db.bot.findUnique({ where: { id: botId }, select: { orgId: true } });
    if (!bot || bot.orgId !== req.user.orgId) return reply.status(403).send({ error: 'Forbidden' });
  });

  // List bots — scoped to the requesting org
  fastify.get('/', async (req, reply) => {
    const orgFilter = req.user!.isSuperadmin ? {} : { orgId: req.user!.orgId };
    const bots = await db.bot.findMany({
      where: orgFilter,
      include: { branding: true, channels: { select: { id: true, phoneId: true, status: true, provider: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return reply.send(bots.map(sanitizeBot));
  });

  // Get single bot
  fastify.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const bot = await db.bot.findUnique({
      where: { id: req.params.id },
      include: { branding: true, commands: true, crisisConfig: true, channels: { select: { id: true, phoneId: true, status: true, provider: true } }, knowledge: true, promptVersions: { orderBy: { version: 'desc' }, take: 10 } },
    });
    if (!bot) return reply.status(404).send({ error: 'Bot not found' });
    if (!req.user!.isSuperadmin && bot.orgId !== req.user!.orgId) return reply.status(403).send({ error: 'Forbidden' });
    return reply.send(sanitizeBot(bot));
  });

  // Create bot — orgId defaults to caller's org
  fastify.post<{ Body: CreateBotBody }>('/', async (req, reply) => {
    const body = req.body;
    const orgId = req.user!.isSuperadmin ? (body.orgId ?? req.user!.orgId) : req.user!.orgId;

    const bot = await db.bot.create({
      data: {
        orgId,
        name: body.name,
        locale: body.locale ?? 'es-MX',
        systemPrompt: body.systemPrompt,
        identity: body.identity as Prisma.InputJsonValue,
        onboardingMsg: body.onboardingMsg,
        historyWindow: body.historyWindow ?? 5,
        llmProvider: body.llmProvider,
        llmModel: body.llmModel,
        llmApiKeyEnc: body.llmApiKey ? encrypt(body.llmApiKey) : undefined,
        llmParams: body.llmParams as Prisma.InputJsonValue,
        branding: body.branding ? { create: body.branding } : undefined,
      },
    });

    if (body.systemPrompt) {
      await db.botPromptVersion.create({ data: { botId: bot.id, version: 1, systemPrompt: body.systemPrompt } });
    }

    return reply.status(201).send(sanitizeBot(bot));
  });

  // Update bot
  fastify.put<{ Params: { id: string }; Body: UpdateBotBody }>('/:id', async (req, reply) => {
    const { id } = req.params;
    const body = req.body;

    const existing = await db.bot.findUnique({ where: { id } });
    if (!existing) return reply.status(404).send({ error: 'Bot not found' });
    if (!req.user!.isSuperadmin && existing.orgId !== req.user!.orgId) return reply.status(403).send({ error: 'Forbidden' });

    const data: Record<string, unknown> = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.locale !== undefined) data.locale = body.locale;
    if (body.identity !== undefined) data.identity = body.identity;
    if (body.onboardingMsg !== undefined) data.onboardingMsg = body.onboardingMsg;
    if (body.historyWindow !== undefined) data.historyWindow = body.historyWindow;
    if (body.llmProvider !== undefined) data.llmProvider = body.llmProvider;
    if (body.llmModel !== undefined) data.llmModel = body.llmModel;
    if (body.llmApiKey !== undefined) data.llmApiKeyEnc = encrypt(body.llmApiKey);
    if (body.llmParams !== undefined) data.llmParams = body.llmParams;
    if (body.status !== undefined) data.status = body.status;

    const bot = await db.bot.update({ where: { id }, data });
    invalidateBotCache(id);
    return reply.send(sanitizeBot(bot));
  });

  // Delete bot
  fastify.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const { id } = req.params;
    const existing = await db.bot.findUnique({ where: { id }, select: { orgId: true } });
    if (!existing) return reply.status(404).send({ error: 'Bot not found' });
    if (!req.user!.isSuperadmin && existing.orgId !== req.user!.orgId) return reply.status(403).send({ error: 'Forbidden' });
    await db.bot.delete({ where: { id } });
    invalidateBotCache(id);
    return reply.status(204).send();
  });

  // Update system_prompt (creates a new version)
  fastify.post<{ Params: { id: string }; Body: { systemPrompt: string } }>('/:id/prompt', async (req, reply) => {
    const { id } = req.params;
    const { systemPrompt } = req.body;
    const createdBy = req.user!.userId;

    const latest = await db.botPromptVersion.findFirst({ where: { botId: id }, orderBy: { version: 'desc' } });
    const nextVersion = (latest?.version ?? 0) + 1;

    await db.$transaction([
      db.bot.update({ where: { id }, data: { systemPrompt } }),
      db.botPromptVersion.create({ data: { botId: id, version: nextVersion, systemPrompt, createdBy } }),
    ]);

    invalidateBotCache(id);
    return reply.send({ version: nextVersion });
  });

  // List prompt versions
  fastify.get<{ Params: { id: string } }>('/:id/prompts', async (req, reply) => {
    const versions = await db.botPromptVersion.findMany({
      where: { botId: req.params.id },
      orderBy: { version: 'desc' },
    });
    return reply.send(versions);
  });

  // Rollback to a specific prompt version
  fastify.post<{ Params: { id: string; version: string } }>('/:id/rollback/:version', async (req, reply) => {
    const { id, version } = req.params;
    const ver = await db.botPromptVersion.findFirst({ where: { botId: id, version: Number(version) } });
    if (!ver) return reply.status(404).send({ error: 'Version not found' });

    const latest = await db.botPromptVersion.findFirst({ where: { botId: id }, orderBy: { version: 'desc' } });
    const nextVersion = (latest?.version ?? 0) + 1;

    await db.$transaction([
      db.bot.update({ where: { id }, data: { systemPrompt: ver.systemPrompt } }),
      db.botPromptVersion.create({ data: { botId: id, version: nextVersion, systemPrompt: ver.systemPrompt } }),
    ]);

    invalidateBotCache(id);
    return reply.send({ rolledBackTo: version, newVersion: nextVersion });
  });

  // ── Branding ──────────────────────────────────────────────────────────────

  fastify.get<{ Params: { id: string } }>('/:id/branding', async (req, reply) => {
    const branding = await db.botBranding.findUnique({ where: { botId: req.params.id } });
    if (!branding) return reply.status(404).send({ error: 'No branding found' });
    return reply.send(branding);
  });

  fastify.put<{ Params: { id: string }; Body: BrandingBody }>('/:id/branding', async (req, reply) => {
    const branding = await db.botBranding.upsert({
      where: { botId: req.params.id },
      update: req.body,
      create: { botId: req.params.id, ...req.body },
    });
    invalidateBotCache(req.params.id);
    return reply.send(branding);
  });

  // ── Commands ──────────────────────────────────────────────────────────────

  fastify.get<{ Params: { id: string } }>('/:id/commands', async (req, reply) => {
    return reply.send(await db.botCommand.findMany({ where: { botId: req.params.id } }));
  });

  fastify.post<{ Params: { id: string }; Body: CommandBody }>('/:id/commands', async (req, reply) => {
    const cmd = await db.botCommand.create({ data: { botId: req.params.id, ...req.body, payload: req.body.payload as Prisma.InputJsonValue } });
    invalidateBotCache(req.params.id);
    return reply.status(201).send(cmd);
  });

  fastify.put<{ Params: { id: string; cmdId: string }; Body: Partial<CommandBody> }>('/:id/commands/:cmdId', async (req, reply) => {
    const body = req.body;
    const updateData: Prisma.BotCommandUpdateInput = {};
    if (body.trigger !== undefined) updateData.trigger = body.trigger;
    if (body.responseType !== undefined) updateData.responseType = body.responseType;
    if (body.payload !== undefined) updateData.payload = body.payload as Prisma.InputJsonValue;
    const cmd = await db.botCommand.update({ where: { id: req.params.cmdId }, data: updateData });
    invalidateBotCache(req.params.id);
    return reply.send(cmd);
  });

  fastify.delete<{ Params: { id: string; cmdId: string } }>('/:id/commands/:cmdId', async (req, reply) => {
    await db.botCommand.delete({ where: { id: req.params.cmdId } });
    invalidateBotCache(req.params.id);
    return reply.status(204).send();
  });

  // ── Crisis config ─────────────────────────────────────────────────────────

  fastify.get<{ Params: { id: string } }>('/:id/crisis-config', async (req, reply) => {
    return reply.send(await db.botCrisisConfig.findMany({ where: { botId: req.params.id } }));
  });

  fastify.put<{ Params: { id: string }; Body: CrisisConfigBody }>('/:id/crisis-config', async (req, reply) => {
    // Replace all crisis config for this bot
    await db.botCrisisConfig.deleteMany({ where: { botId: req.params.id } });
    const created = await db.botCrisisConfig.createMany({
      data: req.body.configs.map(c => ({ botId: req.params.id, ...c })),
    });
    invalidateBotCache(req.params.id);
    return reply.send({ count: created.count });
  });
};

// ─── Sanitize: never return encrypted bytes to the API ───────────────────────

function sanitizeBot(bot: Record<string, unknown>): Record<string, unknown> {
  const { llmApiKeyEnc, ...rest } = bot as Record<string, unknown> & { llmApiKeyEnc?: unknown };
  return { ...rest, llmApiKeySet: llmApiKeyEnc != null };
}

// ─── Body types ──────────────────────────────────────────────────────────────

interface CreateBotBody {
  orgId?: string; // ignored for non-superadmin (uses JWT orgId)
  name: string;
  locale?: string;
  systemPrompt?: string;
  identity?: Record<string, unknown>;
  onboardingMsg?: string;
  historyWindow?: number;
  llmProvider?: string;
  llmModel?: string;
  llmApiKey?: string;
  llmParams?: Record<string, unknown>;
  branding?: BrandingBody;
}

interface UpdateBotBody {
  name?: string;
  locale?: string;
  status?: string;
  identity?: Record<string, unknown>;
  onboardingMsg?: string;
  historyWindow?: number;
  llmProvider?: string;
  llmModel?: string;
  llmApiKey?: string;
  llmParams?: Record<string, unknown>;
}

interface BrandingBody {
  companyName?: string;
  logoUrl?: string;
  primaryColor?: string;
  website?: string;
  supportContact?: string;
  privacyPolicyUrl?: string;
  termsUrl?: string;
}

interface CommandBody {
  trigger: string;
  responseType: string;
  payload: Record<string, unknown>;
}

interface CrisisConfigBody {
  configs: Array<{
    country: string;
    lines: Array<{ name: string; phone: string; hours?: string }>;
    enabled?: boolean;
  }>;
}

export default botRoutes;
