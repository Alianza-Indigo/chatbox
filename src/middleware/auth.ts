import { timingSafeEqual } from 'crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken } from '../services/auth.service';
import { config } from '../config';

export interface AuthUser {
  userId: string;
  orgId: string;      // '*' means superadmin (no org restriction)
  role: string;
  isSuperadmin: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

function isValidAdminKey(token: string): boolean {
  const tokenBuf = Buffer.from(token);
  const keyBuf = Buffer.from(config.ADMIN_API_KEY);
  // Length check first (timingSafeEqual requires same length)
  if (tokenBuf.length !== keyBuf.length) return false;
  return timingSafeEqual(tokenBuf, keyBuf);
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const rawKey = req.headers['x-admin-key'] as string | undefined;
  const bearerToken = req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  const token = rawKey ?? bearerToken;

  if (!token) return reply.status(401).send({ error: 'Unauthorized' });

  if (isValidAdminKey(token)) {
    req.user = { userId: 'superadmin', orgId: '*', role: 'owner', isSuperadmin: true };
    return;
  }

  try {
    const payload = verifyToken(token);
    req.user = {
      userId: payload.sub,
      orgId: payload.orgId,
      role: payload.role,
      isSuperadmin: payload.role === 'superadmin',
    };
  } catch {
    return reply.status(401).send({ error: 'Unauthorized' });
  }
}
