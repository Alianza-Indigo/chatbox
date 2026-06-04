import { Worker } from 'bullmq';
import { redisConnection, MESSAGE_QUEUE, dlq, messageQueue } from './queue';
import { processInboundMessage } from '../services/conversation.service';
import { getPubClient } from '../lib/pubsub';
import { logger } from '../logger';
import { notifyDLQAlert } from '../services/notification.service';
import { updateDLQDepth } from '../services/metrics.service';
import { Sentry } from '../lib/sentry';
import { captureTenantException } from '../services/tenant-sentry.service';
import { decryptFromBase64 } from '../crypto';
import { db } from '../db';
import type { InboundMessageJob } from '../types';

// Separate Redis client for conversation mutex operations (not in subscriber mode)
const redis = getPubClient();

const MAX_LOCK_RETRIES = 5;
const LOCK_TTL_MS = 90_000; // matches lockDuration — auto-expires if worker crashes
const LOCK_RETRY_BASE_MS = 2_000;

export function startWorker(): Worker {
  const worker = new Worker<InboundMessageJob>(
    MESSAGE_QUEUE,
    async (job) => {
      // Decrypt PII fields that were encrypted by the producer before Redis storage.
      // `from` is the END USER's phone — decrypt it so processInboundMessage can hash it.
      const jobData: InboundMessageJob = {
        ...job.data,
        from: decryptFromBase64(job.data.from),
        textBody: job.data.textBody !== undefined ? decryptFromBase64(job.data.textBody) : undefined,
      };

      // Per-conversation mutex: keyed on (phoneId, from) so two different users
      // writing to the same business number are never blocked by each other.
      const lockKey = `conv:${jobData.phoneId}:${jobData.from}`;
      const lockToken = job.id!;

      // Per-conversation mutex — ensures messages from the same phone are
      // processed in order even with worker concurrency > 1.
      // ioredis v5 SET argument order: key, value, 'PX', ttl, 'NX'
      const acquired = await redis.set(lockKey, lockToken, 'PX', LOCK_TTL_MS, 'NX');
      if (!acquired) {
        const lockRetries = (jobData.lockRetries ?? 0) + 1;
        if (lockRetries <= MAX_LOCK_RETRIES) {
          // Re-enqueue the already-decrypted job data with the incremented retry counter.
          // The producer would re-encrypt; here we re-enqueue the RAW (still-encrypted)
          // payload from job.data to avoid double-encrypt on reschedule.
          await messageQueue.add('process', { ...job.data, lockRetries }, {
            delay: LOCK_RETRY_BASE_MS * lockRetries,
          });
        } else {
          logger.warn({ jobId: job.id, phoneId: job.data.phoneId, requestId: job.data.requestId }, 'conversation lock: max retries exceeded, dropping job');
        }
        return; // current job is done — work was rescheduled (or dropped)
      }

      try {
        await processInboundMessage(jobData);
      } finally {
        // Release only if we still own the lock (guards against TTL expiry + reacquire)
        const owner = await redis.get(lockKey);
        if (owner === lockToken) await redis.del(lockKey);
      }
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
      { jobId: job?.id, phoneId: job?.data?.phoneId, requestId: job?.data?.requestId, attempt: job?.attemptsMade, exhausted, err: err?.message },
      'job failed',
    );

    // Report exhausted jobs to both platform Sentry and the tenant's Sentry
    if (exhausted && err) {
      Sentry.withScope((scope) => {
        scope.setTag('phoneId', job?.data?.phoneId ?? 'unknown');
        scope.setExtra('requestId', job?.data?.requestId);
        scope.setExtra('jobId', job?.id);
        Sentry.captureException(err);
      });

      // Resolve the org from the phone channel and report to tenant's Sentry
      if (job?.data?.phoneId) {
        db.channel
          .findFirst({
            where: { phoneId: job.data.phoneId },
            select: { bot: { select: { orgId: true } } },
          })
          .then((ch) => {
            if (ch?.bot?.orgId) {
              captureTenantException(ch.bot.orgId, err, {
                jobId: job.id,
                requestId: job.data.requestId,
                errorType: 'job_exhausted',
              });
            }
          })
          .catch(() => { /* non-critical */ });
      }
    }

    // Move to DLQ once all retries are exhausted so the payload is preserved
    // for manual inspection and replay without blocking the main queue.
    if (exhausted && job) {
      dlq.add('failed-message', job.data, { jobId: `dlq-${job.id}` }).then(() => {
        notifyDLQAlert(job.id!, job.data.phoneId);
        dlq.getWaitingCount().then(updateDLQDepth).catch(() => { /* non-critical */ });
      }).catch((dlqErr: Error) => {
        logger.error({ err: dlqErr.message }, 'failed to enqueue to DLQ');
      });
    }
  });

  worker.on('error', (err) => {
    logger.error({ err: err.message }, 'worker error');
  });

  return worker;
}
