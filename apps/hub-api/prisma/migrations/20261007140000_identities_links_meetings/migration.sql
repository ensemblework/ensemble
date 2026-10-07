-- People identities, project links, and meeting notes from meeting-notes connectors.
-- Additive only: two new tables, nullable columns, backfills that skip rows already present.

ALTER TABLE "meeting_notes" ADD COLUMN IF NOT EXISTS "event_artifact_id" TEXT;
ALTER TABLE "meeting_notes" ADD COLUMN IF NOT EXISTS "transcript_artifact_id" TEXT;
ALTER TABLE "meeting_notes" ADD COLUMN IF NOT EXISTS "external_source" TEXT;
ALTER TABLE "meeting_notes" ADD COLUMN IF NOT EXISTS "external_id" TEXT;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "meeting_note_id" TEXT;

CREATE TABLE IF NOT EXISTS "person_identities" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'ingest',
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "suggested_person_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "person_identities_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "project_links" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "container_id" TEXT NOT NULL,
    "container_name" TEXT NOT NULL DEFAULT '',
    "created_by" TEXT NOT NULL DEFAULT 'me',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "project_links_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "person_identities_person_id_idx" ON "person_identities"("person_id");
CREATE UNIQUE INDEX IF NOT EXISTS "person_identities_user_id_kind_value_key" ON "person_identities"("user_id", "kind", "value");
CREATE INDEX IF NOT EXISTS "project_links_project_id_idx" ON "project_links"("project_id");
CREATE UNIQUE INDEX IF NOT EXISTS "project_links_user_id_source_container_id_key" ON "project_links"("user_id", "source", "container_id");
CREATE INDEX IF NOT EXISTS "meeting_notes_event_artifact_id_idx" ON "meeting_notes"("event_artifact_id");
CREATE UNIQUE INDEX IF NOT EXISTS "meeting_notes_user_id_external_source_external_id_key" ON "meeting_notes"("user_id", "external_source", "external_id");
CREATE INDEX IF NOT EXISTS "tasks_meeting_note_id_idx" ON "tasks"("meeting_note_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_meeting_note_id_fkey') THEN
    ALTER TABLE "tasks" ADD CONSTRAINT "tasks_meeting_note_id_fkey" FOREIGN KEY ("meeting_note_id") REFERENCES "meeting_notes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'person_identities_user_id_fkey') THEN
    ALTER TABLE "person_identities" ADD CONSTRAINT "person_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'person_identities_person_id_fkey') THEN
    ALTER TABLE "person_identities" ADD CONSTRAINT "person_identities_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_links_user_id_fkey') THEN
    ALTER TABLE "project_links" ADD CONSTRAINT "project_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_links_project_id_fkey') THEN
    ALTER TABLE "project_links" ADD CONSTRAINT "project_links_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meeting_notes_event_artifact_id_fkey') THEN
    ALTER TABLE "meeting_notes" ADD CONSTRAINT "meeting_notes_event_artifact_id_fkey" FOREIGN KEY ("event_artifact_id") REFERENCES "artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meeting_notes_transcript_artifact_id_fkey') THEN
    ALTER TABLE "meeting_notes" ADD CONSTRAINT "meeting_notes_transcript_artifact_id_fkey" FOREIGN KEY ("transcript_artifact_id") REFERENCES "artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Backfill: every known email (people.email, or an email-shaped upn) becomes an email identity.
-- Live people go first, so a live and a deleted person sharing an address resolve to the live one.
INSERT INTO "person_identities" ("id", "user_id", "person_id", "kind", "value", "source", "verified", "created_at")
SELECT gen_random_uuid()::text, src.user_id, src.person_id, 'email', src.value, 'backfill', false, CURRENT_TIMESTAMP
FROM (
  SELECT p."user_id" AS user_id, p."id" AS person_id, lower(trim(p."email")) AS value, (p."deleted_at" IS NOT NULL) AS gone, p."updated_at" AS at
  FROM "people" p WHERE p."email" IS NOT NULL AND position('@' IN p."email") > 1 AND position(' ' IN trim(p."email")) = 0
  UNION ALL
  SELECT p."user_id", p."id", lower(trim(p."upn")), (p."deleted_at" IS NOT NULL), p."updated_at"
  FROM "people" p WHERE p."upn" IS NOT NULL AND position('@' IN p."upn") > 1 AND position(':' IN p."upn") = 0 AND position(' ' IN trim(p."upn")) = 0
) src
ORDER BY src.gone, src.at DESC
ON CONFLICT ("user_id", "kind", "value") DO NOTHING;

-- Backfill: connector handles stored as upn ("slack:U123", "teams:<id>") become handle identities.
INSERT INTO "person_identities" ("id", "user_id", "person_id", "kind", "value", "source", "verified", "created_at")
SELECT gen_random_uuid()::text, p."user_id", p."id", split_part(lower(p."upn"), ':', 1), lower(substring(p."upn" FROM position(':' IN p."upn") + 1)), 'backfill', false, CURRENT_TIMESTAMP
FROM "people" p
WHERE p."upn" IS NOT NULL
  AND split_part(lower(p."upn"), ':', 1) IN ('slack', 'teams', 'github', 'linear', 'jira', 'zoom')
  AND length(substring(p."upn" FROM position(':' IN p."upn") + 1)) > 0
ORDER BY (p."deleted_at" IS NOT NULL), p."updated_at" DESC
ON CONFLICT ("user_id", "kind", "value") DO NOTHING;

-- Backfill: projects an import created from a container (Linear project, Jira project, Notion database,
-- Trello board, GitHub repo…) keep that container linked, so later syncs land in the same project.
INSERT INTO "project_links" ("id", "user_id", "project_id", "source", "container_id", "container_name", "created_by", "created_at")
SELECT gen_random_uuid()::text, p."user_id", p."id", p."external_source",
  CASE WHEN p."external_source" = 'github' AND p."external_id" LIKE 'repo:%' THEN lower(substring(p."external_id" FROM 6)) ELSE p."external_id" END,
  p."name", 'import', CURRENT_TIMESTAMP
FROM "projects" p
WHERE p."external_source" IS NOT NULL AND p."external_id" IS NOT NULL AND p."external_source" <> 'csv' AND p."deleted_at" IS NULL
ON CONFLICT ("user_id", "source", "container_id") DO NOTHING;

-- Backfill: live meeting notes already pointed artifact_id at their calendar event.
UPDATE "meeting_notes" n SET "event_artifact_id" = n."artifact_id"
WHERE n."event_artifact_id" IS NULL AND n."artifact_id" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "artifacts" a WHERE a."id" = n."artifact_id" AND a."kind" = 'event');
