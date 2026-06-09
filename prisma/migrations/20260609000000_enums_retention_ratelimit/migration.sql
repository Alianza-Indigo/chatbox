-- Migration: enums_retention_ratelimit
-- Converts String columns to proper PostgreSQL enums for type safety,
-- and adds retention + per-bot rate-limit configuration fields.

-- CreateEnum: Organization plan
CREATE TYPE "OrgPlan" AS ENUM ('free', 'pro', 'enterprise');

-- CreateEnum: OrgUser role
CREATE TYPE "OrgUserRole" AS ENUM ('owner', 'admin', 'editor');

-- CreateEnum: Bot status
CREATE TYPE "BotStatus" AS ENUM ('draft', 'active', 'paused', 'credential_error');

-- CreateEnum: Bot safety level
CREATE TYPE "BotSafetyLevel" AS ENUM ('strict', 'standard', 'minimal');

-- CreateEnum: Channel status
CREATE TYPE "ChannelStatus" AS ENUM ('connected', 'pending', 'error');

-- CreateEnum: Message direction
CREATE TYPE "MessageDirection" AS ENUM ('in', 'out');

-- CreateEnum: Message input type
CREATE TYPE "MessageInputType" AS ENUM ('text', 'voice', 'interactive');

-- AlterTable: organizations — convert plan + add retention field
ALTER TABLE "organizations"
  ALTER COLUMN "plan" TYPE "OrgPlan" USING "plan"::"OrgPlan",
  ADD COLUMN "msg_retention_days" INTEGER;

-- AlterTable: org_users — convert role
ALTER TABLE "org_users"
  ALTER COLUMN "role" TYPE "OrgUserRole" USING "role"::"OrgUserRole";

-- AlterTable: bots — convert status + safety_level + add rate limit field
ALTER TABLE "bots"
  ALTER COLUMN "status" TYPE "BotStatus" USING "status"::"BotStatus",
  ALTER COLUMN "safety_level" TYPE "BotSafetyLevel" USING "safety_level"::"BotSafetyLevel",
  ADD COLUMN "webhook_rate_limit" INTEGER;

-- AlterTable: channels — convert status
ALTER TABLE "channels"
  ALTER COLUMN "status" TYPE "ChannelStatus" USING "status"::"ChannelStatus";

-- AlterTable: messages — convert direction + input_type
ALTER TABLE "messages"
  ALTER COLUMN "direction" TYPE "MessageDirection" USING "direction"::"MessageDirection",
  ALTER COLUMN "input_type" TYPE "MessageInputType" USING "input_type"::"MessageInputType";
