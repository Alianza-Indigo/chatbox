import { randomUUID } from 'crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { db } from './db';
import { getPubClient } from './lib/pubsub';
import { registry } from './services/metrics.service';
import { Sentry } from './lib/sentry';
import { openApiSpec } from './openapi';
import webhookRoutes from './routes/webhook';
import paymentRoutes from './routes/payments';
import authRoutes from './routes/auth';
import adminRoutes from './routes/admin/index';

export function buildApp() {
  const fastify = Fastify({
    // UUID request IDs enable log correlation across HTTP → queue → worker
    genReqId: () => randomUUID(),
    logger: process.env.NODE_ENV === 'test' ? false : {
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
      // Never log request bodies — they contain message content
      serializers: {
        req: (req) => ({ method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    },
  });

  // Echo request ID on every response for client-side correlation
  fastify.addHook('onSend', async (req, reply) => {
    reply.header('X-Request-Id', req.id);
  });

  // /docs and /metrics are restricted to superadmin (x-admin-key header).
  // In production, additionally restrict at the network/reverse-proxy level.
  fastify.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/docs') || req.url.startsWith('/metrics')) {
      if (req.headers['x-admin-key'] !== process.env.ADMIN_API_KEY) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }
    }
  });

  fastify.register(helmet);
  fastify.register(cors, { origin: false }); // Webhook + admin API — no browser CORS needed
  fastify.register(multipart, {
    limits: {
      files: 1,
      fileSize: 10 * 1024 * 1024,
    },
  });

  // OpenAPI spec (static mode — spec is maintained in src/openapi.ts)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fastify.register(swagger, {
    mode: 'static',
    specification: { document: openApiSpec as never },
  });
  fastify.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'none', filter: true },
  });

  // Global rate limit; tighter per-route overrides applied on /webhook POST
  fastify.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    errorResponseBuilder: () => ({ error: 'Too many requests' }),
  });

  // Health check — probes DB and Redis so Railway readiness is meaningful
  // Prometheus metrics — restrict network access in production (no auth here to allow scraping)
  fastify.get('/metrics', { config: { rateLimit: false } }, async (_req, reply) => {
    return reply.type('text/plain; version=0.0.4').send(await registry.metrics());
  });

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
  fastify.register(paymentRoutes);
  fastify.register(authRoutes, { prefix: '/auth' });
  fastify.register(adminRoutes, { prefix: '/admin' });

  fastify.setErrorHandler((err, req, reply) => {
    const e = err as Error & { statusCode?: number; validationDetails?: unknown; code?: string };
    if (e.validationDetails) {
      return reply.status(400).send({ error: 'Validation error', details: e.validationDetails });
    }
    const statusCode = e.statusCode ?? 500;
    if (statusCode >= 500) {
      Sentry.withScope((scope) => {
        scope.setExtra('requestId', req.id);
        scope.setExtra('url', req.url);
        scope.setExtra('method', req.method);
        Sentry.captureException(e);
      });
    }
    fastify.log.error({ err: e.message, code: e.code, requestId: req.id }, 'unhandled error');
    reply.status(statusCode).send({ error: 'Internal server error' });
  });

  return fastify;
}
