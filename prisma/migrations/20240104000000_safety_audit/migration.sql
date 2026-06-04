-- Add safety_level to bots (default 'standard' — existing bots are unaffected)
ALTER TABLE "bots" ADD COLUMN "safety_level" TEXT NOT NULL DEFAULT 'standard';

-- Audit log for sensitive admin operations
CREATE TABLE "audit_logs" (
  "id" TEXT NOT NULL,
  "org_id" TEXT,
  "actor_id" TEXT,
  "actor_role" TEXT,
  "action" TEXT NOT NULL,
  "target_type" TEXT NOT NULL,
  "target_id" TEXT,
  "metadata" JSONB,
  "ip" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_logs_org_id_created_at_idx" ON "audit_logs"("org_id", "created_at");
CREATE INDEX "audit_logs_actor_id_created_at_idx" ON "audit_logs"("actor_id", "created_at");
