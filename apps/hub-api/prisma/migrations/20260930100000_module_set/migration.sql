-- Optional modules ride on the user and are copied onto each session.
-- Existing accounts keep every module. A null session set is fail-closed in the app.

ALTER TABLE "users" ADD COLUMN "module_set" TEXT NOT NULL DEFAULT 'code,metrics,runs,skills,workspace';

ALTER TABLE "sessions" ADD COLUMN "modules" TEXT;

UPDATE "sessions" SET "modules" = 'code,metrics,runs,skills,workspace' WHERE "modules" IS NULL;
