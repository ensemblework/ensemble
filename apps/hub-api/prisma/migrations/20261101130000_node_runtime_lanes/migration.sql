-- Work lanes keep their own assistant conversation per step, and turns record the tools they ran as they go.
ALTER TABLE "node_steps" ADD COLUMN "conversation_id" TEXT;
ALTER TABLE "node_turns" ADD COLUMN "receipts" JSONB NOT NULL DEFAULT '[]';
