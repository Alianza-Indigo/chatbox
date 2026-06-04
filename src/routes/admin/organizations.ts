import type { FastifyPluginAsync } from 'fastify';
import { db } from '../../db';
import { hashPassword } from '../../services/auth.service';
import { requirePermission } from '../../lib/rbac';
import { logAudit } from '../../services/audit.service';
import { parseBody, CreateOrgSchema, UpdateOrgSchema, InviteMemberSchema, UpdateMemberRoleSchema } from '../../lib/validate';

const orgRoutes: FastifyPluginAsync = async (fastify) => {
  // List orgs — superadmin sees all, org users see only their own
  fastify.get('/', async (req, reply) => {
    if (req.user!.isSuperadmin) {
      return reply.send(await db.organization.findMany({ orderBy: { createdAt: 'desc' } }));
    }
    const org = await db.organization.findUnique({ where: { id: req.user!.orgId } });
    return reply.send(org ? [org] : []);
  });

  // Create org — superadmin only (regular users create via POST /auth/register)
  fastify.post('/', async (req, reply) => {
    if (!req.user!.isSuperadmin) return reply.status(403).send({ error: 'Forbidden' });
    const { name, plan, msgQuota } = parseBody(CreateOrgSchema, req.body);
    const org = await db.organization.create({ data: { name, plan: plan ?? 'free', msgQuota: msgQuota ?? 1000 } });
    return reply.status(201).send(org);
  });

  // Get single org
  fastify.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    if (!req.user!.isSuperadmin && req.user!.orgId !== req.params.id) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
    const org = await db.organization.findUnique({
      where: { id: req.params.id },
      include: { bots: { select: { id: true, name: true, status: true, createdAt: true } } },
    });
    if (!org) return reply.status(404).send({ error: 'Organization not found' });
    return reply.send(org);
  });

  // Update org
  fastify.put<{ Params: { id: string } }>('/:id', async (req, reply) => {
    if (!req.user!.isSuperadmin && req.user!.orgId !== req.params.id) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
    const { name, plan, msgQuota } = parseBody(UpdateOrgSchema, req.body);
    const data: Record<string, unknown> = {};
    if (name !== undefined) data.name = name;
    // Only superadmin can change plan/quota
    if (req.user!.isSuperadmin) {
      if (plan !== undefined) data.plan = plan;
      if (msgQuota !== undefined) data.msgQuota = msgQuota;
    }
    const org = await db.organization.update({ where: { id: req.params.id }, data });
    return reply.send(org);
  });

  // Delete org — superadmin only
  fastify.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    if (!req.user!.isSuperadmin) return reply.status(403).send({ error: 'Forbidden' });
    await db.organization.delete({ where: { id: req.params.id } });
    return reply.status(204).send();
  });

  // ── Members ───────────────────────────────────────────────────────────────

  fastify.get<{ Params: { id: string } }>('/:id/members', async (req, reply) => {
    if (!req.user!.isSuperadmin && req.user!.orgId !== req.params.id) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
    const members = await db.orgUser.findMany({
      where: { orgId: req.params.id },
      select: { id: true, email: true, role: true, createdAt: true },
    });
    return reply.send(members);
  });

  // Invite member to org
  fastify.post<{ Params: { id: string } }>('/:id/members', { preHandler: [requirePermission('member:invite')] }, async (req, reply) => {
    if (!req.user!.isSuperadmin && req.user!.orgId !== req.params.id) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
    const { email, password, role } = parseBody(InviteMemberSchema, req.body);
    const existing = await db.orgUser.findFirst({ where: { email: email.trim().toLowerCase() } });
    if (existing) return reply.status(409).send({ error: 'Email already registered' });

    const passwordHash = await hashPassword(password);
    const user = await db.orgUser.create({
      data: { orgId: req.params.id, email: email.trim().toLowerCase(), passwordHash, role: role ?? 'editor' },
      select: { id: true, email: true, role: true, createdAt: true },
    });
    logAudit({
      orgId: req.params.id,
      actorId: req.user!.isSuperadmin ? undefined : req.user!.userId,
      actorRole: req.user!.isSuperadmin ? 'superadmin' : req.user!.role,
      action: 'member.invite',
      targetType: 'org_user',
      targetId: user.id,
      ip: req.ip,
    });
    return reply.status(201).send(user);
  });

  // Change member role
  fastify.put<{ Params: { id: string; userId: string } }>('/:id/members/:userId', { preHandler: [requirePermission('member:change-role')] }, async (req, reply) => {
    if (!req.user!.isSuperadmin && req.user!.orgId !== req.params.id) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
    const { role } = parseBody(UpdateMemberRoleSchema, req.body);
    // Verify the target user actually belongs to this org
    const target = await db.orgUser.findUnique({ where: { id: req.params.userId }, select: { orgId: true } });
    if (!target || target.orgId !== req.params.id) {
      return reply.status(404).send({ error: 'Member not found in this organization' });
    }
    const user = await db.orgUser.update({
      where: { id: req.params.userId },
      data: { role },
      select: { id: true, email: true, role: true },
    });
    logAudit({
      orgId: req.params.id,
      actorId: req.user!.isSuperadmin ? undefined : req.user!.userId,
      actorRole: req.user!.isSuperadmin ? 'superadmin' : req.user!.role,
      action: 'member.change_role',
      targetType: 'org_user',
      targetId: req.params.userId,
      metadata: { role },
      ip: req.ip,
    });
    return reply.send(user);
  });

  // Remove member
  fastify.delete<{ Params: { id: string; userId: string } }>('/:id/members/:userId', { preHandler: [requirePermission('member:remove')] }, async (req, reply) => {
    if (!req.user!.isSuperadmin && req.user!.orgId !== req.params.id) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
    // Verify the target user actually belongs to this org
    const target = await db.orgUser.findUnique({ where: { id: req.params.userId }, select: { orgId: true } });
    if (!target || target.orgId !== req.params.id) {
      return reply.status(404).send({ error: 'Member not found in this organization' });
    }
    await db.orgUser.delete({ where: { id: req.params.userId } });
    logAudit({
      orgId: req.params.id,
      actorId: req.user!.isSuperadmin ? undefined : req.user!.userId,
      actorRole: req.user!.isSuperadmin ? 'superadmin' : req.user!.role,
      action: 'member.remove',
      targetType: 'org_user',
      targetId: req.params.userId,
      ip: req.ip,
    });
    return reply.status(204).send();
  });
  // Audit log — owners and superadmins only
  fastify.get<{ Params: { id: string }; Querystring: { limit?: string; before?: string } }>('/:id/audit-log', async (req, reply) => {
    if (!req.user!.isSuperadmin && req.user!.orgId !== req.params.id) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
    if (!req.user!.isSuperadmin && req.user!.role !== 'owner') {
      return reply.status(403).send({ error: 'Requires owner role' });
    }
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const before = req.query.before ? new Date(req.query.before) : undefined;

    const entries = await db.auditLog.findMany({
      where: {
        orgId: req.params.id,
        ...(before ? { createdAt: { lt: before } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return reply.send(entries);
  });
};

export default orgRoutes;
