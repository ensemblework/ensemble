ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "limitation_rule" TEXT;

CREATE INDEX IF NOT EXISTS "tasks_user_id_task_type_idx" ON "tasks"("user_id", "task_type");
CREATE INDEX IF NOT EXISTS "tasks_user_id_order_date_idx" ON "tasks"("user_id", "order_date");
