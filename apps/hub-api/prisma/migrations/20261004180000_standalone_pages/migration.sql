-- Standalone notes are the same task_pages rows as linked pages, with no task.
-- Existing linked pages keep their task_id. Multiple null task_ids are allowed.

ALTER TABLE "task_pages" ALTER COLUMN "task_id" DROP NOT NULL;

ALTER TABLE "task_pages" ADD COLUMN "title" TEXT NOT NULL DEFAULT '';

-- NULL means the body has not been indexed. notes_snapshot is the task's notes
-- from page creation, not the page body, so it is not copied here. hub-api
-- fills search_text after it is listening, using the same extraction as a save.
ALTER TABLE "task_pages" ADD COLUMN "search_text" TEXT;

CREATE INDEX "task_pages_user_id_updated_at_idx" ON "task_pages"("user_id", "updated_at");
