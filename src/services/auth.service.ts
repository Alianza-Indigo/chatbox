import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config';

export interface TokenPayload {
  sub: string;   // OrgUser.id
  orgId: string;
  role: string;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function isSuperadminEmail(email: string): boolean {
  return config.SUPERADMIN_EMAILS.includes(email.trim().toLowerCase());
}

export function getEffectiveRole(email: string, role: string): string {
  return isSuperadminEmail(email) ? 'superadmin' : role;
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, config.JWT_SECRET, {
    expiresIn: '7d',
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
  });
}

export function verifyToken(token: string): TokenPayload {
  const decoded = jwt.verify(token, config.JWT_SECRET, {
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
    algorithms: ['HS256'],
  });
  if (typeof decoded !== 'object' || decoded === null) throw new Error('Invalid token');
  return decoded as TokenPayload;
}
