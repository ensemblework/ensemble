-- Remote tasks on your computer (docs/25 §4.2).
--
-- Additive only, and safe to re-run: no table is dropped and no row is
-- rewritten. Existing jobs keep device_id NULL, which is today's server-run
-- job. PGlite on the desktop applies this same file.
--
-- `interrupted` uses IF NOT EXISTS because the desktop branch adds the same
-- value in its own migration. Neither new value is used in this file:
-- Postgres only allows a new enum value after the transaction that added it.

ALTER TYPE "WorkspaceJobStatus" ADD VALUE IF NOT EXISTS 'claimed';
ALTER TYPE "WorkspaceJobStatus" ADD VALUE IF NOT EXISTS 'interrupted';

ALTER TABLE "workspace_jobs" ADD COLUMN IF NOT EXISTS "device_id" TEXT;
ALTER TABLE "workspace_jobs" ADD COLUMN IF NOT EXISTS "lease_token" TEXT;
ALTER TABLE "workspace_jobs" ADD COLUMN IF NOT EXISTS "claimed_at" TIMESTAMP(3);
ALTER TABLE "workspace_jobs" ADD COLUMN IF NOT EXISTS "last_progress_at" TIMESTAMP(3);
ALTER TABLE "workspace_jobs" ADD COLUMN IF NOT EXISTS "attempt" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "workspace_jobs" ADD COLUMN IF NOT EXISTS "folder_label" TEXT;
ALTER TABLE "workspace_jobs" ADD COLUMN IF NOT EXISTS "results" JSONB;

CREATE TABLE IF NOT EXISTS "devices" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "app_version" TEXT,
    "token_id" TEXT NOT NULL,
    "capabilities" JSONB NOT NULL DEFAULT '{}',
    "last_seen_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "device_pairings" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "device_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_pairings_pkey" PRIMARY KEY ("id")
);

-- Log retention deletes from this table by created_at.
CREATE TABLE IF NOT EXISTS "workspace_log_chunks" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "seq_from" INTEGER NOT NULL,
    "seq_to" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_log_chunks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "devices_token_id_key" ON "devices"("token_id");
CREATE INDEX IF NOT EXISTS "devices_user_id_revoked_at_idx" ON "devices"("user_id", "revoked_at");
CREATE UNIQUE INDEX IF NOT EXISTS "device_pairings_code_hash_key" ON "device_pairings"("code_hash");
CREATE INDEX IF NOT EXISTS "device_pairings_user_id_created_at_idx" ON "device_pairings"("user_id", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_log_chunks_job_id_seq_from_key" ON "workspace_log_chunks"("job_id", "seq_from");
CREATE INDEX IF NOT EXISTS "workspace_log_chunks_created_at_idx" ON "workspace_log_chunks"("created_at");
CREATE INDEX IF NOT EXISTS "workspace_jobs_device_id_status_sequence_idx" ON "workspace_jobs"("device_id", "status", "sequence");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_jobs_device_id_fkey') THEN
    ALTER TABLE "workspace_jobs" ADD CONSTRAINT "workspace_jobs_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'devices_token_id_fkey') THEN
    ALTER TABLE "devices" ADD CONSTRAINT "devices_token_id_fkey" FOREIGN KEY ("token_id") REFERENCES "api_tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_pairings_user_id_fkey') THEN
    ALTER TABLE "device_pairings" ADD CONSTRAINT "device_pairings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_log_chunks_job_id_fkey') THEN
    ALTER TABLE "workspace_log_chunks" ADD CONSTRAINT "workspace_log_chunks_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "workspace_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
