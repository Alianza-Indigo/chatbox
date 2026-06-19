import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Stable mocks ──────────────────────────────────────────────────────────────

const { mockHash, mockCompare } = vi.hoisted(() => ({
  mockHash: vi.fn().mockResolvedValue('$2b$10$hashedpassword'),
  mockCompare: vi.fn().mockResolvedValue(true),
}));

vi.mock('bcryptjs', () => ({
  default: { hash: mockHash, compare: mockCompare },
}));

vi.mock('../src/db', () => ({
  db: {
    orgUser: { findFirst: vi.fn(), create: vi.fn() },
    organization: { create: vi.fn() },
  },
}));

// ─── Imports (after mocks are set up) ─────────────────────────────────────────

import { config } from '../src/config';
import { getEffectiveRole, hashPassword, verifyPassword, signToken, verifyToken } from '../src/services/auth.service';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { requireAuth } from '../src/middleware/auth';

// ── Auth service ──────────────────────────────────────────────────────────────

describe('hashPassword / verifyPassword', () => {
  beforeEach(() => {
    config.SUPERADMIN_EMAILS = [];
  });

  it('calls bcrypt.hash with round=10', async () => {
    await hashPassword('secret');
    expect(mockHash).toHaveBeenCalledWith('secret', 10);
  });

  it('calls bcrypt.compare for verification', async () => {
    await verifyPassword('secret', '$2b$10$hash');
    expect(mockCompare).toHaveBeenCalledWith('secret', '$2b$10$hash');
  });

  it('returns false when password does not match', async () => {
    mockCompare.mockResolvedValueOnce(false);
    const result = await verifyPassword('wrong', '$2b$10$hash');
    expect(result).toBe(false);
  });
});

describe('signToken / verifyToken', () => {
  beforeEach(() => {
    config.SUPERADMIN_EMAILS = [];
  });

  it('roundtrips a token payload', () => {
    const payload = { sub: 'user-1', orgId: 'org-1', role: 'owner' };
    const token = signToken(payload);
    const decoded = verifyToken(token);
    expect(decoded.sub).toBe('user-1');
    expect(decoded.orgId).toBe('org-1');
    expect(decoded.role).toBe('owner');
  });

  it('throws on tampered token', () => {
    const token = signToken({ sub: 'u', orgId: 'o', role: 'editor' });
    expect(() => verifyToken(token + 'tampered')).toThrow();
  });

  it('throws on completely invalid token', () => {
    expect(() => verifyToken('not.a.jwt')).toThrow();
  });

  it('elevates allowlisted emails to superadmin role', () => {
    config.SUPERADMIN_EMAILS = ['mossomex@gmail.com'];
    expect(getEffectiveRole('mossomex@gmail.com', 'owner')).toBe('superadmin');
    expect(getEffectiveRole('otra@empresa.com', 'owner')).toBe('owner');
  });
});

// ── requireAuth middleware ────────────────────────────────────────────────────

function makeReq(headers: Record<string, string> = {}): FastifyRequest {
  return { headers, params: {} } as unknown as FastifyRequest;
}

function makeReply() {
  const reply = {
    _status: 0,
    _body: null as unknown,
    status(code: number) { this._status = code; return this; },
    send(body: unknown) { this._body = body; return this; },
  };
  return reply;
}

describe('requireAuth middleware', () => {
  beforeEach(() => {
    config.SUPERADMIN_EMAILS = [];
  });

  it('sets superadmin user for ADMIN_API_KEY via x-admin-key', async () => {
    const req = makeReq({ 'x-admin-key': 'test-admin-key-must-be-at-least-32-chars-long!!' });
    const reply = makeReply();
    await requireAuth(req, reply as unknown as FastifyReply);
    expect(req.user?.isSuperadmin).toBe(true);
    expect(req.user?.orgId).toBe('*');
    expect(reply._status).toBe(0); // no status set = passed through
  });

  it('sets superadmin user for ADMIN_API_KEY via Authorization Bearer', async () => {
    const req = makeReq({ authorization: 'Bearer test-admin-key-must-be-at-least-32-chars-long!!' });
    const reply = makeReply();
    await requireAuth(req, reply as unknown as FastifyReply);
    expect(req.user?.isSuperadmin).toBe(true);
  });

  it('sets org user for valid JWT', async () => {
    const token = signToken({ sub: 'user-1', orgId: 'org-1', role: 'admin' });
    const req = makeReq({ authorization: `Bearer ${token}` });
    const reply = makeReply();
    await requireAuth(req, reply as unknown as FastifyReply);
    expect(req.user?.userId).toBe('user-1');
    expect(req.user?.orgId).toBe('org-1');
    expect(req.user?.role).toBe('admin');
    expect(req.user?.isSuperadmin).toBe(false);
  });

  it('sets superadmin user for JWT payloads marked as superadmin', async () => {
    const token = signToken({ sub: 'user-1', orgId: 'org-1', role: 'superadmin' });
    const req = makeReq({ authorization: `Bearer ${token}` });
    const reply = makeReply();
    await requireAuth(req, reply as unknown as FastifyReply);
    expect(req.user?.role).toBe('superadmin');
    expect(req.user?.isSuperadmin).toBe(true);
  });

  it('returns 401 for invalid JWT', async () => {
    const req = makeReq({ authorization: 'Bearer invalid.jwt.token' });
    const reply = makeReply();
    await requireAuth(req, reply as unknown as FastifyReply);
    expect(reply._status).toBe(401);
  });

  it('returns 401 when no token provided', async () => {
    const req = makeReq({});
    const reply = makeReply();
    await requireAuth(req, reply as unknown as FastifyReply);
    expect(reply._status).toBe(401);
  });

  it('returns 401 for tampered JWT', async () => {
    const token = signToken({ sub: 'u', orgId: 'o', role: 'editor' });
    const req = makeReq({ authorization: `Bearer ${token}tampered` });
    const reply = makeReply();
    await requireAuth(req, reply as unknown as FastifyReply);
    expect(reply._status).toBe(401);
  });
});
