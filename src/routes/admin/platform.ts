import type { FastifyPluginAsync } from 'fastify';
import { db } from '../../db';
import { getPubClient } from '../../lib/pubsub';
import { dlq } from '../../queue/queue';

type OrgSummaryInput = {
  id: string;
  name: string;
  plan: 'free' | 'pro' | 'enterprise';
  msgQuota: number;
  msgUsed: number;
  createdAt: Date;
};

type BotSummaryInput = {
  id: string;
  orgId: string;
  status: 'draft' | 'active' | 'paused' | 'credential_error';
  llmProvider: string | null;
  channels: Array<{ id: string; provider: string; status: 'connected' | 'pending' | 'error' }>;
};

type PlatformOrgRow = {
  id: string;
  name: string;
  plan: 'free' | 'pro' | 'enterprise';
  createdAt: string;
  botCount: number;
  activeBotCount: number;
  credentialErrorCount: number;
  channelCount: number;
  connectedChannelCount: number;
  msgUsed: number;
  msgQuota: number;
  usageRate: number | null;
  isOperating: boolean;
  issues: string[];
};

function buildOrgRows(orgs: OrgSummaryInput[], bots: BotSummaryInput[]): PlatformOrgRow[] {
  return orgs
    .map((org) => {
      const orgBots = bots.filter((bot) => bot.orgId === org.id);
      const channels = orgBots.flatMap((bot) => bot.channels);
      const activeBotCount = orgBots.filter((bot) => bot.status === 'active').length;
      const credentialErrorCount = orgBots.filter((bot) => bot.status === 'credential_error').length;
      const connectedChannelCount = channels.filter((channel) => channel.status === 'connected').length;
      const usageRate = org.msgQuota > 0 ? org.msgUsed / org.msgQuota : null;
      const issues: string[] = [];

      if (credentialErrorCount > 0) issues.push('credenciales');
      if (orgBots.length > 0 && activeBotCount === 0) issues.push('sin agentes activos');
      if (orgBots.length > 0 && connectedChannelCount === 0) issues.push('sin canal conectado');
      if (usageRate !== null && usageRate >= 0.85) issues.push('cuota alta');

      return {
        id: org.id,
        name: org.name,
        plan: org.plan,
        createdAt: org.createdAt.toISOString(),
        botCount: orgBots.length,
        activeBotCount,
        credentialErrorCount,
        channelCount: channels.length,
        connectedChannelCount,
        msgUsed: org.msgUsed,
        msgQuota: org.msgQuota,
        usageRate,
        isOperating: activeBotCount > 0 || connectedChannelCount > 0 || org.msgUsed > 0,
        issues,
      };
    })
    .sort((a, b) => {
      if (b.issues.length !== a.issues.length) return b.issues.length - a.issues.length;
      if (b.msgUsed !== a.msgUsed) return b.msgUsed - a.msgUsed;
      return a.name.localeCompare(b.name, 'es');
    });
}

const platformRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (req, reply) => {
    if (!req.user?.isSuperadmin) return reply.status(403).send({ error: 'Superadmin only' });
  });

  fastify.get('/platform/summary', async (_req, reply) => {
    const [
      orgs,
      bots,
      endUserCount,
      messageCount,
      knowledgeCount,
      embeddedKnowledgeCount,
      approvedPaymentCount,
      recentActivity,
      dlqCount,
      dbOk,
      redisOk,
    ] = await Promise.all([
      db.organization.findMany({
        select: {
          id: true,
          name: true,
          plan: true,
          msgQuota: true,
          msgUsed: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
      db.bot.findMany({
        select: {
          id: true,
          orgId: true,
          status: true,
          llmProvider: true,
          channels: {
            select: {
              id: true,
              provider: true,
              status: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      db.endUser.count(),
      db.message.count(),
      db.botKnowledge.count(),
      db.botKnowledge.count({ where: { hasEmbedding: true } }),
      db.payment.count({ where: { status: 'approved' } }),
      db.auditLog.findMany({
        take: 8,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          orgId: true,
          actorRole: true,
          action: true,
          targetType: true,
          targetId: true,
          createdAt: true,
        },
      }),
      dlq.getWaitingCount(),
      db.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
      getPubClient().ping().then(() => true).catch(() => false),
    ]);

    const orgRows = buildOrgRows(orgs, bots);
    const orgNameById = new Map(orgs.map((org) => [org.id, org.name]));

    const totalQuota = orgRows.reduce((sum, org) => sum + org.msgQuota, 0);
    const totalUsed = orgRows.reduce((sum, org) => sum + org.msgUsed, 0);
    const totalChannels = orgRows.reduce((sum, org) => sum + org.channelCount, 0);
    const connectedChannels = orgRows.reduce((sum, org) => sum + org.connectedChannelCount, 0);
    const activeBots = orgRows.reduce((sum, org) => sum + org.activeBotCount, 0);
    const operatingOrgs = orgRows.filter((org) => org.isOperating).length;
    const attentionOrgs = orgRows.filter((org) => org.issues.length > 0);
    const quotaPressureOrgs = orgRows.filter((org) => org.usageRate !== null && org.usageRate >= 0.85).length;
    const credentialErrorBots = orgRows.reduce((sum, org) => sum + org.credentialErrorCount, 0);

    const botStatusCounts = bots.reduce<Record<string, number>>((acc, bot) => {
      acc[bot.status] = (acc[bot.status] ?? 0) + 1;
      return acc;
    }, {});

    const planCounts = orgs.reduce<Record<string, number>>((acc, org) => {
      acc[org.plan] = (acc[org.plan] ?? 0) + 1;
      return acc;
    }, {});

    const providerCounts = bots.reduce<Record<string, number>>((acc, bot) => {
      const provider = bot.llmProvider ?? 'sin_configurar';
      acc[provider] = (acc[provider] ?? 0) + 1;
      return acc;
    }, {});

    return reply.send({
      generatedAt: new Date().toISOString(),
      overview: {
        organizationCount: orgs.length,
        operatingOrganizationCount: operatingOrgs,
        organizationsNeedingAttention: attentionOrgs.length,
        botCount: bots.length,
        activeBotCount: activeBots,
        credentialErrorBotCount: credentialErrorBots,
        totalChannelCount: totalChannels,
        connectedChannelCount: connectedChannels,
        totalQuota,
        totalUsed,
        quotaPressureOrganizationCount: quotaPressureOrgs,
        dlqCount,
        endUserCount,
        messageCount,
        knowledgeItemCount: knowledgeCount,
        embeddedKnowledgeCount,
        approvedPaymentCount,
      },
      health: {
        status: dbOk && redisOk ? 'ok' : 'degraded',
        api: 'ok',
        db: dbOk,
        redis: redisOk,
        dlqCount,
      },
      charts: {
        topUsageOrganizations: orgRows
          .slice()
          .sort((a, b) => b.msgUsed - a.msgUsed)
          .slice(0, 6)
          .map((org) => ({
            id: org.id,
            name: org.name,
            used: org.msgUsed,
          })),
        botStatuses: Object.entries(botStatusCounts).map(([name, value]) => ({ name, value })),
        planDistribution: Object.entries(planCounts).map(([name, value]) => ({ name, value })),
        providerDistribution: Object.entries(providerCounts).map(([name, value]) => ({ name, value })),
      },
      organizations: {
        rows: orgRows,
        attention: attentionOrgs.slice(0, 5),
      },
      recentActivity: recentActivity.map((entry) => ({
        ...entry,
        createdAt: entry.createdAt.toISOString(),
        orgName: entry.orgId ? (orgNameById.get(entry.orgId) ?? null) : null,
      })),
    });
  });
};

export default platformRoutes;
