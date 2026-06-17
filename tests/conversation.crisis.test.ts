import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundMessageJob } from '../src/types';
import { processInboundMessage, buildCrisisMessage } from '../src/services/conversation.service';
import { getLLMProvider } from '../src/providers/llm';

const {
  mockSendText,
  mockLLMComplete,
  mockLoadChannel,
  mockSafetyClassify,
  mockSafetyClassifyAsync,
} = vi.hoisted(() => ({
  mockSendText: vi.fn().mockResolvedValue(undefined),
  mockLLMComplete: vi.fn().mockResolvedValue({ text: 'LLM response - should NOT appear in crisis tests', usage: {} }),
  mockLoadChannel: vi.fn(),
  mockSafetyClassify: vi.fn(),
  mockSafetyClassifyAsync: vi.fn(),
}));

const TEST_TIMEOUT_MS = 15000;

vi.mock('../src/db', () => ({
  db: {
    endUser: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), upsert: vi.fn() },
    consent: { findFirst: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
    message: {
      create: vi.fn(),
      upsert: vi.fn().mockResolvedValue({ id: 'msg-in-1' }),
      findMany: vi.fn(),
      findUnique: vi.fn().mockResolvedValue(null),
      deleteMany: vi.fn(),
    },
    crisisEvent: { create: vi.fn(), deleteMany: vi.fn() },
    bot: { update: vi.fn() },
    feedback: { deleteMany: vi.fn() },
    organization: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn((ops: unknown[]) => Promise.all(ops)),
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
  return {
    ...original,
    getLLMProvider: vi.fn(() => ({ complete: mockLLMComplete })),
  };
});

vi.mock('../src/crypto', () => ({
  encrypt: vi.fn().mockReturnValue(Buffer.from('enc')),
  decrypt: vi.fn().mockReturnValue('fake-llm-key'),
  encryptJson: vi.fn().mockReturnValue(Buffer.from('enc')),
  decryptJson: vi.fn().mockReturnValue({ accessToken: 'fake-channel-token' }),
}));

vi.mock('../src/services/safety.service', () => ({
  safetyClassifier: {
    classify: mockSafetyClassify,
    classifyAsync: mockSafetyClassifyAsync,
  },
  SafetyServiceUnavailableError: class SafetyServiceUnavailableError extends Error {},
}));

const CRISIS_REGEX = /suicid|matar|morir|lastim|hacerme da[ñn]o|kill myself|self-harm|hurt myself/i;

const CRISIS_LINES = [
  { name: 'SAPTEL', phone: '55 5259-8121', hours: '24h' },
  { name: 'Linea de la Vida', phone: '800 911 2000', hours: '24h' },
];

const mockBot = {
  id: 'bot-uuid-1',
  name: 'Interprete de suenos',
  orgId: 'org-1',
  status: 'active',
  locale: 'es-MX',
  systemPrompt: 'Eres un interprete de suenos.',
  historyWindow: 5,
  llmProvider: 'anthropic',
  llmModel: 'claude-haiku-4-5-20251001',
  llmApiKeyEnc: Buffer.from('encrypted-key'),
  llmParams: null,
  identity: null,
  onboardingMsg: null,
  updatedAt: new Date(),
  createdAt: new Date(),
  branding: { companyName: 'Test', supportContact: null, privacyPolicyUrl: null, termsUrl: null },
  commands: [],
  crisisConfig: [
    { id: 'cc-1', botId: 'bot-uuid-1', country: 'MX', lines: CRISIS_LINES, enabled: true },
  ],
  knowledge: [],
  integrations: [],
};

const mockChannel = {
  id: 'ch-1',
  botId: 'bot-uuid-1',
  provider: 'meta_cloud',
  phoneId: 'phone-id-123',
  credentials: Buffer.from('encrypted'),
  verifyToken: 'token',
  status: 'connected',
  bot: mockBot,
};

const mockEndUser = {
  id: 'user-1',
  botId: 'bot-uuid-1',
  waPhoneHash: 'hash',
  paused: false,
  consentDeclined: false,
  locale: 'es-MX',
  createdAt: new Date(),
};

const mockConsent = {
  id: 'consent-1',
  endUserId: 'user-1',
  botId: 'bot-uuid-1',
  acceptedAt: new Date(),
  policyVersion: '1.0',
};

function makeJob(text: string): InboundMessageJob {
  return {
    phoneId: 'phone-id-123',
    waMessageId: 'wamid-1',
    from: '+5215551234567',
    messageType: 'text',
    textBody: text,
    timestamp: Date.now(),
  };
}

describe('Crisis flow - LLM is never called', () => {
  let db: {
    endUser: Record<string, ReturnType<typeof vi.fn>>;
    consent: Record<string, ReturnType<typeof vi.fn>>;
    message: Record<string, ReturnType<typeof vi.fn>>;
    crisisEvent: Record<string, ReturnType<typeof vi.fn>>;
  };
  beforeEach(async () => {
    vi.clearAllMocks();
    mockSendText.mockResolvedValue(undefined);
    mockLLMComplete.mockResolvedValue({ text: 'should not appear', usage: {} });
    mockLoadChannel.mockResolvedValue(mockChannel);
    mockSafetyClassify.mockImplementation((text: string) =>
      CRISIS_REGEX.test(text) ? { isCrisis: true, category: 'suicide_risk' } : { isCrisis: false },
    );
    mockSafetyClassifyAsync.mockImplementation(async (text: string) =>
      CRISIS_REGEX.test(text) ? { isCrisis: true, category: 'suicide_risk' } : { isCrisis: false },
    );

    const dbMod = await import('../src/db');
    db = dbMod.db as typeof db;
    db.endUser.upsert.mockResolvedValue(mockEndUser);
    db.consent.findFirst.mockResolvedValue(mockConsent);
    db.crisisEvent.create.mockResolvedValue({});
    db.message.findMany.mockResolvedValue([]);
    db.message.findUnique.mockResolvedValue(null);
    db.message.create.mockResolvedValue({});

  });

  it('does NOT call the LLM when input contains suicide risk (Spanish)', async () => {
    await processInboundMessage(makeJob('quiero suicidarme'));
    expect(getLLMProvider).not.toHaveBeenCalled();
    expect(mockLLMComplete).not.toHaveBeenCalled();
  }, TEST_TIMEOUT_MS);

  it('does NOT call the LLM for self-harm input', async () => {
    await processInboundMessage(makeJob('quiero lastimarme'));
    expect(getLLMProvider).not.toHaveBeenCalled();
    expect(mockLLMComplete).not.toHaveBeenCalled();
  }, TEST_TIMEOUT_MS);

  it('does NOT call the LLM for English crisis input', async () => {
    await processInboundMessage(makeJob('I want to kill myself'));
    expect(getLLMProvider).not.toHaveBeenCalled();
    expect(mockLLMComplete).not.toHaveBeenCalled();
  }, TEST_TIMEOUT_MS);

  it('records a crisis_event in the database', async () => {
    await processInboundMessage(makeJob('me quiero matar'));
    expect(db.crisisEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ botId: 'bot-uuid-1', actionTaken: 'input_detected_pre_consent' }),
      }),
    );
  }, TEST_TIMEOUT_MS);

  it('sends crisis derivation lines from the specific bot config', async () => {
    await processInboundMessage(makeJob('quiero suicidarme'));
    expect(mockSendText).toHaveBeenCalled();
    const sentText: string = mockSendText.mock.calls[0][0].text;
    expect(sentText).toContain('SAPTEL');
    expect(sentText).toContain('55 5259-8121');
    expect(sentText).toContain('Linea de la Vida');
    expect(sentText).toContain('800 911 2000');
  }, TEST_TIMEOUT_MS);

  it('uses fallback Mexico lines when bot has no crisis config', async () => {
    mockLoadChannel.mockResolvedValue({ ...mockChannel, bot: { ...mockBot, crisisConfig: [] } });
    await processInboundMessage(makeJob('quiero morir'));
    expect(mockSendText).toHaveBeenCalled();
    const sentText: string = mockSendText.mock.calls[0][0].text;
    expect(sentText).toContain('SAPTEL');
    expect(sentText).toContain('800 911 2000');
  }, TEST_TIMEOUT_MS);

  it('calls the client LLM normally for non-crisis messages', async () => {
    await processInboundMessage(makeJob('sone que volaba sobre el mar'));
    expect(getLLMProvider).toHaveBeenCalledWith('anthropic');
    expect(mockLLMComplete).toHaveBeenCalled();
  }, TEST_TIMEOUT_MS);

  it('skips everything (including crisis check) for paused bots', async () => {
    mockLoadChannel.mockResolvedValue({ ...mockChannel, bot: { ...mockBot, status: 'paused' } });
    await processInboundMessage(makeJob('quiero suicidarme'));
    expect(db.crisisEvent.create).not.toHaveBeenCalled();
    expect(mockSendText).not.toHaveBeenCalled();
  }, TEST_TIMEOUT_MS);
});

describe('buildCrisisMessage', () => {
  it('formats crisis lines from bot config', async () => {
    const msg = buildCrisisMessage([
      { id: '1', botId: 'b1', country: 'MX', lines: [{ name: 'TEST LINE', phone: '800-000-0000', hours: '24h' }], enabled: true },
    ]);
    expect(msg).toContain('TEST LINE');
    expect(msg).toContain('800-000-0000');
    expect(msg).toContain('(24h)');
  });

  it('returns default Mexico lines when config is empty', async () => {
    const msg = buildCrisisMessage([]);
    expect(msg).toContain('SAPTEL');
    expect(msg).toContain('55 5259-8121');
  });

  it('ignores disabled crisis configs and uses fallback', async () => {
    const msg = buildCrisisMessage([
      { id: '1', botId: 'b1', country: 'MX', lines: [{ name: 'DISABLED', phone: '000', hours: '' }], enabled: false },
    ]);
    expect(msg).not.toContain('DISABLED');
    expect(msg).toContain('SAPTEL');
  });
});
