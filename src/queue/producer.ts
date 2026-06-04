import { messageQueue } from './queue';
import { encryptToBase64 } from '../crypto';
import type { InboundMessageJob } from '../types';

export async function enqueueInboundMessage(job: InboundMessageJob): Promise<void> {
  // Encrypt PII fields before storing in Redis — phone numbers and message
  // bodies are personal data under LFPDPPP and must be protected at rest.
  await messageQueue.add('process', {
    ...job,
    from: encryptToBase64(job.from),
    textBody: job.textBody !== undefined ? encryptToBase64(job.textBody) : undefined,
  }, {
    // waMessageId as jobId gives BullMQ-level deduplication: if Meta delivers
    // the same webhook twice within the dedup window, the second add() is a no-op.
    jobId: `wa-${job.waMessageId}`,
    delay: 0,
  });
}
