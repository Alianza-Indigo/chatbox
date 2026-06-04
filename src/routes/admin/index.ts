import type { FastifyPluginAsync } from 'fastify';
import { db } from '../../db';
import { requireAuth } from '../../middleware/auth';
import botRoutes from './bots';
import channelRoutes from './channels';
import orgRoutes from './organizations';
import knowledgeRoutes from './knowledge';
import userRoutes from './users';
import feedbackRoutes from './feedback';
import proactiveRoutes from './proactive';
import integrationRoutes from './integrations';
import dlqRoutes from './dlq';

const adminRoutes: FastifyPluginAsync = async (fastify) => {
  // Auth: JWT or ADMIN_API_KEY superadmin bypass
  fastify.addHook('preHandler', requireAuth);

  // Org isolation: verify botId-scoped routes belong to the requesting org
  fastify.addHook('preHandler', async (req, reply) => {
    const params = req.params as Record<string, string>;
    const botId = params.botId;
    if (!botId || !req.user || req.user.isSuperadmin) return;

    const bot = await db.bot.findUnique({ where: { id: botId }, select: { orgId: true } });
    if (!bot || bot.orgId !== req.user.orgId) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
  });

  fastify.register(orgRoutes, { prefix: '/organizations' });
  fastify.register(botRoutes, { prefix: '/bots' });
  fastify.register(channelRoutes, { prefix: '/bots' });
  fastify.register(knowledgeRoutes, { prefix: '/bots' });
  fastify.register(userRoutes, { prefix: '/bots' });
  fastify.register(feedbackRoutes, { prefix: '/bots' });
  fastify.register(proactiveRoutes, { prefix: '/bots' });
  fastify.register(integrationRoutes, { prefix: '/bots' });
  fastify.register(dlqRoutes);
};

export default adminRoutes;
