import type { FastifyPluginAsync } from 'fastify';
import { dlq, messageQueue } from '../../queue/queue';

// DLQ management — superadmin only.
// Jobs land here after exhausting all retries on the main queue.
// Operations: list, retry (re-enqueue to main queue), discard.

const dlqRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (req, reply) => {
    if (!req.user?.isSuperadmin) return reply.status(403).send({ error: 'Superadmin only' });
  });

  // List DLQ jobs (newest 100)
  fastify.get('/dlq', async (_req, reply) => {
    const jobs = await dlq.getWaiting(0, 99);
    return reply.send(jobs.map(j => ({
      id: j.id,
      name: j.name,
      data: {
        phoneId: j.data?.phoneId,
        waMessageId: j.data?.waMessageId,
        messageType: j.data?.messageType,
        timestamp: j.data?.timestamp,
      },
      failedReason: j.failedReason,
      attemptsMade: j.attemptsMade,
      addedAt: new Date(j.timestamp).toISOString(),
    })));
  });

  // DLQ depth — useful for alerting thresholds
  fastify.get('/dlq/count', async (_req, reply) => {
    const count = await dlq.getWaitingCount();
    return reply.send({ count });
  });

  // Retry — re-enqueue job to the main processing queue, then remove from DLQ
  fastify.post<{ Params: { jobId: string } }>('/dlq/:jobId/retry', async (req, reply) => {
    const job = await dlq.getJob(req.params.jobId);
    if (!job) return reply.status(404).send({ error: 'Job not found in DLQ' });

    await messageQueue.add('retry-from-dlq', job.data, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    });
    await job.remove();

    return reply.send({ requeued: true, jobId: req.params.jobId });
  });

  // Discard — permanently remove a job from the DLQ
  fastify.delete<{ Params: { jobId: string } }>('/dlq/:jobId', async (req, reply) => {
    const job = await dlq.getJob(req.params.jobId);
    if (!job) return reply.status(404).send({ error: 'Job not found in DLQ' });
    await job.remove();
    return reply.status(204).send();
  });
};

export default dlqRoutes;
