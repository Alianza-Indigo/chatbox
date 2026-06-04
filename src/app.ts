import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import webhookRoutes from './routes/webhook';
import authRoutes from './routes/auth';
import adminRoutes from './routes/admin/index';

export function buildApp() {
  const fastify = Fastify({
    logger: {
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

  // Global rate limit — protects all routes; webhook and admin have their own tighter limits
  fastify.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    errorResponseBuilder: () => ({ error: 'Too many requests' }),
  });

  fastify.get('/health', { config: { rateLimit: false } }, async () => ({ status: 'ok', ts: Date.now() }));

  fastify.register(webhookRoutes);
  fastify.register(authRoutes, { prefix: '/auth' });
  fastify.register(adminRoutes, { prefix: '/admin' });

  fastify.setErrorHandler((err, _req, reply) => {
    fastify.log.error({ err: err.message, code: err.code }, 'unhandled error');
    reply.status(err.statusCode ?? 500).send({ error: 'Internal server error' });
  });

  return fastify;
}
