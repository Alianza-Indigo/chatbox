import type { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@prisma/client';
import { db } from '../../db';
import { encrypt } from '../../crypto';
import { invalidateBotCache } from '../../services/bot.service';
import { requirePermission, can } from '../../lib/rbac';
import { logAudit } from '../../services/audit.service';
import {
  parseBody,
  CreateBotSchema, UpdateBotSchema, PromptSchema,
  BrandingSchema, CommandSchema, CrisisConfigSchema,
} from '../../lib/validate';

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
  fastify.post('/', { preHandler: [requirePermission('bot:create')] }, async (req, reply) => {
    const body = parseBody(CreateBotSchema, req.body);
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
        safetyLevel: body.safetyLevel ?? 'standard',
        branding: body.branding ? { create: body.branding } : undefined,
      },
    });

    if (body.systemPrompt) {
      await db.botPromptVersion.create({ data: { botId: bot.id, version: 1, systemPrompt: body.systemPrompt } });
    }

    return reply.status(201).send(sanitizeBot(bot));
  });

  // Update bot
  fastify.put<{ Params: { id: string } }>('/:id', { preHandler: [requirePermission('bot:update-config')] }, async (req, reply) => {
    const { id } = req.params;
    const body = parseBody(UpdateBotSchema, req.body);

    // Updating the LLM API key requires a higher-privilege action
    if (body.llmApiKey !== undefined && !req.user!.isSuperadmin && !can(req.user!.role, 'bot:update-credentials')) {
      return reply.status(403).send({ error: "Forbidden: requires permission 'bot:update-credentials'" });
    }

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
    if (body.safetyLevel !== undefined) data.safetyLevel = body.safetyLevel;

    const bot = await db.bot.update({ where: { id }, data });
    invalidateBotCache(id);

    if (body.llmApiKey !== undefined) {
      logAudit({
        orgId: existing.orgId,
        actorId: req.user!.isSuperadmin ? undefined : req.user!.userId,
        actorRole: req.user!.isSuperadmin ? 'superadmin' : req.user!.role,
        action: 'bot.update_credentials',
        targetType: 'bot',
        targetId: id,
        ip: req.ip,
      });
    }

    return reply.send(sanitizeBot(bot));
  });

  // Delete bot
  fastify.delete<{ Params: { id: string } }>('/:id', { preHandler: [requirePermission('bot:delete')] }, async (req, reply) => {
    const { id } = req.params;
    const existing = await db.bot.findUnique({ where: { id }, select: { orgId: true } });
    if (!existing) return reply.status(404).send({ error: 'Bot not found' });
    if (!req.user!.isSuperadmin && existing.orgId !== req.user!.orgId) return reply.status(403).send({ error: 'Forbidden' });
    await db.bot.delete({ where: { id } });
    invalidateBotCache(id);

    logAudit({
      orgId: existing.orgId,
      actorId: req.user!.isSuperadmin ? undefined : req.user!.userId,
      actorRole: req.user!.isSuperadmin ? 'superadmin' : req.user!.role,
      action: 'bot.delete',
      targetType: 'bot',
      targetId: id,
      ip: req.ip,
    });

    return reply.status(204).send();
  });

  // Update system_prompt (creates a new version)
  fastify.post<{ Params: { id: string } }>('/:id/prompt', { preHandler: [requirePermission('bot:update-prompt')] }, async (req, reply) => {
    const { id } = req.params;
    const { systemPrompt } = parseBody(PromptSchema, req.body);
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
  fastify.post<{ Params: { id: string; version: string } }>('/:id/rollback/:version', { preHandler: [requirePermission('bot:update-prompt')] }, async (req, reply) => {
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

  fastify.put<{ Params: { id: string } }>('/:id/branding', { preHandler: [requirePermission('bot:update-branding')] }, async (req, reply) => {
    const body = parseBody(BrandingSchema, req.body);
    const branding = await db.botBranding.upsert({
      where: { botId: req.params.id },
      update: body,
      create: { botId: req.params.id, ...body },
    });
    invalidateBotCache(req.params.id);
    return reply.send(branding);
  });

  // ── Commands ──────────────────────────────────────────────────────────────

  fastify.get<{ Params: { id: string } }>('/:id/commands', async (req, reply) => {
    return reply.send(await db.botCommand.findMany({ where: { botId: req.params.id } }));
  });

  fastify.post<{ Params: { id: string } }>('/:id/commands', { preHandler: [requirePermission('bot:update-commands')] }, async (req, reply) => {
    const body = parseBody(CommandSchema, req.body);
    const cmd = await db.botCommand.create({
      data: { botId: req.params.id, ...body, payload: body.payload as Prisma.InputJsonValue },
    });
    invalidateBotCache(req.params.id);
    return reply.status(201).send(cmd);
  });

  fastify.put<{ Params: { id: string; cmdId: string } }>('/:id/commands/:cmdId', { preHandler: [requirePermission('bot:update-commands')] }, async (req, reply) => {
    const { id, cmdId } = req.params;
    const existing = await db.botCommand.findUnique({ where: { id: cmdId }, select: { botId: true } });
    if (!existing || existing.botId !== id) return reply.status(404).send({ error: 'Command not found' });

    const body = parseBody(CommandSchema.partial(), req.body);
    const updateData: Prisma.BotCommandUpdateInput = {};
    if (body.trigger !== undefined) updateData.trigger = body.trigger;
    if (body.responseType !== undefined) updateData.responseType = body.responseType;
    if (body.payload !== undefined) updateData.payload = body.payload as Prisma.InputJsonValue;
    const cmd = await db.botCommand.update({ where: { id: cmdId }, data: updateData });
    invalidateBotCache(id);
    return reply.send(cmd);
  });

  fastify.delete<{ Params: { id: string; cmdId: string } }>('/:id/commands/:cmdId', { preHandler: [requirePermission('bot:update-commands')] }, async (req, reply) => {
    const { id, cmdId } = req.params;
    const existing = await db.botCommand.findUnique({ where: { id: cmdId }, select: { botId: true } });
    if (!existing || existing.botId !== id) return reply.status(404).send({ error: 'Command not found' });
    await db.botCommand.delete({ where: { id: cmdId } });
    invalidateBotCache(id);
    return reply.status(204).send();
  });

  // ── Crisis config ─────────────────────────────────────────────────────────

  fastify.get<{ Params: { id: string } }>('/:id/crisis-config', async (req, reply) => {
    return reply.send(await db.botCrisisConfig.findMany({ where: { botId: req.params.id } }));
  });

  fastify.put<{ Params: { id: string } }>('/:id/crisis-config', { preHandler: [requirePermission('bot:update-crisis-config')] }, async (req, reply) => {
    const { configs } = parseBody(CrisisConfigSchema, req.body);
    // Replace all crisis config for this bot
    await db.botCrisisConfig.deleteMany({ where: { botId: req.params.id } });
    const created = await db.botCrisisConfig.createMany({
      data: configs.map(c => ({ botId: req.params.id, ...c })),
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

export default botRoutes;
