import type { FastifyPluginAsync } from 'fastify';
import { db } from '../../db';
import { decrypt, encrypt, getStoredKid } from '../../crypto';
import { config } from '../../config';
import { logAudit } from '../../services/audit.service';

// Re-encryption helper: returns new ciphertext only if blob uses an old KID.
// Returns null when the blob is already on the current KID (skip signal).
function reencryptBlob(data: Buffer, currentKid: number): Buffer | null {
  if (getStoredKid(data) === currentKid) return null;
  return encrypt(decrypt(data));
}

const cryptoRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (req, reply) => {
    if (!req.user?.isSuperadmin) return reply.status(403).send({ error: 'Superadmin only' });
  });

  /**
   * POST /admin/crypto/reencrypt
   *
   * Batch re-encrypt all credentials with the current KID.
   * Run this after setting ENCRYPTION_CURRENT_KID to a new key to complete
   * the key rotation. Idempotent: blobs already on the current KID are skipped.
   *
   * Does NOT re-encrypt Message.bodyEnc — messages are high-volume and require
   * an async paginated backfill, not a synchronous HTTP handler.
   */
  fastify.post('/crypto/reencrypt', async (req, reply) => {
    const currentKid = config.ENCRYPTION_CURRENT_KID;
    let reencrypted = 0;
    let skipped = 0;
    let failed = 0;

    // ── Bot LLM API keys ──────────────────────────────────────────────────────
    const bots = await db.bot.findMany({
      where: { llmApiKeyEnc: { not: null } },
      select: { id: true, llmApiKeyEnc: true },
    });
    for (const bot of bots) {
      try {
        const newEnc = reencryptBlob(bot.llmApiKeyEnc as Buffer, currentKid);
        if (!newEnc) { skipped++; continue; }
        await db.bot.update({ where: { id: bot.id }, data: { llmApiKeyEnc: newEnc } });
        reencrypted++;
      } catch { failed++; }
    }

    // ── Channel credentials ───────────────────────────────────────────────────
    const channels = await db.channel.findMany({
      select: { id: true, credentials: true },
    });
    for (const ch of channels) {
      try {
        const newEnc = reencryptBlob(ch.credentials as Buffer, currentKid);
        if (!newEnc) { skipped++; continue; }
        await db.channel.update({ where: { id: ch.id }, data: { credentials: newEnc } });
        reencrypted++;
      } catch { failed++; }
    }

    // ── Integration credentials ───────────────────────────────────────────────
    const integrations = await db.botIntegration.findMany({
      select: { id: true, credentials: true },
    });
    for (const intg of integrations) {
      try {
        const newEnc = reencryptBlob(intg.credentials as Buffer, currentKid);
        if (!newEnc) { skipped++; continue; }
        await db.botIntegration.update({ where: { id: intg.id }, data: { credentials: newEnc } });
        reencrypted++;
      } catch { failed++; }
    }

    // ── Org Sentry DSNs ───────────────────────────────────────────────────────
    const orgs = await db.organization.findMany({
      where: { sentryDsnEnc: { not: null } },
      select: { id: true, sentryDsnEnc: true },
    });
    for (const org of orgs) {
      try {
        const newEnc = reencryptBlob(org.sentryDsnEnc as Buffer, currentKid);
        if (!newEnc) { skipped++; continue; }
        await db.organization.update({ where: { id: org.id }, data: { sentryDsnEnc: newEnc } });
        reencrypted++;
      } catch { failed++; }
    }

    logAudit({
      orgId: req.user!.orgId ?? 'system',
      actorId: req.user!.userId,
      actorRole: 'superadmin',
      action: 'crypto.reencrypt',
      targetType: 'system',
      targetId: 'all',
      ip: req.ip,
      metadata: { currentKid, reencrypted, skipped, failed },
    });

    return reply.send({
      currentKid,
      reencrypted,
      skipped,
      failed,
      note: 'Message bodies (Message.bodyEnc) are not included — re-encrypt them via a separate async backfill job to avoid request timeouts on large datasets.',
    });
  });
};

export default cryptoRoutes;
