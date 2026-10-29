-- Routines (ensemble-node B14): work a node does on a schedule, an Ensemble event or a webhook, and their occurrences.
ALTER TABLE "node_missions" ADD COLUMN "routine" JSONB;

-- CreateTable
CREATE TABLE "node_routines" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "node_id" TEXT NOT NULL,
    "room_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "action" TEXT NOT NULL DEFAULT 'prompt',
    "instruction" TEXT,
    "template" JSONB,
    "trigger" TEXT NOT NULL DEFAULT 'schedule',
    "cron" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "event" JSONB,
    "hook_hash" TEXT,
    "notify" TEXT NOT NULL DEFAULT 'always',
    "status" TEXT NOT NULL DEFAULT 'active',
    "next_run_at" TIMESTAMP(3),
    "last_run_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "node_routines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "node_routine_runs" (
    "id" TEXT NOT NULL,
    "routine_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "occurrence_key" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "payload" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "due_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mission_id" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),

    CONSTRAINT "node_routine_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "node_routines_user_id_idx" ON "node_routines"("user_id");

-- CreateIndex
CREATE INDEX "node_routines_status_trigger_next_run_at_idx" ON "node_routines"("status", "trigger", "next_run_at");

-- CreateIndex
CREATE UNIQUE INDEX "node_routine_runs_routine_id_occurrence_key_key" ON "node_routine_runs"("routine_id", "occurrence_key");

-- CreateIndex
CREATE INDEX "node_routine_runs_status_due_at_idx" ON "node_routine_runs"("status", "due_at");

-- AddForeignKey
ALTER TABLE "node_routines" ADD CONSTRAINT "node_routines_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "node_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_routine_runs" ADD CONSTRAINT "node_routine_runs_routine_id_fkey" FOREIGN KEY ("routine_id") REFERENCES "node_routines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
