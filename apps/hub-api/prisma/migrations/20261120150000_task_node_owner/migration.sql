-- A task can be with one of its person's Ensemble Nodes or crews (docs/35 §6.6).
-- Additive only. The new enum value is not used in this file: Postgres allows it only after this transaction.
ALTER TYPE "TaskOwner" ADD VALUE IF NOT EXISTS 'node';

ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "assignee_node_id" TEXT;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "assignee_room_id" TEXT;

CREATE INDEX IF NOT EXISTS "tasks_assignee_node_id_idx" ON "tasks"("assignee_node_id");
CREATE INDEX IF NOT EXISTS "tasks_assignee_room_id_idx" ON "tasks"("assignee_room_id");
