-- Routines: work the Ensemble assistant does on a schedule.
CREATE TABLE "assistant_routines" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "cron" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "status" TEXT NOT NULL DEFAULT 'active',
    "next_run_at" TIMESTAMP(3),
    "last_run_at" TIMESTAMP(3),
    "last_status" TEXT,
    "last_summary" TEXT,
    "conversation_id" TEXT,
    "run_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assistant_routines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "assistant_routines_user_id_idx" ON "assistant_routines"("user_id");
CREATE INDEX "assistant_routines_status_next_run_at_idx" ON "assistant_routines"("status", "next_run_at");
