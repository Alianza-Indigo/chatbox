import { db } from '../db';
import { config } from '../config';
import { decryptJson } from '../crypto';
import { logger } from '../logger';
import { getPaymentProvider } from '../providers/payments';
import type { BotIntegration } from '@prisma/client';

// ─── Config (lives in Bot.identity.membership — no schema change for the toggle) ──
//
// Traditional mode  → identity.membership absent or { enabled: false }: no paywall.
// Microsaas mode    → identity.membership.enabled === true: each end-user gets
//                     `freeMessages` lifetime interactions, then must buy a
//                     time-based membership lasting `durationDays`.

export interface MembershipConfig {
  freeMessages: number;
  durationDays: number;
  price: number;
  currency: string;
  title: string;
  paywallMessage?: string;
}

const DEFAULTS = {
  freeMessages: 10,
  durationDays: 30,
  price: 0,
  currency: 'MXN',
  title: 'Membresía',
};

/** Returns the membership config when the bot is in microsaas mode, else null. */
export function getMembershipConfig(bot: { identity: unknown }): MembershipConfig | null {
  const identity = bot.identity as Record<string, unknown> | null;
  const m = identity?.membership as Record<string, unknown> | undefined;
  if (!m || m.enabled !== true) return null;

  const num = (v: unknown, fallback: number) => (typeof v === 'number' && v >= 0 ? v : fallback);
  const str = (v: unknown, fallback: string) => (typeof v === 'string' && v.length > 0 ? v : fallback);

  return {
    freeMessages: num(m.freeMessages, DEFAULTS.freeMessages),
    durationDays: num(m.durationDays, DEFAULTS.durationDays),
    price: num(m.price, DEFAULTS.price),
    currency: str(m.currency, DEFAULTS.currency),
    title: str(m.title, DEFAULTS.title),
    paywallMessage: typeof m.paywallMessage === 'string' ? m.paywallMessage : undefined,
  };
}

// ─── Eligibility ──────────────────────────────────────────────────────────────

export type MembershipDecision =
  | { allowed: true; viaFree: boolean }
  | { allowed: false };

/**
 * Read-only eligibility check. Per-user state is read from the freshly-upserted
 * EndUser, and the per-conversation mutex serializes a user's messages, so no
 * atomic increment is needed here — the free credit is consumed only after a
 * successful reply (see consumeFreeCredit).
 */
export function evaluateMembership(
  endUser: { freeMsgUsed: number; membershipUntil: Date | null },
  cfg: MembershipConfig,
  now: Date = new Date(),
): MembershipDecision {
  if (endUser.membershipUntil && endUser.membershipUntil.getTime() > now.getTime()) {
    return { allowed: true, viaFree: false };
  }
  if (endUser.freeMsgUsed < cfg.freeMessages) {
    return { allowed: true, viaFree: true };
  }
  return { allowed: false };
}

/** Consume one lifetime free interaction. Called after a reply was delivered. */
export async function consumeFreeCredit(endUserId: string): Promise<void> {
  await db.endUser.update({
    where: { id: endUserId },
    data: { freeMsgUsed: { increment: 1 } },
  });
}

/** Activate (or extend) a time-based membership. Extends from the later of now/current expiry. */
export async function activateMembership(endUserId: string, durationDays: number, now: Date = new Date()): Promise<Date> {
  const endUser = await db.endUser.findUnique({ where: { id: endUserId }, select: { membershipUntil: true } });
  const base = endUser?.membershipUntil && endUser.membershipUntil.getTime() > now.getTime()
    ? endUser.membershipUntil
    : now;
  const until = new Date(base.getTime() + durationDays * 24 * 60 * 60 * 1000);
  await db.endUser.update({ where: { id: endUserId }, data: { membershipUntil: until } });
  return until;
}

// ─── Checkout link (Mercado Pago etc.) ──────────────────────────────────────────

const REUSE_PENDING_WINDOW_MS = 6 * 60 * 60 * 1000; // resend an existing link for 6h

interface BotForCheckout {
  id: string;
  integrations: BotIntegration[];
  branding?: { website?: string | null } | null;
}

/**
 * Build (or reuse) a checkout URL for the end-user's membership. Returns null when
 * the bot has no active payments integration configured — the caller then sends a
 * generic "contact the business" message instead of a pay link.
 */
export async function createCheckoutLink(
  bot: BotForCheckout,
  endUserId: string,
  cfg: MembershipConfig,
): Promise<string | null> {
  const integration = bot.integrations.find(i => i.kind === 'payments' && i.status === 'active');
  if (!integration) return null;

  // Reuse a still-pending link to avoid creating a fresh preference on every message.
  const recent = await db.payment.findFirst({
    where: {
      endUserId,
      botId: bot.id,
      status: 'pending',
      checkoutUrl: { not: null },
      createdAt: { gt: new Date(Date.now() - REUSE_PENDING_WINDOW_MS) },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (recent?.checkoutUrl) return recent.checkoutUrl;

  let accessToken: string;
  try {
    accessToken = decryptJson<{ apiKey: string }>(integration.credentials).apiKey;
  } catch {
    logger.warn({ botId: bot.id }, 'membership: failed to decrypt payments credentials');
    return null;
  }

  // Persist the pending payment first so its id is the externalReference echoed back
  // by the provider webhook — that is how we map a payment to the end-user.
  const payment = await db.payment.create({
    data: {
      botId: bot.id,
      endUserId,
      provider: integration.provider,
      status: 'pending',
      amount: cfg.price > 0 ? cfg.price : null,
      currency: cfg.currency,
      membershipDays: cfg.durationDays,
    },
  });

  try {
    const provider = getPaymentProvider(integration.provider);
    const notificationUrl = config.PUBLIC_BASE_URL
      ? `${config.PUBLIC_BASE_URL}/webhook/payments/${integration.provider}/${bot.id}`
      : undefined;
    if (!notificationUrl) {
      logger.warn({ botId: bot.id }, 'membership: PUBLIC_BASE_URL unset — automatic activation disabled');
    }

    const result = await provider.createCheckout({
      accessToken,
      title: cfg.title,
      price: cfg.price,
      currency: cfg.currency,
      externalReference: payment.id,
      notificationUrl,
      successUrl: bot.branding?.website ?? undefined,
    });

    await db.payment.update({
      where: { id: payment.id },
      data: { providerRef: result.providerRef, checkoutUrl: result.url },
    });
    return result.url;
  } catch (err) {
    logger.warn({ botId: bot.id, err: (err as Error).message }, 'membership: checkout creation failed');
    return null;
  }
}

// ─── Webhook reconciliation ──────────────────────────────────────────────────────

export interface ActivationOutcome {
  activated: boolean;
  orgId?: string;
  reason?: string;
}

/**
 * Reconcile a provider payment notification for a given bot. Re-fetches the payment
 * from the provider (authoritative) using the bot's own token, then activates the
 * membership if approved. Idempotent: an already-approved payment is a no-op.
 */
export async function reconcilePayment(botId: string, providerName: string, paymentId: string): Promise<ActivationOutcome> {
  const bot = await db.bot.findUnique({
    where: { id: botId },
    select: { orgId: true, integrations: true },
  });
  if (!bot) return { activated: false, reason: 'bot_not_found' };

  const integration = bot.integrations.find(
    i => i.kind === 'payments' && i.provider === providerName && i.status === 'active',
  );
  if (!integration) return { activated: false, orgId: bot.orgId, reason: 'no_integration' };

  let accessToken: string;
  try {
    accessToken = decryptJson<{ apiKey: string }>(integration.credentials).apiKey;
  } catch {
    return { activated: false, orgId: bot.orgId, reason: 'bad_credentials' };
  }

  const provider = getPaymentProvider(providerName);
  const info = await provider.getPayment({ accessToken, paymentId });
  if (info.status !== 'approved') return { activated: false, orgId: bot.orgId, reason: `status_${info.status}` };
  if (!info.externalReference) return { activated: false, orgId: bot.orgId, reason: 'no_reference' };

  const payment = await db.payment.findUnique({ where: { id: info.externalReference } });
  if (!payment || payment.botId !== botId) return { activated: false, orgId: bot.orgId, reason: 'unknown_payment' };
  if (payment.status === 'approved') return { activated: false, orgId: bot.orgId, reason: 'already_applied' };

  await activateMembership(payment.endUserId, payment.membershipDays);
  await db.payment.update({
    where: { id: payment.id },
    data: { status: 'approved', paidAt: new Date(), providerRef: paymentId },
  });

  return { activated: true, orgId: bot.orgId };
}

/** Build the message shown when an end-user hits the paywall. */
export function buildPaywallMessage(cfg: MembershipConfig, checkoutUrl: string | null): string {
  const intro = cfg.paywallMessage
    ?? 'Has utilizado tus mensajes gratuitos. Para seguir conversando, adquiere tu membresía.';
  if (!checkoutUrl) {
    return `${intro}\n\nPor el momento no es posible procesar el pago automáticamente. Contacta al negocio para activar tu membresía.`;
  }
  const priceLabel = cfg.price > 0 ? ` (${cfg.price} ${cfg.currency})` : '';
  return `${intro}\n\n🔓 ${cfg.title}${priceLabel} — válida por ${cfg.durationDays} días.\nPaga aquí para continuar:\n${checkoutUrl}`;
}
