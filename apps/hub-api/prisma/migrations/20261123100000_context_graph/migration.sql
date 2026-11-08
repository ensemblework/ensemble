-- Context graph: indexes that let a person, a meeting and a task find what links to them,
-- meeting series and the meeting AI pass, a person's relationship to the account owner,
-- and Context Bridge keys that may update tasks.
ALTER TABLE "people" ADD COLUMN "relationship" TEXT;

ALTER TABLE "meeting_notes" ADD COLUMN "series_key" TEXT;
ALTER TABLE "meeting_notes" ADD COLUMN "ai_status" TEXT;
ALTER TABLE "meeting_notes" ADD COLUMN "ai_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "meeting_notes" ADD COLUMN "ai_error" TEXT;

ALTER TABLE "meeting_sessions" ADD COLUMN "series_key" TEXT;

ALTER TABLE "api_tokens" ADD COLUMN "can_write" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "tasks_people_idx" ON "tasks" USING GIN ("people");
CREATE INDEX "tasks_depends_on_idx" ON "tasks" USING GIN ("depends_on");
CREATE INDEX "meeting_notes_person_ids_idx" ON "meeting_notes" USING GIN ("person_ids");
CREATE INDEX "meeting_notes_user_id_series_key_idx" ON "meeting_notes"("user_id", "series_key");
CREATE INDEX "meeting_notes_ai_status_idx" ON "meeting_notes"("ai_status");
CREATE INDEX "meeting_sessions_person_ids_idx" ON "meeting_sessions" USING GIN ("person_ids");
CREATE INDEX "meeting_sessions_user_id_series_key_idx" ON "meeting_sessions"("user_id", "series_key");
