import { config } from './config';
import { initSentry, Sentry } from './lib/sentry';
import { startWorker } from './queue/consumer';
import { db } from './db';
import { logger } from './logger';
import { getSubClient, closePubSub, CACHE_INVALIDATE_CHANNEL } from './lib/pubsub';
import { clearLocalBotCache } from './services/bot.service';

// Initialize Sentry as the first executable statement so it's active before
// any async code runs (uncaughtException/unhandledRejection handlers below).
initSentry(config.SENTRY_DSN, config.NODE_ENV);

// Catch programming errors that escape BullMQ's own error boundary
process.on('uncaughtException', (err) => {
  logger.error({ err: err.message, stack: err.stack }, 'uncaught exception — exiting');
  Sentry.captureException(err);
  process.exit(1);
});

// Log unhandled rejections but don't exit — BullMQ raises these on transient
// Redis connection drops and recovers automatically.
process.on('unhandledRejection', (reason) => {
  logger.error({ reason: String(reason) }, 'unhandled rejection');
  if (reason instanceof Error) Sentry.captureException(reason);
});

const worker = startWorker();

// Subscribe to cache invalidation events broadcast by the web service
const sub = getSubClient();
sub.subscribe(CACHE_INVALIDATE_CHANNEL).catch((err) => {
  logger.error({ err: (err as Error).message }, 'failed to subscribe to cache invalidation channel');
});
sub.on('message', (channel, botId) => {
  if (channel === CACHE_INVALIDATE_CHANNEL) clearLocalBotCache(botId);
});

logger.info('worker started — listening for inbound messages');

const SHUTDOWN_TIMEOUT_MS = 30_000;

async function shutdown() {
  logger.info('worker shutting down');

  // Force-exit if graceful shutdown takes too long (e.g. stuck job or DB hang)
  const forceExit = setTimeout(() => {
    logger.error('graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref(); // don't block event loop if everything closes cleanly

  await worker.close();
  await closePubSub();
  await db.$disconnect();
  clearTimeout(forceExit);
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
