-- A fourth priority above High.
ALTER TYPE "Priority" ADD VALUE IF NOT EXISTS 'critical' BEFORE 'p0';

-- In a shared space, which person a task is with when its owner is "me". Null: the space's owner.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "assignee_account_id" TEXT;
CREATE INDEX IF NOT EXISTS "tasks_assignee_account_id_idx" ON "tasks"("assignee_account_id");
