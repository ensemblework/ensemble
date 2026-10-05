-- Assistant, trash, comments, completion records.
-- Column types match schema.prisma: ids are TEXT, DateTime is TIMESTAMP(3).
--
-- A database created with `prisma db push` has no migration history, so
-- `prisma migrate deploy` fails with P3005. Record the no-op baseline, then deploy
-- (this file, including the reminder backfill, runs on deploy):
--
--   cd apps/hub-api
--   pnpm exec prisma migrate resolve --applied 20260929100000_db_push_baseline
--   pnpm exec prisma migrate deploy

ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "pinned" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "deliverables" ADD COLUMN IF NOT EXISTS "pinned" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "content" JSONB;

-- A failed earlier attempt may have added parent_id as UUID. id is TEXT.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'page_discussions' AND column_name = 'parent_id' AND udt_name = 'uuid'
  ) THEN
    ALTER TABLE "page_discussions" DROP CONSTRAINT IF EXISTS "page_discussions_parent_id_fkey";
    ALTER TABLE "page_discussions" ALTER COLUMN "parent_id" TYPE TEXT USING "parent_id"::text;
  END IF;
END $$;

ALTER TABLE "page_discussions" ADD COLUMN IF NOT EXISTS "parent_id" TEXT;
ALTER TABLE "page_discussions" ADD COLUMN IF NOT EXISTS "author_kind" TEXT NOT NULL DEFAULT 'human';
ALTER TABLE "page_discussions" ADD COLUMN IF NOT EXISTS "mark_id" TEXT;
ALTER TABLE "page_discussions" ADD COLUMN IF NOT EXISTS "quote" TEXT NOT NULL DEFAULT '';
ALTER TABLE "page_discussions" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(3);
ALTER TABLE "page_discussions" ADD COLUMN IF NOT EXISTS "model" TEXT;
ALTER TABLE "page_discussions" ADD COLUMN IF NOT EXISTS "tier" TEXT;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'page_discussions' AND column_name = 'deleted_at' AND data_type = 'timestamp with time zone'
  ) THEN
    ALTER TABLE "page_discussions" ALTER COLUMN "deleted_at" TYPE TIMESTAMP(3) USING "deleted_at" AT TIME ZONE 'UTC';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "page_discussions_parent_id_idx" ON "page_discussions"("parent_id");
CREATE INDEX IF NOT EXISTS "page_discussions_user_id_deleted_at_idx" ON "page_discussions"("user_id", "deleted_at");

DO $$ BEGIN
  ALTER TABLE "page_discussions"
    ADD CONSTRAINT "page_discussions_parent_id_fkey"
    FOREIGN KEY ("parent_id") REFERENCES "page_discussions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "completion_records" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "entity_kind" TEXT NOT NULL,
  "entity_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "summary" TEXT NOT NULL DEFAULT '',
  "skill_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "people" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "project_id" TEXT,
  "project_name" TEXT,
  "repo_id" TEXT,
  "repo_full_name" TEXT,
  "outcome" TEXT NOT NULL,
  "completed_at" TIMESTAMP(3),
  "source_json" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "completion_records_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "completion_records_user_id_created_at_idx" ON "completion_records"("user_id", "created_at");

CREATE TABLE IF NOT EXISTS "model_probes" (
  "user_id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "detail" TEXT NOT NULL DEFAULT '',
  "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "model_probes_pkey" PRIMARY KEY ("user_id", "provider", "model")
);

-- Non-ISO reminder times cannot be scheduled. Leave the date; drop the bad clock.
UPDATE "private_reminders"
SET "due_time" = NULL
WHERE "due_time" IS NOT NULL AND "due_time" !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$';

-- Rows created before next_notification_at was written never fire.
DO $$
DECLARE
  rec record;
  zone text;
  local_ts timestamp;
  instant timestamp;
BEGIN
  FOR rec IN
    SELECT "id", "due_date", "due_time", "time_zone"
    FROM "private_reminders"
    WHERE "next_notification_at" IS NULL
      AND "deleted_at" IS NULL
      AND "dismissed_at" IS NULL
      AND "due_date" ~ '^\d{4}-\d{2}-\d{2}$'
  LOOP
    zone := COALESCE(NULLIF(rec.time_zone, ''), 'UTC');
    local_ts := (rec.due_date || ' ' ||
      CASE WHEN rec.due_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN rec.due_time ELSE '09:00' END
      || ':00')::timestamp;
    BEGIN
      instant := (local_ts AT TIME ZONE zone) AT TIME ZONE 'UTC';
    EXCEPTION WHEN OTHERS THEN
      instant := local_ts;
    END;
    UPDATE "private_reminders" SET "next_notification_at" = instant WHERE "id" = rec.id;
  END LOOP;
END $$;
