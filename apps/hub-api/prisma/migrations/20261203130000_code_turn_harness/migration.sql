-- A Code tab turn's packet and its completion states, kept on its run.
ALTER TABLE "runs" ADD COLUMN "packet" JSONB;
ALTER TABLE "runs" ADD COLUMN "completion" JSONB;

-- A run's minutes and turns are the owner's own limits: none unless they set one.
ALTER TABLE "workspace_jobs" ALTER COLUMN "max_turns" DROP NOT NULL;
ALTER TABLE "workspace_jobs" ALTER COLUMN "max_turns" DROP DEFAULT;
ALTER TABLE "workspace_jobs" ALTER COLUMN "max_minutes" DROP NOT NULL;
ALTER TABLE "workspace_jobs" ALTER COLUMN "max_minutes" DROP DEFAULT;

-- The handoff record (ensemble.handoff.v1) a new agent session starts from.
CREATE TABLE "session_handoffs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "job_id" TEXT,
    "source_job_id" TEXT,
    "reason" TEXT NOT NULL,
    "record" JSONB NOT NULL,
    "chars" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "session_handoffs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "session_handoffs_user_id_created_at_idx" ON "session_handoffs"("user_id", "created_at");
CREATE INDEX "session_handoffs_job_id_idx" ON "session_handoffs"("job_id");
ALTER TABLE "session_handoffs" ADD CONSTRAINT "session_handoffs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "workspace_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
