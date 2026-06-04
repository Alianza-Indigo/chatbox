import type { FastifyPluginAsync } from 'fastify';
import { db } from '../../db';
import { deleteEndUserData } from '../../services/consent.service';

const userRoutes: FastifyPluginAsync = async (fastify) => {
  // List end users for a bot (hashed IDs only — no PII exposed)
  fastify.get<{ Params: { botId: string }; Querystring: { paused?: string } }>('/:botId/users', async (req, reply) => {
    const { botId } = req.params;
    const paused = req.query.paused !== undefined ? req.query.paused === 'true' : undefined;

    const users = await db.endUser.findMany({
      where: { botId, ...(paused !== undefined ? { paused } : {}) },
      select: { id: true, botId: true, locale: true, paused: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    return reply.send(users);
  });

  // Delete all data for an end user (Derecho ARCO — right to erasure)
  fastify.delete<{ Params: { botId: string; userId: string } }>('/:botId/users/:userId/data', async (req, reply) => {
    const { botId, userId } = req.params;

    const user = await db.endUser.findUnique({ where: { id: userId } });
    if (!user || user.botId !== botId) {
      return reply.status(404).send({ error: 'End user not found' });
    }

    await deleteEndUserData(userId);
    return reply.send({ deleted: true, userId });
  });

  // Suspend / unsuspend an end user
  fastify.patch<{ Params: { botId: string; userId: string }; Body: { paused: boolean } }>('/:botId/users/:userId', async (req, reply) => {
    const { botId, userId } = req.params;

    const user = await db.endUser.findUnique({ where: { id: userId } });
    if (!user || user.botId !== botId) {
      return reply.status(404).send({ error: 'End user not found' });
    }

    const updated = await db.endUser.update({ where: { id: userId }, data: { paused: req.body.paused } });
    return reply.send({ id: updated.id, paused: updated.paused });
  });

  // Crisis events for a bot
  fastify.get<{ Params: { botId: string }; Querystring: { limit?: string } }>('/:botId/crisis-events', async (req, reply) => {
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const events = await db.crisisEvent.findMany({
      where: { botId: req.params.botId },
      orderBy: { detectedAt: 'desc' },
      take: limit,
      // Omit endUserId to avoid linking crisis to an identifiable user
      select: { id: true, botId: true, detectedAt: true, category: true, actionTaken: true },
    });
    return reply.send(events);
  });

  // Bots currently in credential_error state (notification panel) — scoped to org
  fastify.get('/credential-errors', async (req, reply) => {
    const orgFilter = req.user!.isSuperadmin ? {} : { orgId: req.user!.orgId };
    const bots = await db.bot.findMany({
      where: { status: 'credential_error', ...orgFilter },
      select: { id: true, name: true, orgId: true, status: true, updatedAt: true, llmProvider: true, llmModel: true },
      orderBy: { updatedAt: 'desc' },
    });
    return reply.send(bots);
  });
};

export default userRoutes;
