import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundMessageJob } from '../src/types';

const {
  mockSendText,
  mockLLMComplete,
  mockLoadChannel,
  mockCreateCheckout,
  mockSafetyClassify,
  mockSafetyClassifyAsync,
} = vi.hoisted(() => ({
  mockSendText: vi.fn().mockResolvedValue(undefined),
  mockLLMComplete: vi.fn().mockResolvedValue({ text: 'Respuesta del bot', usage: {} }),
  mockLoadChannel: vi.fn(),
  mockCreateCheckout: vi.fn().mockResolvedValue({ providerRef: 'pref-1', url: 'https://mp/pay' }),
  mockSafetyClassify: vi.fn().mockReturnValue({ isCrisis: false }),
  mockSafetyClassifyAsync: vi.fn().mockResolvedValue({ isCrisis: false }),
}));

vi.mock('../src/db', () => ({
  db: {
    endUser: {
      upsert: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue({ membershipUntil: null }),
    },
    consent: { findFirst: vi.fn().mockResolvedValue({ id: 'c-1' }) },
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
    payment: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'pay-1' }),
      update: vi.fn().mockResolvedValue({}),
    },
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

vi.mock('../src/providers/payments', () => ({
  getPaymentProvider: vi.fn(() => ({
    createCheckout: mockCreateCheckout,
    getPayment: vi.fn(),
  })),
}));

vi.mock('../src/crypto', () => ({
  encrypt: vi.fn().mockReturnValue(Buffer.from('enc')),
  decrypt: vi.fn().mockReturnValue('fake-llm-key'),
  decryptJson: vi.fn().mockReturnValue({ accessToken: 'tok', apiKey: 'mp-token' }),
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
  recordMembershipBlock: vi.fn(),
  recordMembershipActivation: vi.fn(),
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
}));

vi.mock('../src/services/tenant-sentry.service', () => ({
  captureTenantException: vi.fn(),
}));

const MEMBERSHIP = {
  enabled: true,
  freeMessages: 2,
  durationDays: 30,
  price: 99,
  currency: 'MXN',
  title: 'Membresia',
};

const CHANNEL = {
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
    identity: { membership: MEMBERSHIP },
    onboardingMsg: null,
    updatedAt: new Date(),
    createdAt: new Date(),
    safetyLevel: 'minimal',
    branding: { website: 'https://shop.test' },
    commands: [],
    crisisConfig: [],
    knowledge: [],
    integrations: [
      {
        id: 'int-1',
        botId: 'bot-1',
        kind: 'payments',
        provider: 'mercadopago',
        status: 'active',
        credentials: Buffer.from('enc'),
      },
    ],
  },
};

function makeJob(): InboundMessageJob {
  return {
    phoneId: 'phone-biz-1',
    waMessageId: `wamid-${Math.random()}`,
    from: '+521112223333',
    messageType: 'text',
    textBody: 'hola',
    timestamp: Date.now(),
    requestId: 'req-1',
  };
}

describe('Conversation - membership gate (microsaas mode)', () => {
  let db: { endUser: Record<string, ReturnType<typeof vi.fn>> };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSendText.mockResolvedValue(undefined);
    mockLLMComplete.mockResolvedValue({ text: 'Respuesta del bot', usage: {} });
    mockLoadChannel.mockResolvedValue(CHANNEL);
    mockCreateCheckout.mockResolvedValue({ providerRef: 'pref-1', url: 'https://mp/pay' });
    mockSafetyClassify.mockReturnValue({ isCrisis: false });
    mockSafetyClassifyAsync.mockResolvedValue({ isCrisis: false });
    db = (await import('../src/db')).db as never;
    db.endUser.findUnique.mockResolvedValue({ membershipUntil: null });
  });

  it('serves a free-tier user and consumes one free credit after replying', async () => {
    const { processInboundMessage } = await import('../src/services/conversation.service');
    db.endUser.upsert.mockResolvedValue({ id: 'eu-1', paused: false, freeMsgUsed: 0, membershipUntil: null });

    await processInboundMessage(makeJob());

    expect(mockLLMComplete).toHaveBeenCalledTimes(1);
    expect(mockSendText).toHaveBeenCalledWith(expect.objectContaining({ text: 'Respuesta del bot' }));
    expect(db.endUser.update).toHaveBeenCalledWith({ where: { id: 'eu-1' }, data: { freeMsgUsed: { increment: 1 } } });
  });

  it('paywalls a user who exhausted the free tier and never calls the LLM', async () => {
    const { processInboundMessage } = await import('../src/services/conversation.service');
    db.endUser.upsert.mockResolvedValue({ id: 'eu-1', paused: false, freeMsgUsed: 2, membershipUntil: null });

    await processInboundMessage(makeJob());

    expect(mockLLMComplete).not.toHaveBeenCalled();
    expect(mockCreateCheckout).toHaveBeenCalledTimes(1);
    const sent = mockSendText.mock.calls[0][0].text as string;
    expect(sent).toContain('https://mp/pay');
    expect(db.endUser.update).not.toHaveBeenCalled();
  });

  it('serves an active member without consuming a free credit', async () => {
    const { processInboundMessage } = await import('../src/services/conversation.service');
    const future = new Date(Date.now() + 5 * 86400000);
    db.endUser.upsert.mockResolvedValue({ id: 'eu-1', paused: false, freeMsgUsed: 999, membershipUntil: future });

    await processInboundMessage(makeJob());

    expect(mockLLMComplete).toHaveBeenCalledTimes(1);
    expect(db.endUser.update).not.toHaveBeenCalled();
  });
});
