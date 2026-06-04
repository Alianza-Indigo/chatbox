-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "msg_quota" INTEGER NOT NULL DEFAULT 1000,
    "msg_used" INTEGER NOT NULL DEFAULT 0,
    "current_period_start" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_users" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bots" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "locale" TEXT NOT NULL DEFAULT 'es-MX',
    "system_prompt" TEXT,
    "identity" JSONB,
    "onboarding_msg" TEXT,
    "history_window" INTEGER NOT NULL DEFAULT 5,
    "llm_provider" TEXT,
    "llm_model" TEXT,
    "llm_api_key_enc" BYTEA,
    "llm_params" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_branding" (
    "id" TEXT NOT NULL,
    "bot_id" TEXT NOT NULL,
    "company_name" TEXT,
    "logo_url" TEXT,
    "primary_color" TEXT,
    "website" TEXT,
    "support_contact" TEXT,
    "privacy_policy_url" TEXT,
    "terms_url" TEXT,

    CONSTRAINT "bot_branding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_prompt_versions" (
    "id" TEXT NOT NULL,
    "bot_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "system_prompt" TEXT NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_prompt_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_commands" (
    "id" TEXT NOT NULL,
    "bot_id" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "response_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "bot_commands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_knowledge" (
    "id" TEXT NOT NULL,
    "bot_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "tags" TEXT[],
    "embedding_data" BYTEA,
    "has_embedding" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "bot_knowledge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_crisis_config" (
    "id" TEXT NOT NULL,
    "bot_id" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "lines" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "bot_crisis_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channels" (
    "id" TEXT NOT NULL,
    "bot_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "phone_id" TEXT NOT NULL,
    "credentials" BYTEA NOT NULL,
    "verify_token" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',

    CONSTRAINT "channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_integrations" (
    "id" TEXT NOT NULL,
    "bot_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "credentials" BYTEA NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',

    CONSTRAINT "bot_integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "end_users" (
    "id" TEXT NOT NULL,
    "bot_id" TEXT NOT NULL,
    "wa_phone_hash" TEXT NOT NULL,
    "locale" TEXT,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "end_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consents" (
    "id" TEXT NOT NULL,
    "end_user_id" TEXT NOT NULL,
    "bot_id" TEXT NOT NULL,
    "accepted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "policy_version" TEXT NOT NULL,

    CONSTRAINT "consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "bot_id" TEXT NOT NULL,
    "end_user_id" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "input_type" TEXT NOT NULL,
    "body_enc" BYTEA NOT NULL,
    "external_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crisis_events" (
    "id" TEXT NOT NULL,
    "bot_id" TEXT NOT NULL,
    "end_user_id" TEXT NOT NULL,
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "category" TEXT NOT NULL,
    "action_taken" TEXT NOT NULL,

    CONSTRAINT "crisis_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback" (
    "id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "end_user_id" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "org_users_email_key" ON "org_users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "bot_branding_bot_id_key" ON "bot_branding"("bot_id");

-- CreateIndex
CREATE UNIQUE INDEX "bot_commands_bot_id_trigger_key" ON "bot_commands"("bot_id", "trigger");

-- CreateIndex
CREATE UNIQUE INDEX "channels_phone_id_key" ON "channels"("phone_id");

-- CreateIndex
CREATE UNIQUE INDEX "end_users_bot_id_wa_phone_hash_key" ON "end_users"("bot_id", "wa_phone_hash");

-- CreateIndex
CREATE INDEX "messages_bot_id_end_user_id_created_at_idx" ON "messages"("bot_id", "end_user_id", "created_at");

-- AddForeignKey
ALTER TABLE "org_users" ADD CONSTRAINT "org_users_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bots" ADD CONSTRAINT "bots_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_branding" ADD CONSTRAINT "bot_branding_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_prompt_versions" ADD CONSTRAINT "bot_prompt_versions_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- NOTE: created_by is a free-text audit field (stores user id or 'superadmin') — no FK constraint

-- AddForeignKey
ALTER TABLE "bot_commands" ADD CONSTRAINT "bot_commands_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_knowledge" ADD CONSTRAINT "bot_knowledge_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_crisis_config" ADD CONSTRAINT "bot_crisis_config_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channels" ADD CONSTRAINT "channels_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_integrations" ADD CONSTRAINT "bot_integrations_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: deleting a Bot cascades to all its EndUsers
ALTER TABLE "end_users" ADD CONSTRAINT "end_users_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: deleting an EndUser cascades to their Consents
ALTER TABLE "consents" ADD CONSTRAINT "consents_end_user_id_fkey" FOREIGN KEY ("end_user_id") REFERENCES "end_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: deleting a Bot cascades to all Messages; deleting an EndUser cascades too
ALTER TABLE "messages" ADD CONSTRAINT "messages_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_end_user_id_fkey" FOREIGN KEY ("end_user_id") REFERENCES "end_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: deleting a Bot cascades to all CrisisEvents; deleting an EndUser too
ALTER TABLE "crisis_events" ADD CONSTRAINT "crisis_events_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crisis_events" ADD CONSTRAINT "crisis_events_end_user_id_fkey" FOREIGN KEY ("end_user_id") REFERENCES "end_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: deleting a Message cascades to its Feedback; deleting an EndUser too
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_end_user_id_fkey" FOREIGN KEY ("end_user_id") REFERENCES "end_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
