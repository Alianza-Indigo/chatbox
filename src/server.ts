import { config } from './config';
import { initSentry } from './lib/sentry';
import { buildApp } from './app';

// Must be initialized before any other import that could throw
initSentry(config.SENTRY_DSN, config.NODE_ENV);

const app = buildApp();

app.listen({ port: config.PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});

const SHUTDOWN_TIMEOUT_MS = 30_000;

async function shutdown() {
  // Force-exit if Fastify hasn't drained in-flight requests within the timeout
  const forceExit = setTimeout(() => {
    app.log.error('graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  await app.close(); // stops accepting new connections and drains in-flight requests
  clearTimeout(forceExit);
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
