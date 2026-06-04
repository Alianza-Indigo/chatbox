import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { db } from './db';
import { getPubClient } from './lib/pubsub';
import webhookRoutes from './routes/webhook';
import authRoutes from './routes/auth';
import adminRoutes from './routes/admin/index';

export function buildApp() {
  const fastify = Fastify({
    logger: process.env.NODE_ENV === 'test' ? false : {
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
      // Never log request bodies — they contain message content
      serializers: {
        req: (req) => ({ method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    },
  });

  fastify.register(helmet);
  fastify.register(cors, { origin: false }); // Webhook + admin API — no browser CORS needed

  // Global rate limit; tighter per-route overrides applied on /webhook POST
  fastify.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    errorResponseBuilder: () => ({ error: 'Too many requests' }),
  });

  // Health check — probes DB and Redis so Railway readiness is meaningful
  fastify.get('/health', { config: { rateLimit: false } }, async (_req, reply) => {
    const [dbOk, redisOk] = await Promise.all([
      db.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
      getPubClient().ping().then(() => true).catch(() => false),
    ]);
    const status = dbOk && redisOk ? 'ok' : 'degraded';
    return reply
      .status(dbOk && redisOk ? 200 : 503)
      .send({ status, db: dbOk, redis: redisOk, ts: Date.now() });
  });

  fastify.register(webhookRoutes);
  fastify.register(authRoutes, { prefix: '/auth' });
  fastify.register(adminRoutes, { prefix: '/admin' });

  fastify.setErrorHandler((err, _req, reply) => {
    const e = err as Error & { statusCode?: number; validationDetails?: unknown; code?: string };
    if (e.validationDetails) {
      return reply.status(400).send({ error: 'Validation error', details: e.validationDetails });
    }
    fastify.log.error({ err: e.message, code: e.code }, 'unhandled error');
    reply.status(e.statusCode ?? 500).send({ error: 'Internal server error' });
  });

  return fastify;
}
