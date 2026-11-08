-- How each new run by the person's own coding agent chose its agent session (docs/30, Choosing a session).
CREATE TABLE "session_choices" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "job_id" TEXT,
    "task_id" TEXT,
    "engine" TEXT NOT NULL,
    "device_id" TEXT,
    "project_id" TEXT,
    "decision" TEXT NOT NULL,
    "band" TEXT NOT NULL,
    "session_id" TEXT,
    "continued_job_id" TEXT,
    "score" DOUBLE PRECISION,
    "why" TEXT,
    "note" TEXT,
    "config_version" TEXT NOT NULL,
    "config_hash" TEXT NOT NULL,
    "candidates" JSONB NOT NULL DEFAULT '[]',
    "elapsed_ms" INTEGER,
    "outcome" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "session_choices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "session_choices_job_id_key" ON "session_choices"("job_id");
CREATE INDEX "session_choices_user_id_created_at_idx" ON "session_choices"("user_id", "created_at");

ALTER TABLE "session_choices" ADD CONSTRAINT "session_choices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "session_choices" ADD CONSTRAINT "session_choices_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "workspace_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
