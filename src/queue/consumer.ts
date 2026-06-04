import { Worker } from 'bullmq';
import { redisConnection, MESSAGE_QUEUE, dlq } from './queue';
import { processInboundMessage } from '../services/conversation.service';
import { logger } from '../logger';
import type { InboundMessageJob } from '../types';

export function startWorker(): Worker {
  const worker = new Worker<InboundMessageJob>(
    MESSAGE_QUEUE,
    async (job) => {
      await processInboundMessage(job.data);
    },
    {
      connection: redisConnection,
      concurrency: 10,
      lockDuration: 90_000, // 90 s max per job — covers worst-case LLM response latency
    },
  );

  worker.on('failed', (job, err) => {
    const maxAttempts = job?.opts.attempts ?? 3;
    const exhausted = (job?.attemptsMade ?? 0) >= maxAttempts;

    logger.error(
      { jobId: job?.id, phoneId: job?.data?.phoneId, attempt: job?.attemptsMade, exhausted, err: err?.message },
      'job failed',
    );

    // Move to DLQ once all retries are exhausted so the payload is preserved
    // for manual inspection and replay without blocking the main queue.
    if (exhausted && job) {
      dlq.add('failed-message', job.data, { jobId: `dlq-${job.id}` }).catch((dlqErr: Error) => {
        logger.error({ err: dlqErr.message }, 'failed to enqueue to DLQ');
      });
    }
  });

  worker.on('error', (err) => {
    logger.error({ err: err.message }, 'worker error');
  });

  return worker;
}
