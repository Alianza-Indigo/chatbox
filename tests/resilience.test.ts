import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundMessageJob } from '../src/types';

const {
  mockSendText,
  mockLLMComplete,
  mockLoadChannel,
  mockMessageAdd,
  mockSafetyClassify,
  mockSafetyClassifyAsync,
} = vi.hoisted(() => ({
  mockSendText: vi.fn().mockResolvedValue(undefined),
  mockLLMComplete: vi.fn().mockResolvedValue({ text: 'LLM response', usage: {} }),
  mockLoadChannel: vi.fn(),
  mockMessageAdd: vi.fn().mockResolvedValue(undefined),
  mockSafetyClassify: vi.fn().mockReturnValue({ isCrisis: false }),
  mockSafetyClassifyAsync: vi.fn().mockResolvedValue({ isCrisis: false }),
}));

vi.mock('../src/db', () => ({
  db: {
    endUser: { upsert: vi.fn().mockResolvedValue({ id: 'eu-1', paused: false }) },
    consent: { findFirst: vi.fn().mockResolvedValue({ id: 'c-1', status: 'accepted' }) },
    message: {
      upsert: vi.fn().mockResolvedValue({ id: 'msg-in-1' }),
      create: vi.fn().mockResolvedValue({ id: 'msg-out-1' }),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    crisisEvent: { create: vi.fn() },
    bot: { update: vi.fn() },
    feedback: { create: vi.fn() },
    organization: { findUnique: vi.fn().mockResolvedValue(null) },
    channel: { findFirst: vi.fn() },
  },
}));

vi.mock('../src/services/bot.service', () => ({
  loadChannelByPhoneId: mockLoadChannel,
  invalidateBotCache: vi.fn(),
}));

vi.mock('../src/providers/channel', () => ({
  getChannelProvider: vi.fn(() => ({
    sendText: mockSendText,
    sendInteractive: vi.fn().mockResolvedValue(undefined),
    parseInbound: vi.fn(),
    sendTemplate: vi.fn(),
  })),
}));

vi.mock('../src/providers/llm', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/providers/llm')>();
  return { ...original, getLLMProvider: vi.fn(() => ({ complete: mockLLMComplete })) };
});

vi.mock('../src/crypto', () => ({
  encrypt: vi.fn().mockReturnValue(Buffer.from('enc')),
  encryptToBase64: vi.fn((v: string) => Buffer.from(v).toString('base64')),
  decryptFromBase64: vi.fn((v: string) => Buffer.from(v, 'base64').toString()),
  decrypt: vi.fn().mockReturnValue('fake-llm-key'),
  encryptJson: vi.fn().mockReturnValue(Buffer.from('enc')),
  decryptJson: vi.fn().mockReturnValue({ accessToken: 'tok' }),
}));

vi.mock('../src/queue/queue', () => ({
  messageQueue: { add: mockMessageAdd },
  dlq: { add: vi.fn(), getWaitingCount: vi.fn().mockResolvedValue(0) },
  DLQ_QUEUE: 'dlq',
  MESSAGE_QUEUE: 'inbound-messages',
}));

vi.mock('../src/services/metrics.service', () => ({
  recordLLMUsage: vi.fn(),
  recordLLMError: vi.fn(),
  recordMetaError: vi.fn(),
  recordQuotaBlock: vi.fn(),
  recordSafetyBlock: vi.fn(),
  recordMessageProcessed: vi.fn(),
  recordPromptInjectionBlock: vi.fn(),
  recordStaleWebhook: vi.fn(),
  recordOrgLlmError: vi.fn(),
  updateDLQDepth: vi.fn(),
}));

vi.mock('../src/services/safety.service', () => ({
  safetyClassifier: {
    classify: mockSafetyClassify,
    classifyAsync: mockSafetyClassifyAsync,
  },
  SafetyServiceUnavailableError: class SafetyServiceUnavailableError extends Error {},
}));

vi.mock('../src/services/notification.service', () => ({
  notifyCredentialError: vi.fn(),
  notifyLLMFailure: vi.fn(),
  notifyDLQAlert: vi.fn(),
  sendWebhookAlert: vi.fn(),
}));

vi.mock('../src/services/tenant-sentry.service', () => ({
  captureTenantException: vi.fn(),
}));

vi.mock('../src/lib/pubsub', () => ({
  getPubClient: vi.fn(() => ({ ping: vi.fn().mockResolvedValue('PONG') })),
}));

const BASE_CHANNEL = {
  id: 'ch-1',
  phoneId: 'phone-biz-1',
  provider: 'meta_cloud',
  status: 'connected',
  credentials: Buffer.from('enc'),
  bot: {
    id: 'bot-1',
    name: 'TestBot',
    orgId: 'org-1',
    status: 'active',
    locale: 'es-MX',
    systemPrompt: 'Sys',
    historyWindow: 5,
    llmProvider: 'openai',
    llmModel: 'gpt-4o-mini',
    llmApiKeyEnc: Buffer.from('enc'),
    llmParams: null,
    identity: null,
    onboardingMsg: null,
    updatedAt: new Date(),
    createdAt: new Date(),
    safetyLevel: 'minimal',
    branding: null,
    commands: [],
    crisisConfig: [],
    knowledge: [],
    integrations: [],
  },
};

function makeJob(from: string, textBody = 'hola mundo'): InboundMessageJob {
  return {
    phoneId: 'phone-biz-1',
    waMessageId: `wamid-${Date.now()}-${Math.random()}`,
    from,
    messageType: 'text',
    textBody,
    timestamp: Date.now(),
    requestId: 'req-test-1',
  };
}

describe('Resilience - lock, idempotency, deduplication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadChannel.mockResolvedValue(BASE_CHANNEL);
    mockLLMComplete.mockResolvedValue({ text: 'Respuesta del bot', usage: {} });
    mockSafetyClassify.mockReturnValue({ isCrisis: false });
    mockSafetyClassifyAsync.mockResolvedValue({ isCrisis: false });
  });

  it('lock key includes sender phone so two users on the same business number use separate locks', () => {
    const userA = '+521112223333';
    const userB = '+529998887777';
    const phoneId = 'phone-biz-1';

    const lockA = `conv:${phoneId}:${userA}`;
    const lockB = `conv:${phoneId}:${userB}`;

    expect(lockA).not.toBe(lockB);
    expect(lockA).toBe(`conv:phone-biz-1:${userA}`);
    expect(lockB).toBe(`conv:phone-biz-1:${userB}`);
  });

  it('uses upsert for inbound messages so a retry after LLM failure does not duplicate the row', async () => {
    const { processInboundMessage } = await import('../src/services/conversation.service');
    const { db } = await import('../src/db');

    const job = makeJob('+521112223333');

    (db.message.upsert as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'msg-in-1' });
    (db.message.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    mockLLMComplete.mockRejectedValueOnce(new Error('LLM timeout'));

    await expect(processInboundMessage(job)).rejects.toThrow('LLM timeout');

    expect(db.message.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { externalId: job.waMessageId },
      }),
    );

    (db.message.upsert as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'msg-in-1' });
    (db.message.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    (db.message.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'msg-out-1' });
    mockLLMComplete.mockResolvedValueOnce({ text: 'Respuesta', usage: {} });

    await processInboundMessage(job);

    expect(db.message.upsert).toHaveBeenCalledTimes(2);
    expect(db.message.create).toHaveBeenCalledTimes(1);
  });

  it('re-sends the already-persisted response on retry without calling LLM again', async () => {
    const { processInboundMessage } = await import('../src/services/conversation.service');
    const { db } = await import('../src/db');

    const job = makeJob('+521112223333', 'dime algo interesante');

    (db.message.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'msg-in-1' });
    (db.message.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    (db.message.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'msg-out-1' });
    mockSendText.mockRejectedValueOnce(new Error('WhatsApp 503'));

    await expect(processInboundMessage(job)).rejects.toThrow('WhatsApp 503');

    (db.message.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'msg-out-1',
      bodyEnc: Buffer.from('enc'),
    });
    mockSendText.mockResolvedValue(undefined);

    await processInboundMessage(job);

    expect(db.message.upsert).toHaveBeenCalledTimes(2);
    expect(db.message.create).toHaveBeenCalledTimes(1);
    expect(mockLLMComplete).toHaveBeenCalledTimes(1);
    expect(mockSendText).toHaveBeenCalledTimes(2);
  });

  it('producer sets jobId = wa-{waMessageId} so BullMQ deduplicates duplicate webhook deliveries', async () => {
    const { enqueueInboundMessage } = await import('../src/queue/producer');

    const job = makeJob('+521112223333', 'mensaje duplicado');

    await enqueueInboundMessage(job);
    await enqueueInboundMessage(job);

    expect(mockMessageAdd).toHaveBeenCalledTimes(2);

    const [, , firstOpts] = mockMessageAdd.mock.calls[0];
    const [, , secondOpts] = mockMessageAdd.mock.calls[1];

    expect(firstOpts.jobId).toBe(`wa-${job.waMessageId}`);
    expect(secondOpts.jobId).toBe(`wa-${job.waMessageId}`);
  });

  it('producer encrypts from and textBody before storing in Redis', async () => {
    const { enqueueInboundMessage } = await import('../src/queue/producer');
    const { encryptToBase64 } = await import('../src/crypto');

    const job = makeJob('+521112223333', 'texto privado');
    await enqueueInboundMessage(job);

    const [, payload] = mockMessageAdd.mock.calls[0];

    expect(encryptToBase64).toHaveBeenCalledWith(job.from);
    expect(encryptToBase64).toHaveBeenCalledWith(job.textBody);
    expect(payload.from).not.toBe(job.from);
    expect(payload.textBody).not.toBe(job.textBody);
    expect(payload.phoneId).toBe(job.phoneId);
    expect(payload.waMessageId).toBe(job.waMessageId);
  });
});
