-- The text of the files a run changed, sent by a paired computer when the run ends (docs/25 §4.3,
-- protocol 3), so Ensemble on the web can show them after the computer is offline. Kept 30 days.
CREATE TABLE IF NOT EXISTS "job_files" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "content" TEXT,
    "size" INTEGER NOT NULL DEFAULT 0,
    "binary" BOOLEAN NOT NULL DEFAULT false,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "skipped" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "job_files_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "job_files_job_id_path_key" ON "job_files"("job_id", "path");
CREATE INDEX IF NOT EXISTS "job_files_created_at_idx" ON "job_files"("created_at");
DO $$ BEGIN
    ALTER TABLE "job_files" ADD CONSTRAINT "job_files_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "workspace_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
