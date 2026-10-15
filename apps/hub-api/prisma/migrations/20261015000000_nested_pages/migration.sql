ALTER TABLE "task_pages" ADD COLUMN "parent_id" TEXT;
CREATE INDEX "task_pages_user_id_parent_id_idx" ON "task_pages"("user_id", "parent_id");
ALTER TABLE "task_pages" ADD CONSTRAINT "task_pages_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "task_pages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
