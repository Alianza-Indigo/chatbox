import type { FastifyPluginAsync } from 'fastify';
import { db } from '../../db';
import { decryptJson } from '../../crypto';
import { getChannelProvider } from '../../providers/channel';
import { requirePermission } from '../../lib/rbac';
import { parseBody, ProactiveSchema } from '../../lib/validate';
import { config } from '../../config';
import type { MetaCloudCredentials } from '../../types';

// Admin-initiated proactive messages — only via pre-approved Meta templates.
// WhatsApp's 24-hour window rule means free-form messages can only be sent
// within 24h of a user-initiated conversation; templates bypass this.

const proactiveRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Params: { botId: string } }>('/:botId/proactive', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    preHandler: [requirePermission('proactive:send')],
  }, async (req, reply) => {
    const { botId } = req.params;
    const { to, templateName, languageCode, components, channelId } = parseBody(ProactiveSchema, req.body);

    // If channelId is provided, verify it belongs to this bot (IDOR guard)
    const channel = channelId
      ? await db.channel.findFirst({ where: { id: channelId, botId } })
      : await db.channel.findFirst({ where: { botId, status: 'connected' } });

    if (!channel) return reply.status(404).send({ error: 'No connected channel found for this bot' });

    const creds = decryptJson<MetaCloudCredentials>(channel.credentials);
    const channelProvider = getChannelProvider(channel.provider);

    await channelProvider.sendTemplate({
      phoneId: channel.phoneId,
      accessToken: creds.accessToken,
      to,
      templateName,
      languageCode,
      components: components ?? [],
      apiVersion: config.META_API_VERSION,
    });

    return reply.send({ sent: true, to, templateName });
  });
};

export default proactiveRoutes;
