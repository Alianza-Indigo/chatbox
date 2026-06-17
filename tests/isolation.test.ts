import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// vi.mock calls are hoisted — must be before any other imports
vi.mock('../src/db', () => ({
  db: {
    bot: { findUnique: vi.fn(), findMany: vi.fn() },
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
const ORG_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const BOT_B = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const tokenA = (role = 'owner') => `Bearer ${signToken({ sub: 'user-a', orgId: ORG_A, role })}`;

// Make the next db.bot.findUnique return a bot owned by ORG_B (triggers 403)
function stubBotB() {
  vi.mocked(db.bot.findUnique).mockResolvedValueOnce({ orgId: ORG_B } as never);
}

describe('Multi-tenant route isolation', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Bot CRUD (/admin/bots/:id)', () => {
    it('GET /:id returns 403 for cross-org bot', async () => {
      stubBotB();
      const res = await app.inject({ method: 'GET', url: `/admin/bots/${BOT_B}`, headers: { authorization: tokenA() } });
      expect(res.statusCode).toBe(403);
    });

    it('PUT /:id returns 403 for cross-org bot', async () => {
      stubBotB();
      const res = await app.inject({
        method: 'PUT', url: `/admin/bots/${BOT_B}`,
        headers: { authorization: tokenA(), 'content-type': 'application/json' },
        payload: { name: 'Hijacked' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('DELETE /:id returns 403 for cross-org bot', async () => {
      stubBotB();
      const res = await app.inject({ method: 'DELETE', url: `/admin/bots/${BOT_B}`, headers: { authorization: tokenA() } });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('Channel routes (/admin/bots/:botId/channels)', () => {
    it('GET channels returns 403 for cross-org bot', async () => {
      vi.mocked(db.bot.findUnique).mockResolvedValueOnce({ orgId: ORG_B } as never);
      const res = await app.inject({ method: 'GET', url: `/admin/bots/${BOT_B}/channels`, headers: { authorization: tokenA() } });
      expect(res.statusCode).toBe(403);
    });

    it('POST channel returns 403 for cross-org bot', async () => {
      vi.mocked(db.bot.findUnique).mockResolvedValueOnce({ orgId: ORG_B } as never);
      const res = await app.inject({
        method: 'POST', url: `/admin/bots/${BOT_B}/channels`,
        headers: { authorization: tokenA(), 'content-type': 'application/json' },
        payload: { provider: 'meta_cloud', phoneId: '1', accessToken: 't', verifyToken: 'v' },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('Knowledge routes (/admin/bots/:botId/knowledge)', () => {
    it('GET knowledge returns 403 for cross-org bot', async () => {
      vi.mocked(db.bot.findUnique).mockResolvedValueOnce({ orgId: ORG_B } as never);
      const res = await app.inject({ method: 'GET', url: `/admin/bots/${BOT_B}/knowledge`, headers: { authorization: tokenA() } });
      expect(res.statusCode).toBe(403);
    });

    it('POST knowledge returns 403 for cross-org bot', async () => {
      vi.mocked(db.bot.findUnique).mockResolvedValueOnce({ orgId: ORG_B } as never);
      const res = await app.inject({
        method: 'POST', url: `/admin/bots/${BOT_B}/knowledge`,
        headers: { authorization: tokenA(), 'content-type': 'application/json' },
        payload: { title: 'Exfiltrated', content: 'secret data' },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('User routes (/admin/bots/:botId/users)', () => {
    it('GET users returns 403 for cross-org bot', async () => {
      vi.mocked(db.bot.findUnique).mockResolvedValueOnce({ orgId: ORG_B } as never);
      const res = await app.inject({ method: 'GET', url: `/admin/bots/${BOT_B}/users`, headers: { authorization: tokenA() } });
      expect(res.statusCode).toBe(403);
    });

    it('GET payments returns 403 for cross-org bot', async () => {
      vi.mocked(db.bot.findUnique).mockResolvedValueOnce({ orgId: ORG_B } as never);
      const res = await app.inject({ method: 'GET', url: `/admin/bots/${BOT_B}/payments`, headers: { authorization: tokenA() } });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('Integration routes (/admin/bots/:botId/integrations)', () => {
    it('GET integrations returns 403 for cross-org bot', async () => {
      vi.mocked(db.bot.findUnique).mockResolvedValueOnce({ orgId: ORG_B } as never);
      const res = await app.inject({ method: 'GET', url: `/admin/bots/${BOT_B}/integrations`, headers: { authorization: tokenA() } });
      expect(res.statusCode).toBe(403);
    });

    it('POST integration returns 403 for cross-org bot', async () => {
      vi.mocked(db.bot.findUnique).mockResolvedValueOnce({ orgId: ORG_B } as never);
      const res = await app.inject({
        method: 'POST', url: `/admin/bots/${BOT_B}/integrations`,
        headers: { authorization: tokenA(), 'content-type': 'application/json' },
        payload: { kind: 'stt', provider: 'openai', apiKey: 'sk-x' },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('Organization routes (/admin/organizations/:id)', () => {
    it('GET /:id returns 403 for different org', async () => {
      const res = await app.inject({ method: 'GET', url: `/admin/organizations/${ORG_B}`, headers: { authorization: tokenA() } });
      expect(res.statusCode).toBe(403);
    });

    it('GET /:id/members returns 403 for different org', async () => {
      const res = await app.inject({ method: 'GET', url: `/admin/organizations/${ORG_B}/members`, headers: { authorization: tokenA() } });
      expect(res.statusCode).toBe(403);
    });

    it('PUT /:id returns 403 for different org', async () => {
      const res = await app.inject({
        method: 'PUT', url: `/admin/organizations/${ORG_B}`,
        headers: { authorization: tokenA(), 'content-type': 'application/json' },
        payload: { name: 'Stolen' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('POST /:id/members returns 403 for different org', async () => {
      const res = await app.inject({
        method: 'POST', url: `/admin/organizations/${ORG_B}/members`,
        headers: { authorization: tokenA(), 'content-type': 'application/json' },
        payload: { email: 'attacker@evil.com', password: 'password1' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('PUT /:id/members/:userId returns 403 for different org', async () => {
      const res = await app.inject({
        method: 'PUT', url: `/admin/organizations/${ORG_B}/members/some-user-id`,
        headers: { authorization: tokenA(), 'content-type': 'application/json' },
        payload: { role: 'owner' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('DELETE /:id/members/:userId returns 403 for different org', async () => {
      const res = await app.inject({
        method: 'DELETE', url: `/admin/organizations/${ORG_B}/members/some-user-id`,
        headers: { authorization: tokenA() },
      });
      expect(res.statusCode).toBe(403);
    });

    it('GET /:id/audit-log returns 403 for different org', async () => {
      const res = await app.inject({ method: 'GET', url: `/admin/organizations/${ORG_B}/audit-log`, headers: { authorization: tokenA() } });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('Unauthenticated access', () => {
    it('returns 401 with no token', async () => {
      const res = await app.inject({ method: 'GET', url: '/admin/bots' });
      expect(res.statusCode).toBe(401);
    });

    it('returns 401 with invalid token', async () => {
      const res = await app.inject({ method: 'GET', url: '/admin/bots', headers: { authorization: 'Bearer invalid.jwt.token' } });
      expect(res.statusCode).toBe(401);
    });
  });
});
