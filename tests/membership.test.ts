import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../src/db', () => ({
  db: {
    endUser: { update: vi.fn(), findUnique: vi.fn() },
    payment: { create: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    bot: { findUnique: vi.fn() },
  },
}));

vi.mock('../src/config', () => ({
  config: { PUBLIC_BASE_URL: 'https://api.test', META_API_VERSION: 'v21.0' },
}));

vi.mock('../src/crypto', () => ({
  decryptJson: vi.fn(() => ({ apiKey: 'mp-token' })),
}));

const mockCreateCheckout = vi.fn();
const mockGetPayment = vi.fn();
vi.mock('../src/providers/payments', () => ({
  getPaymentProvider: vi.fn(() => ({ createCheckout: mockCreateCheckout, getPayment: mockGetPayment })),
}));

vi.mock('../src/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));

import {
  getMembershipConfig,
  evaluateMembership,
  activateMembership,
  consumeFreeCredit,
  createCheckoutLink,
  reconcilePayment,
  buildPaywallMessage,
} from '../src/services/membership.service';

const CFG = { freeMessages: 3, durationDays: 30, price: 99, currency: 'MXN', title: 'Membresía' };

describe('getMembershipConfig', () => {
  it('returns null in traditional mode (no identity / membership absent / disabled)', () => {
    expect(getMembershipConfig({ identity: null })).toBeNull();
    expect(getMembershipConfig({ identity: {} })).toBeNull();
    expect(getMembershipConfig({ identity: { membership: { enabled: false } } })).toBeNull();
  });

  it('applies defaults when enabled with no overrides', () => {
    const cfg = getMembershipConfig({ identity: { membership: { enabled: true } } });
    expect(cfg).toEqual({ freeMessages: 10, durationDays: 30, price: 0, currency: 'MXN', title: 'Membresía', paywallMessage: undefined });
  });

  it('parses explicit values', () => {
    const cfg = getMembershipConfig({ identity: { membership: { enabled: true, freeMessages: 5, durationDays: 7, price: 49, currency: 'USD', title: 'Pro', paywallMessage: 'paga' } } });
    expect(cfg).toMatchObject({ freeMessages: 5, durationDays: 7, price: 49, currency: 'USD', title: 'Pro', paywallMessage: 'paga' });
  });
});

describe('evaluateMembership', () => {
  const now = new Date('2026-06-16T00:00:00Z');

  it('allows via active membership without consuming free credit', () => {
    const future = new Date(now.getTime() + 1000);
    expect(evaluateMembership({ freeMsgUsed: 999, membershipUntil: future }, CFG, now)).toEqual({ allowed: true, viaFree: false });
  });

  it('allows via free tier while under the limit', () => {
    expect(evaluateMembership({ freeMsgUsed: 0, membershipUntil: null }, CFG, now)).toEqual({ allowed: true, viaFree: true });
    expect(evaluateMembership({ freeMsgUsed: 2, membershipUntil: null }, CFG, now)).toEqual({ allowed: true, viaFree: true });
  });

  it('blocks once the free limit is reached and membership is expired', () => {
    const past = new Date(now.getTime() - 1000);
    expect(evaluateMembership({ freeMsgUsed: 3, membershipUntil: null }, CFG, now)).toEqual({ allowed: false });
    expect(evaluateMembership({ freeMsgUsed: 3, membershipUntil: past }, CFG, now)).toEqual({ allowed: false });
  });
});

describe('activateMembership', () => {
  let db: { endUser: Record<string, ReturnType<typeof vi.fn>> };
  beforeEach(async () => {
    vi.clearAllMocks();
    db = (await import('../src/db')).db as never;
    db.endUser.update.mockResolvedValue({});
  });

  it('starts from now when there is no active membership', async () => {
    const now = new Date('2026-06-16T00:00:00Z');
    db.endUser.findUnique.mockResolvedValue({ membershipUntil: null });
    const until = await activateMembership('eu-1', 30, now);
    expect(until.getTime()).toBe(now.getTime() + 30 * 86400000);
    expect(db.endUser.update).toHaveBeenCalledWith({ where: { id: 'eu-1' }, data: { membershipUntil: until } });
  });

  it('extends from the current expiry when still active', async () => {
    const now = new Date('2026-06-16T00:00:00Z');
    const current = new Date(now.getTime() + 10 * 86400000);
    db.endUser.findUnique.mockResolvedValue({ membershipUntil: current });
    const until = await activateMembership('eu-1', 30, now);
    expect(until.getTime()).toBe(current.getTime() + 30 * 86400000);
  });
});

describe('consumeFreeCredit', () => {
  it('atomically increments the free counter', async () => {
    const db = (await import('../src/db')).db as never as { endUser: { update: ReturnType<typeof vi.fn> } };
    db.endUser.update.mockResolvedValue({});
    await consumeFreeCredit('eu-1');
    expect(db.endUser.update).toHaveBeenCalledWith({ where: { id: 'eu-1' }, data: { freeMsgUsed: { increment: 1 } } });
  });
});

describe('createCheckoutLink', () => {
  let db: { payment: Record<string, ReturnType<typeof vi.fn>> };
  const bot = { id: 'bot-1', branding: { website: 'https://shop.test' }, integrations: [{ kind: 'payments', provider: 'mercadopago', status: 'active', credentials: Buffer.from('x') }] as never };

  beforeEach(async () => {
    vi.clearAllMocks();
    db = (await import('../src/db')).db as never;
  });

  it('returns null when the bot has no active payments integration', async () => {
    const url = await createCheckoutLink({ id: 'bot-1', integrations: [], branding: null }, 'eu-1', CFG);
    expect(url).toBeNull();
  });

  it('reuses a recent pending checkout link', async () => {
    db.payment.findFirst.mockResolvedValue({ checkoutUrl: 'https://mp/old' });
    const url = await createCheckoutLink(bot, 'eu-1', CFG);
    expect(url).toBe('https://mp/old');
    expect(db.payment.create).not.toHaveBeenCalled();
  });

  it('creates a new preference and persists the URL when none is pending', async () => {
    db.payment.findFirst.mockResolvedValue(null);
    db.payment.create.mockResolvedValue({ id: 'pay-1' });
    db.payment.update.mockResolvedValue({});
    mockCreateCheckout.mockResolvedValue({ providerRef: 'pref-1', url: 'https://mp/new' });

    const url = await createCheckoutLink(bot, 'eu-1', CFG);

    expect(url).toBe('https://mp/new');
    expect(mockCreateCheckout).toHaveBeenCalledWith(expect.objectContaining({
      externalReference: 'pay-1',
      notificationUrl: 'https://api.test/webhook/payments/mercadopago/bot-1',
      successUrl: 'https://shop.test',
    }));
    expect(db.payment.update).toHaveBeenCalledWith({ where: { id: 'pay-1' }, data: { providerRef: 'pref-1', checkoutUrl: 'https://mp/new' } });
  });
});

describe('reconcilePayment', () => {
  let db: { bot: Record<string, ReturnType<typeof vi.fn>>; payment: Record<string, ReturnType<typeof vi.fn>>; endUser: Record<string, ReturnType<typeof vi.fn>> };
  const botRow = { orgId: 'org-1', integrations: [{ kind: 'payments', provider: 'mercadopago', status: 'active', credentials: Buffer.from('x') }] };

  beforeEach(async () => {
    vi.clearAllMocks();
    db = (await import('../src/db')).db as never;
    db.endUser.update.mockResolvedValue({});
    db.endUser.findUnique.mockResolvedValue({ membershipUntil: null });
  });

  it('activates membership on an approved payment', async () => {
    db.bot.findUnique.mockResolvedValue(botRow);
    mockGetPayment.mockResolvedValue({ status: 'approved', externalReference: 'pay-1' });
    db.payment.findUnique.mockResolvedValue({ id: 'pay-1', botId: 'bot-1', endUserId: 'eu-1', status: 'pending', membershipDays: 30 });
    db.payment.update.mockResolvedValue({});

    const out = await reconcilePayment('bot-1', 'mercadopago', '12345');

    expect(out).toEqual({ activated: true, orgId: 'org-1' });
    expect(db.endUser.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'eu-1' } }));
    expect(db.payment.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'pay-1' }, data: expect.objectContaining({ status: 'approved' }) }));
  });

  it('is idempotent for an already-approved payment', async () => {
    db.bot.findUnique.mockResolvedValue(botRow);
    mockGetPayment.mockResolvedValue({ status: 'approved', externalReference: 'pay-1' });
    db.payment.findUnique.mockResolvedValue({ id: 'pay-1', botId: 'bot-1', endUserId: 'eu-1', status: 'approved', membershipDays: 30 });

    const out = await reconcilePayment('bot-1', 'mercadopago', '12345');
    expect(out.activated).toBe(false);
    expect(db.endUser.update).not.toHaveBeenCalled();
  });

  it('does not activate when the provider reports a non-approved status', async () => {
    db.bot.findUnique.mockResolvedValue(botRow);
    mockGetPayment.mockResolvedValue({ status: 'pending', externalReference: 'pay-1' });

    const out = await reconcilePayment('bot-1', 'mercadopago', '12345');
    expect(out.activated).toBe(false);
    expect(db.payment.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a payment whose reference belongs to another bot', async () => {
    db.bot.findUnique.mockResolvedValue(botRow);
    mockGetPayment.mockResolvedValue({ status: 'approved', externalReference: 'pay-1' });
    db.payment.findUnique.mockResolvedValue({ id: 'pay-1', botId: 'other-bot', endUserId: 'eu-9', status: 'pending', membershipDays: 30 });

    const out = await reconcilePayment('bot-1', 'mercadopago', '12345');
    expect(out.activated).toBe(false);
    expect(db.endUser.update).not.toHaveBeenCalled();
  });
});

describe('buildPaywallMessage', () => {
  it('includes the checkout link and price when available', () => {
    const msg = buildPaywallMessage(CFG, 'https://mp/pay');
    expect(msg).toContain('https://mp/pay');
    expect(msg).toContain('99 MXN');
    expect(msg).toContain('30 días');
  });

  it('falls back to a contact-the-business message without a link', () => {
    const msg = buildPaywallMessage(CFG, null);
    expect(msg).not.toContain('http');
    expect(msg.toLowerCase()).toContain('contacta');
  });
});
