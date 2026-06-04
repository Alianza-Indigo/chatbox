import type { FastifyPluginAsync } from 'fastify';
import { db } from '../../db';
import { encryptJson, decryptJson } from '../../crypto';
import { invalidateBotCache } from '../../services/bot.service';
import { requirePermission } from '../../lib/rbac';
import { logAudit } from '../../services/audit.service';
import { config } from '../../config';
import { parseBody, CreateChannelSchema, UpdateChannelSchema, EmbeddedSignupSchema } from '../../lib/validate';
import type { MetaCloudCredentials } from '../../types';

const channelRoutes: FastifyPluginAsync = async (fastify) => {
  // List channels for a bot
  fastify.get<{ Params: { botId: string } }>('/:botId/channels', async (req, reply) => {
    const channels = await db.channel.findMany({ where: { botId: req.params.botId } });
    return reply.send(channels.map(sanitizeChannel));
  });

  // Add channel to a bot
  fastify.post<{ Params: { botId: string } }>('/:botId/channels', { preHandler: [requirePermission('channel:manage')] }, async (req, reply) => {
    const { botId } = req.params;
    const { provider, phoneId, accessToken, businessAccountId, verifyToken } = parseBody(CreateChannelSchema, req.body);

    const creds: MetaCloudCredentials = { accessToken, businessAccountId };
    const channel = await db.channel.create({
      data: { botId, provider, phoneId, credentials: encryptJson(creds), verifyToken, status: 'connected' },
    });

    invalidateBotCache(botId);
    logAudit({
      orgId: req.user!.isSuperadmin ? undefined : req.user!.orgId,
      actorId: req.user!.isSuperadmin ? undefined : req.user!.userId,
      actorRole: req.user!.isSuperadmin ? 'superadmin' : req.user!.role,
      action: 'channel.create',
      targetType: 'channel',
      targetId: channel.id,
      metadata: { botId, provider, phoneId },
      ip: req.ip,
    });
    return reply.status(201).send(sanitizeChannel(channel));
  });

  // Update channel (rotate token, change status)
  fastify.put<{ Params: { botId: string; channelId: string } }>('/:botId/channels/:channelId', { preHandler: [requirePermission('channel:manage')] }, async (req, reply) => {
    const { botId, channelId } = req.params;
    const body = parseBody(UpdateChannelSchema, req.body);

    const existing = await db.channel.findUnique({ where: { id: channelId } });
    if (!existing || existing.botId !== botId) return reply.status(404).send({ error: 'Channel not found' });

    const data: Record<string, unknown> = {};
    if (body.status !== undefined) data.status = body.status;
    if (body.verifyToken !== undefined) data.verifyToken = body.verifyToken;

    if (body.accessToken !== undefined) {
      const existingCreds = decryptJson<MetaCloudCredentials>(existing.credentials);
      const newCreds: MetaCloudCredentials = {
        ...existingCreds,
        accessToken: body.accessToken,
        ...(body.businessAccountId ? { businessAccountId: body.businessAccountId } : {}),
      };
      data.credentials = encryptJson(newCreds);
    }

    const channel = await db.channel.update({ where: { id: channelId }, data });
    invalidateBotCache(botId);
    return reply.send(sanitizeChannel(channel));
  });

  // Delete channel
  fastify.delete<{ Params: { botId: string; channelId: string } }>('/:botId/channels/:channelId', { preHandler: [requirePermission('channel:manage')] }, async (req, reply) => {
    const { botId, channelId } = req.params;
    const existing = await db.channel.findUnique({ where: { id: channelId }, select: { botId: true } });
    if (!existing || existing.botId !== botId) return reply.status(404).send({ error: 'Channel not found' });
    await db.channel.delete({ where: { id: channelId } });
    invalidateBotCache(botId);
    logAudit({
      orgId: req.user!.isSuperadmin ? undefined : req.user!.orgId,
      actorId: req.user!.isSuperadmin ? undefined : req.user!.userId,
      actorRole: req.user!.isSuperadmin ? 'superadmin' : req.user!.role,
      action: 'channel.delete',
      targetType: 'channel',
      targetId: channelId,
      metadata: { botId },
      ip: req.ip,
    });
    return reply.status(204).send();
  });

  // ── Meta Embedded Signup ─────────────────────────────────────────────────
  fastify.post<{ Params: { botId: string } }>('/:botId/channels/embedded-signup', { preHandler: [requirePermission('channel:manage')] }, async (req, reply) => {
    if (!config.META_APP_ID) {
      return reply.status(501).send({ error: 'META_APP_ID not configured — Embedded Signup is unavailable' });
    }

    const { code, phoneId, verifyToken, redirectUri } = parseBody(EmbeddedSignupSchema, req.body);

    // Exchange Meta auth code for an access token
    const params = new URLSearchParams({
      client_id: config.META_APP_ID,
      client_secret: config.META_APP_SECRET,
      code,
      ...(redirectUri ? { redirect_uri: redirectUri } : {}),
    });

    let accessToken: string;
    try {
      const tokenRes = await fetch(
        `https://graph.facebook.com/oauth/access_token?${params.toString()}`,
        { method: 'GET' },
      );
      if (!tokenRes.ok) {
        const body = await tokenRes.text();
        return reply.status(502).send({ error: 'Meta token exchange failed', detail: body });
      }
      const tokenData = await tokenRes.json() as { access_token?: string; error?: unknown };
      if (!tokenData.access_token) {
        return reply.status(502).send({ error: 'No access_token in Meta response', detail: tokenData });
      }
      accessToken = tokenData.access_token;
    } catch (_err) {
      return reply.status(502).send({ error: 'Failed to reach Meta API' });
    }

    // Guard: if this phoneId is already owned by a different bot, reject
    const existing = await db.channel.findUnique({ where: { phoneId }, select: { botId: true } });
    if (existing && existing.botId !== req.params.botId) {
      return reply.status(409).send({ error: 'Phone number is already registered to another bot' });
    }

    const creds: MetaCloudCredentials = { accessToken };
    const channel = await db.channel.upsert({
      where: { phoneId },
      update: { credentials: encryptJson(creds), verifyToken, status: 'connected', provider: 'embedded_signup' },
      create: { botId: req.params.botId, provider: 'embedded_signup', phoneId, credentials: encryptJson(creds), verifyToken, status: 'connected' },
    });

    invalidateBotCache(req.params.botId);
    return reply.status(201).send(sanitizeChannel(channel));
  });
};

function sanitizeChannel(channel: Record<string, unknown>): Record<string, unknown> {
  const { credentials, ...rest } = channel;
  void credentials;
  return rest;
}

export default channelRoutes;
