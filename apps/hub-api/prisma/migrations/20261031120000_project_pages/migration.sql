-- Project names may repeat, like page titles: a new project starts as "Untitled project".
DROP INDEX IF EXISTS "projects_user_id_name_key";
CREATE INDEX IF NOT EXISTS "projects_user_id_name_idx" ON "projects"("user_id", "name");

-- Meeting notes can belong to a project.
ALTER TABLE "meeting_sessions" ADD COLUMN IF NOT EXISTS "project_id" TEXT;
ALTER TABLE "meeting_sessions" ADD CONSTRAINT "meeting_sessions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "meeting_sessions_user_id_project_id_idx" ON "meeting_sessions"("user_id", "project_id");
