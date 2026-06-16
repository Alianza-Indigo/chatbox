-- Migration: membership (microsaas mode)
-- Adds per-end-user free-tier usage + membership expiry, and a payments table
-- that tracks membership purchases reconciled via the payment-provider webhook.

-- end_users: lifetime free counter + membership expiry
ALTER TABLE "end_users" ADD COLUMN "free_msg_used" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "end_users" ADD COLUMN "membership_until" TIMESTAMP(3);

-- payments: one row per checkout, flipped to 'approved' by the provider webhook
CREATE TABLE "payments" (
  "id"              TEXT NOT NULL,
  "bot_id"          TEXT NOT NULL,
  "end_user_id"     TEXT NOT NULL,
  "provider"        TEXT NOT NULL DEFAULT 'mercadopago',
  "provider_ref"    TEXT,
  "checkout_url"    TEXT,
  "status"          TEXT NOT NULL DEFAULT 'pending',
  "amount"          DECIMAL(12,2),
  "currency"        TEXT,
  "membership_days" INTEGER NOT NULL,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paid_at"         TIMESTAMP(3),
  CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "payments_end_user_id_status_created_at_idx"
  ON "payments" ("end_user_id", "status", "created_at");

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_bot_id_fkey"
  FOREIGN KEY ("bot_id") REFERENCES "bots" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_end_user_id_fkey"
  FOREIGN KEY ("end_user_id") REFERENCES "end_users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
