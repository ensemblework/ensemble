-- Review-only jobs are read-only and have no network. Existing jobs stay read-write.
ALTER TABLE "workspace_jobs" ADD COLUMN "access_mode" TEXT NOT NULL DEFAULT 'read-write';
