-- Migration: enums_retention_ratelimit
-- Converts String columns to proper PostgreSQL enums for type safety,
-- and adds retention + per-bot rate-limit configuration fields.

CREATE TYPE "OrgPlan" AS ENUM ('free', 'pro', 'enterprise');
CREATE TYPE "OrgUserRole" AS ENUM ('owner', 'admin', 'editor');
CREATE TYPE "BotStatus" AS ENUM ('draft', 'active', 'paused', 'credential_error');
CREATE TYPE "BotSafetyLevel" AS ENUM ('strict', 'standard', 'minimal');
CREATE TYPE "ChannelStatus" AS ENUM ('connected', 'pending', 'error', 'active');
CREATE TYPE "MessageDirection" AS ENUM ('in', 'out');
CREATE TYPE "MessageInputType" AS ENUM ('text', 'voice', 'interactive');

-- organizations: convert plan (drop default, cast, restore default) + retention field
ALTER TABLE "organizations" ALTER COLUMN "plan" DROP DEFAULT;
ALTER TABLE "organizations" ALTER COLUMN "plan" TYPE "OrgPlan" USING "plan"::"OrgPlan";
ALTER TABLE "organizations" ALTER COLUMN "plan" SET DEFAULT 'free';
ALTER TABLE "organizations" ADD COLUMN "msg_retention_days" INTEGER;

-- org_users: convert role
ALTER TABLE "org_users" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "org_users" ALTER COLUMN "role" TYPE "OrgUserRole" USING "role"::"OrgUserRole";
ALTER TABLE "org_users" ALTER COLUMN "role" SET DEFAULT 'editor';

-- bots: convert status + safety_level + rate limit field
ALTER TABLE "bots" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "bots" ALTER COLUMN "status" TYPE "BotStatus" USING "status"::"BotStatus";
ALTER TABLE "bots" ALTER COLUMN "status" SET DEFAULT 'draft';
ALTER TABLE "bots" ALTER COLUMN "safety_level" DROP DEFAULT;
ALTER TABLE "bots" ALTER COLUMN "safety_level" TYPE "BotSafetyLevel" USING "safety_level"::"BotSafetyLevel";
ALTER TABLE "bots" ALTER COLUMN "safety_level" SET DEFAULT 'standard';
ALTER TABLE "bots" ADD COLUMN "webhook_rate_limit" INTEGER;

-- channels: convert status (original default is 'active')
ALTER TABLE "channels" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "channels" ALTER COLUMN "status" TYPE "ChannelStatus" USING "status"::"ChannelStatus";
ALTER TABLE "channels" ALTER COLUMN "status" SET DEFAULT 'active';

-- messages: convert direction + input_type (no defaults on these columns)
ALTER TABLE "messages" ALTER COLUMN "direction" TYPE "MessageDirection" USING "direction"::"MessageDirection";
ALTER TABLE "messages" ALTER COLUMN "input_type" TYPE "MessageInputType" USING "input_type"::"MessageInputType";
