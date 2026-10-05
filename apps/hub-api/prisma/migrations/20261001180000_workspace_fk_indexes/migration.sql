-- Repair workspace indexes and foreign keys without resetting the database.
--
-- schema.prisma expects these on WorkspaceSession, WorkspaceJob, and WorkspaceEvent.
-- The only earlier SQL that creates them is 20260929000000_pre_feature_schema.
-- That migration is already recorded on databases that were baselined (db push,
-- then migrate resolve) or that applied a history in which those objects were
-- never created. Prisma will not run an applied migration again. `migrate dev`
-- rebuilds a shadow database from the files, reports the live database as
-- drifted, and asks for `migrate reset`, which drops public and the data in it.
--
-- This migration is safe to re-run. It never drops a table. Rows that already
-- point at a real parent are left alone. A foreign key cannot be added while a
-- child points at a missing parent, so those orphan rows are removed or
-- detached first. Each step is recorded on _prisma_migrations.logs (Prisma's
-- migrate CLI does not print RAISE NOTICE) and raised as a warning so the
-- Postgres server log has the same lines.

DO $$
DECLARE
  cleared bigint;
  events_removed bigint;
  decisions_removed bigint;
  reviews_removed bigint;
  jobs_removed bigint;
  removed bigint;
  existed boolean;
  lines text[] := ARRAY[]::text[];
  summary text;
BEGIN
  UPDATE "workspace_jobs" AS job
  SET "run_id" = NULL
  WHERE job."run_id" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "runs" AS run WHERE run."id" = job."run_id");
  GET DIAGNOSTICS cleared = ROW_COUNT;
  lines := array_append(lines, format('workspace repair: cleared run_id on %s workspace_jobs whose run is missing', cleared));

  WITH ranked AS (
    SELECT "id", row_number() OVER (PARTITION BY "run_id" ORDER BY "sequence", "created_at", "id") AS n
    FROM "workspace_jobs"
    WHERE "run_id" IS NOT NULL
  )
  UPDATE "workspace_jobs" AS job
  SET "run_id" = NULL
  FROM ranked
  WHERE job."id" = ranked."id"
    AND ranked.n > 1;
  GET DIAGNOSTICS cleared = ROW_COUNT;
  lines := array_append(lines, format('workspace repair: cleared duplicate run_id on %s later workspace_jobs', cleared));

  CREATE TEMP TABLE doomed_jobs ON COMMIT DROP AS
  SELECT job."id"
  FROM "workspace_jobs" AS job
  WHERE NOT EXISTS (SELECT 1 FROM "tasks" AS task WHERE task."id" = job."task_id");

  DELETE FROM "workspace_events" AS event
  USING doomed_jobs
  WHERE event."job_id" = doomed_jobs."id";
  GET DIAGNOSTICS events_removed = ROW_COUNT;

  DELETE FROM "code_review_decisions" AS decision
  USING "code_reviews" AS review, doomed_jobs
  WHERE decision."review_id" = review."id"
    AND review."job_id" = doomed_jobs."id";
  GET DIAGNOSTICS decisions_removed = ROW_COUNT;

  DELETE FROM "code_reviews" AS review
  USING doomed_jobs
  WHERE review."job_id" = doomed_jobs."id";
  GET DIAGNOSTICS reviews_removed = ROW_COUNT;

  DELETE FROM "workspace_jobs" AS job
  USING doomed_jobs
  WHERE job."id" = doomed_jobs."id";
  GET DIAGNOSTICS jobs_removed = ROW_COUNT;
  lines := array_append(lines, format(
    'workspace repair: removed %s workspace_jobs with a missing task (%s events, %s code reviews, %s review decisions)',
    jobs_removed, events_removed, reviews_removed, decisions_removed
  ));

  DELETE FROM "workspace_events" AS event
  WHERE NOT EXISTS (SELECT 1 FROM "workspace_jobs" AS job WHERE job."id" = event."job_id");
  GET DIAGNOSTICS removed = ROW_COUNT;
  lines := array_append(lines, format('workspace repair: removed %s workspace_events whose job is missing', removed));

  DELETE FROM "workspace_sessions" AS session
  WHERE NOT EXISTS (SELECT 1 FROM "tasks" AS task WHERE task."id" = session."task_id");
  GET DIAGNOSTICS removed = ROW_COUNT;
  lines := array_append(lines, format('workspace repair: removed %s workspace_sessions whose task is missing', removed));

  SELECT EXISTS (
    SELECT 1 FROM pg_class AS idx
    JOIN pg_namespace AS ns ON ns.oid = idx.relnamespace
    WHERE ns.nspname = 'public' AND idx.relname = 'workspace_sessions_user_id_status_idx'
  ) INTO existed;
  CREATE INDEX IF NOT EXISTS "workspace_sessions_user_id_status_idx" ON "workspace_sessions"("user_id", "status");
  lines := array_append(lines, format('workspace repair: %s index workspace_sessions_user_id_status_idx', CASE WHEN existed THEN 'kept' ELSE 'created' END));

  SELECT EXISTS (
    SELECT 1 FROM pg_class AS idx
    JOIN pg_namespace AS ns ON ns.oid = idx.relnamespace
    WHERE ns.nspname = 'public' AND idx.relname = 'workspace_jobs_run_id_key'
  ) INTO existed;
  CREATE UNIQUE INDEX IF NOT EXISTS "workspace_jobs_run_id_key" ON "workspace_jobs"("run_id");
  lines := array_append(lines, format('workspace repair: %s unique index workspace_jobs_run_id_key', CASE WHEN existed THEN 'kept' ELSE 'created' END));

  SELECT EXISTS (
    SELECT 1 FROM pg_class AS idx
    JOIN pg_namespace AS ns ON ns.oid = idx.relnamespace
    WHERE ns.nspname = 'public' AND idx.relname = 'workspace_jobs_status_sequence_idx'
  ) INTO existed;
  CREATE INDEX IF NOT EXISTS "workspace_jobs_status_sequence_idx" ON "workspace_jobs"("status", "sequence");
  lines := array_append(lines, format('workspace repair: %s index workspace_jobs_status_sequence_idx', CASE WHEN existed THEN 'kept' ELSE 'created' END));

  SELECT EXISTS (
    SELECT 1 FROM pg_class AS idx
    JOIN pg_namespace AS ns ON ns.oid = idx.relnamespace
    WHERE ns.nspname = 'public' AND idx.relname = 'workspace_jobs_user_id_task_id_created_at_idx'
  ) INTO existed;
  CREATE INDEX IF NOT EXISTS "workspace_jobs_user_id_task_id_created_at_idx" ON "workspace_jobs"("user_id", "task_id", "created_at");
  lines := array_append(lines, format('workspace repair: %s index workspace_jobs_user_id_task_id_created_at_idx', CASE WHEN existed THEN 'kept' ELSE 'created' END));

  SELECT EXISTS (
    SELECT 1 FROM pg_class AS idx
    JOIN pg_namespace AS ns ON ns.oid = idx.relnamespace
    WHERE ns.nspname = 'public' AND idx.relname = 'workspace_events_job_id_sequence_idx'
  ) INTO existed;
  CREATE INDEX IF NOT EXISTS "workspace_events_job_id_sequence_idx" ON "workspace_events"("job_id", "sequence");
  lines := array_append(lines, format('workspace repair: %s index workspace_events_job_id_sequence_idx', CASE WHEN existed THEN 'kept' ELSE 'created' END));

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_sessions_task_id_fkey') THEN
    ALTER TABLE "workspace_sessions" ADD CONSTRAINT "workspace_sessions_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    lines := array_append(lines, 'workspace repair: added foreign key workspace_sessions_task_id_fkey');
  ELSE
    lines := array_append(lines, 'workspace repair: kept foreign key workspace_sessions_task_id_fkey');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_jobs_task_id_fkey') THEN
    ALTER TABLE "workspace_jobs" ADD CONSTRAINT "workspace_jobs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    lines := array_append(lines, 'workspace repair: added foreign key workspace_jobs_task_id_fkey');
  ELSE
    lines := array_append(lines, 'workspace repair: kept foreign key workspace_jobs_task_id_fkey');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_jobs_run_id_fkey') THEN
    ALTER TABLE "workspace_jobs" ADD CONSTRAINT "workspace_jobs_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    lines := array_append(lines, 'workspace repair: added foreign key workspace_jobs_run_id_fkey');
  ELSE
    lines := array_append(lines, 'workspace repair: kept foreign key workspace_jobs_run_id_fkey');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_events_job_id_fkey') THEN
    ALTER TABLE "workspace_events" ADD CONSTRAINT "workspace_events_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "workspace_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    lines := array_append(lines, 'workspace repair: added foreign key workspace_events_job_id_fkey');
  ELSE
    lines := array_append(lines, 'workspace repair: kept foreign key workspace_events_job_id_fkey');
  END IF;

  summary := array_to_string(lines, E'\n');
  RAISE WARNING '%', summary;
  UPDATE "_prisma_migrations"
  SET "logs" = summary
  WHERE "migration_name" = '20261001180000_workspace_fk_indexes';
END $$;
