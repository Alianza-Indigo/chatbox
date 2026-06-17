import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/db', () => ({
  db: {
    bot: { findUnique: vi.fn() },
    channel: { findUnique: vi.fn(), findMany: vi.fn() },
    botKnowledge: { findMany: vi.fn() },
    botIntegration: { findMany: vi.fn() },
    endUser: { findMany: vi.fn() },
    payment: { findMany: vi.fn() },
    crisisEvent: { findMany: vi.fn() },
    organization: { findUnique: vi.fn(), findMany: vi.fn() },
    orgUser: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]) },
    $queryRaw: vi.fn().mockResolvedValue([{}]),
  },
}));

vi.mock('../src/lib/pubsub', () => ({
  getPubClient: vi.fn(() => ({
    ping: vi.fn().mockResolvedValue('PONG'),
    publish: vi.fn().mockResolvedValue(0),
  })),
  getSubClient: vi.fn(() => ({ subscribe: vi.fn() })),
  closePubSub: vi.fn(),
  CACHE_INVALIDATE_CHANNEL: 'bot:cache:invalidate',
}));

vi.mock('../src/queue/queue', () => ({
  messageQueue: { add: vi.fn() },
  MESSAGE_QUEUE: 'messages',
  redisConnection: {},
  dlq: {
    add: vi.fn(),
    getJobs: vi.fn().mockResolvedValue([]),
    getJobCounts: vi.fn().mockResolvedValue({ waiting: 0 }),
  },
}));

import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { db } from '../src/db';
import { signToken } from '../src/services/auth.service';

const ORG_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BOT_A = '11111111-1111-1111-1111-111111111111';
const USER_A = '22222222-2222-2222-2222-222222222222';
const tokenA = () => `Bearer ${signToken({ sub: 'user-a', orgId: ORG_A, role: 'owner' })}`;

describe('Membership visibility routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.bot.findUnique).mockResolvedValue({ orgId: ORG_A } as never);
  });

  it('lists end-users with membership visibility fields', async () => {
    vi.mocked(db.endUser.findMany).mockResolvedValue([
      {
        id: USER_A,
        botId: BOT_A,
        locale: 'es-MX',
        paused: false,
        freeMsgUsed: 3,
        membershipUntil: new Date('2026-07-01T00:00:00Z'),
        createdAt: new Date('2026-06-01T00:00:00Z'),
      },
    ] as never);

    const res = await app.inject({ method: 'GET', url: `/admin/bots/${BOT_A}/users`, headers: { authorization: tokenA() } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      expect.objectContaining({
        id: USER_A,
        freeMsgUsed: 3,
        membershipUntil: '2026-07-01T00:00:00.000Z',
      }),
    ]);
  });

  it('lists payments with filters and numeric amount', async () => {
    vi.mocked(db.payment.findMany).mockResolvedValue([
      {
        id: 'pay-1',
        botId: BOT_A,
        endUserId: USER_A,
        provider: 'mercadopago',
        status: 'approved',
        amount: { toNumber: () => 99 } as never,
        currency: 'MXN',
        createdAt: new Date('2026-06-16T00:00:00Z'),
        paidAt: new Date('2026-06-16T00:05:00Z'),
      },
    ] as never);

    const res = await app.inject({
      method: 'GET',
      url: `/admin/bots/${BOT_A}/payments?status=approved&endUserId=${USER_A}&limit=20`,
      headers: { authorization: tokenA() },
    });

    expect(res.statusCode).toBe(200);
    expect(db.payment.findMany).toHaveBeenCalledWith({
      where: { botId: BOT_A, status: 'approved', endUserId: USER_A },
      select: {
        id: true,
        botId: true,
        endUserId: true,
        provider: true,
        status: true,
        amount: true,
        currency: true,
        createdAt: true,
        paidAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    expect(res.json()).toEqual([
      expect.objectContaining({
        id: 'pay-1',
        amount: 99,
        status: 'approved',
        currency: 'MXN',
      }),
    ]);
  });
});
