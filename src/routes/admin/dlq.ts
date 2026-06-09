import type { FastifyPluginAsync } from 'fastify';
import { dlq, messageQueue } from '../../queue/queue';
import { updateDLQDepth } from '../../services/metrics.service';

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
    dlq.getWaitingCount().then(updateDLQDepth).catch(() => { /* non-critical */ });

    return reply.send({ requeued: true, jobId: req.params.jobId });
  });

  // Discard — permanently remove a single job from the DLQ
  fastify.delete<{ Params: { jobId: string } }>('/dlq/:jobId', async (req, reply) => {
    const job = await dlq.getJob(req.params.jobId);
    if (!job) return reply.status(404).send({ error: 'Job not found in DLQ' });
    await job.remove();
    dlq.getWaitingCount().then(updateDLQDepth).catch(() => { /* non-critical */ });
    return reply.status(204).send();
  });

  // Bulk purge — remove all DLQ jobs, or only those older than `olderThanHours`.
  // Omit the query param to drain everything.
  fastify.delete<{ Querystring: { olderThanHours?: string } }>('/dlq', async (req, reply) => {
    const hours = req.query.olderThanHours !== undefined ? Number(req.query.olderThanHours) : undefined;

    let removed: number;
    if (hours !== undefined && hours >= 0) {
      const graceMs = Math.floor(hours * 3_600_000);
      // BullMQ clean(grace, limit, type): removes 'wait' jobs older than graceMs
      const ids = await dlq.clean(graceMs, 1_000_000, 'wait');
      removed = ids.length;
    } else {
      const countBefore = await dlq.getWaitingCount();
      await dlq.drain();
      removed = countBefore;
    }

    dlq.getWaitingCount().then(updateDLQDepth).catch(() => { /* non-critical */ });
    return reply.send({ removed, olderThanHours: hours ?? null });
  });
};

export default dlqRoutes;
