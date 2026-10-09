ALTER TABLE "task_pages" ADD COLUMN "deleted_at" TIMESTAMP(3);
CREATE INDEX "task_pages_user_id_deleted_at_idx" ON "task_pages"("user_id", "deleted_at");
