import type { FastifyPluginAsync } from 'fastify';
import { db } from '../db';
import { hashPassword, verifyPassword, signToken } from '../services/auth.service';
import { parseBody, RegisterSchema, LoginSchema } from '../lib/validate';
import { logAudit } from '../services/audit.service';

const authRoutes: FastifyPluginAsync = async (fastify) => {
  // Create org + owner account — 5 registrations per hour per IP
  fastify.post('/register', { config: { rateLimit: { max: 5, timeWindow: 60 * 60 * 1000 } } }, async (req, reply) => {
    const body = parseBody(RegisterSchema, req.body);
    const email = body.email.trim().toLowerCase();

    const existing = await db.orgUser.findFirst({ where: { email } });
    if (existing) return reply.status(409).send({ error: 'Email already registered' });

    const passwordHash = await hashPassword(body.password);

    // Wrap org + user creation in a transaction — partial failure leaves no orphaned org
    const { org, user } = await db.$transaction(async (tx) => {
      const org = await tx.organization.create({ data: { name: body.orgName } });
      const user = await tx.orgUser.create({
        data: { orgId: org.id, email, passwordHash, role: 'owner' },
      });
      return { org, user };
    });

    const token = signToken({ sub: user.id, orgId: org.id, role: 'owner' });
    return reply.status(201).send({ token, orgId: org.id, userId: user.id });
  });

  // Login — 10 attempts per 15 minutes per IP
  fastify.post('/login', { config: { rateLimit: { max: 10, timeWindow: 15 * 60 * 1000 } } }, async (req, reply) => {
    const body = parseBody(LoginSchema, req.body);
    const email = body.email.trim().toLowerCase();

    const user = await db.orgUser.findFirst({ where: { email } });
    if (!user) return reply.status(401).send({ error: 'Invalid credentials' });

    const valid = await verifyPassword(body.password, user.passwordHash);
    if (!valid) return reply.status(401).send({ error: 'Invalid credentials' });

    const token = signToken({ sub: user.id, orgId: user.orgId, role: user.role });
    logAudit({
      orgId: user.orgId,
      actorId: user.id,
      actorRole: user.role,
      action: 'auth.login',
      targetType: 'org_user',
      targetId: user.id,
      ip: req.ip,
    });
    return reply.send({ token, orgId: user.orgId, userId: user.id, role: user.role, expiresIn: '7d' });
  });
};

export default authRoutes;
