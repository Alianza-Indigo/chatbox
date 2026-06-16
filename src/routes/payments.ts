import type { FastifyPluginAsync } from 'fastify';
import { reconcilePayment } from '../services/membership.service';
import { recordMembershipActivation } from '../services/metrics.service';
import { logger } from '../logger';

// Payment-provider webhook (microsaas mode). The provider posts here when a payment
// changes state. We never trust the body: reconcilePayment re-fetches the payment
// from the provider API using the bot's own token and activates on 'approved'.
//
// notification_url is built as: {PUBLIC_BASE_URL}/webhook/payments/:provider/:botId
const paymentRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Params: { provider: string; botId: string } }>(
    '/webhook/payments/:provider/:botId',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { provider, botId } = req.params;
      const { type, paymentId } = extractNotification(req.query, req.body);

      // Only payment events carry an activatable status; ignore the rest (e.g. merchant_order).
      if (type !== 'payment' || !paymentId) {
        return reply.status(200).send('ignored');
      }

      try {
        const outcome = await reconcilePayment(botId, provider, paymentId);
        if (outcome.activated && outcome.orgId) {
          recordMembershipActivation(outcome.orgId);
          logger.info({ botId, provider }, 'membership activated via payment webhook');
        }
        return reply.status(200).send('ok');
      } catch (err) {
        // Transient failure (e.g. provider API down) — return 500 so the provider retries.
        logger.warn({ botId, provider, err: (err as Error).message }, 'payment webhook reconcile failed');
        return reply.status(500).send('retry');
      }
    },
  );
};

// Mercado Pago delivers notifications in several shapes:
//   query: ?type=payment&data.id=123  or  ?topic=payment&id=123
//   body:  { type:'payment', data:{ id:'123' } }  or  { topic:'payment', resource:'123' }
function extractNotification(query: unknown, body: unknown): { type?: string; paymentId?: string } {
  const q = (query ?? {}) as Record<string, string>;
  const b = (body ?? {}) as { type?: string; topic?: string; data?: { id?: string | number }; resource?: string };

  const type = q.type ?? q.topic ?? b.type ?? b.topic;

  const rawId =
    q['data.id'] ??
    q.id ??
    (b.data?.id != null ? String(b.data.id) : undefined) ??
    b.resource;

  // `resource` is sometimes a full URL ending in the id — take the last path segment.
  const paymentId = rawId ? rawId.split('/').pop() : undefined;

  return { type, paymentId };
}

export default paymentRoutes;
