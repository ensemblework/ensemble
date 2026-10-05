-- @ensemble on every surface: stored answers and scheduler watchers.

CREATE TABLE IF NOT EXISTS "watchers" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "surface" TEXT NOT NULL DEFAULT 'deliverable',
    "prompt" TEXT NOT NULL DEFAULT '',
    "scope_kind" TEXT NOT NULL,
    "scope_id" TEXT NOT NULL,
    "condition" TEXT NOT NULL,
    "days_before" INTEGER,
    "action" TEXT NOT NULL DEFAULT 'notify',
    "message" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'active',
    "fired_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "watchers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "watchers_user_id_status_idx" ON "watchers"("user_id", "status");

CREATE TABLE IF NOT EXISTS "ensemble_replies" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "anchor_key" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "tool_calls" JSONB NOT NULL DEFAULT '[]',
    "citations" JSONB NOT NULL DEFAULT '[]',
    "act_as" TEXT NOT NULL DEFAULT 'general',
    "model" TEXT NOT NULL DEFAULT '',
    "tier" TEXT NOT NULL DEFAULT 'medium',
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ensemble_replies_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ensemble_replies_user_id_surface_anchor_key_idx" ON "ensemble_replies"("user_id", "surface", "anchor_key");
