import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { createHmac, timingSafeEqual } from 'crypto';
import { config } from '../config';
import { enqueueInboundMessage } from '../queue/producer';
import { getChannelProvider } from '../providers/channel';
import { recordStaleWebhook } from '../services/metrics.service';
import { logger } from '../logger';

// The Meta Cloud provider parses any Meta-formatted webhook
const metaProvider = getChannelProvider('meta_cloud');

interface RawBodyRequest extends FastifyRequest {
  rawBody?: Buffer;
}

const webhookRoutes: FastifyPluginAsync = async (fastify) => {
  // Keep raw body available for HMAC verification — scoped to this plugin only
  fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as RawBodyRequest).rawBody = body as Buffer;
    try {
      done(null, JSON.parse((body as Buffer).toString()));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // GET — Meta webhook verification challenge
  fastify.get('/webhook', async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === config.WEBHOOK_VERIFY_TOKEN) {
      return reply.send(q['hub.challenge']);
    }
    return reply.status(403).send('Forbidden');
  });

  // POST — Incoming messages from Meta (tighter limit: Meta batches, no IP needs >60/min)
  fastify.post('/webhook', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const rawReq = req as RawBodyRequest;
    const signature = req.headers['x-hub-signature-256'] as string | undefined;

    if (!signature || !verifySignature(rawReq.rawBody ?? Buffer.alloc(0), signature)) {
      return reply.status(401).send('Invalid signature');
    }

    // Enqueue BEFORE ACK — if Redis is unavailable we return 500 so Meta retries.
    // BullMQ enqueue is sub-millisecond so this stays well within Meta's 5 s window.
    await processPayload(req.body, req.id as string);

    return reply.status(200).send('EVENT_RECEIVED');
  });
};

async function processPayload(body: unknown, requestId: string): Promise<void> {
  const { messages } = metaProvider.parseInbound(body);
  const nowSecs = Math.floor(Date.now() / 1000);
  const replayWindow = config.WEBHOOK_REPLAY_WINDOW_SECS;

  for (const msg of messages) {
    // Replay-protection: skip messages whose timestamp is outside the allowed window.
    // This guards against replayed webhook deliveries. A window of 0 disables the check.
    if (replayWindow > 0 && msg.timestamp && nowSecs - msg.timestamp > replayWindow) {
      logger.warn({ waMessageId: msg.messageId, ageSecs: nowSecs - msg.timestamp, replayWindow }, 'stale webhook message skipped');
      recordStaleWebhook();
      continue;
    }

    await enqueueInboundMessage({
      phoneId: msg.phoneId,
      waMessageId: msg.messageId,
      from: msg.from,
      messageType: msg.type,
      textBody: msg.textBody,
      audioId: msg.audioId,
      interactiveReply: msg.interactiveReply,
      timestamp: msg.timestamp,
      requestId,
    });
  }
}

function verifySignature(rawBody: Buffer, signature: string): boolean {
  if (!signature.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', config.META_APP_SECRET).update(rawBody).digest('hex');
  const provided = signature.slice('sha256='.length);
  if (expected.length !== provided.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'));
  } catch {
    return false;
  }
}

export default webhookRoutes;
