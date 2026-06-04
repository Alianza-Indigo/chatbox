import './config'; // Validate env vars on startup
import { startWorker } from './queue/consumer';
import { db } from './db';
import { logger } from './logger';

const worker = startWorker();

logger.info('worker started — listening for inbound messages');

async function shutdown() {
  logger.info('worker shutting down');
  await worker.close();
  await db.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
