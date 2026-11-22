-- Ensemble Node orchestration (docs/35 §5.8, §5.9, §4): the tool journal (each call a node turn makes to
-- Ensemble's tools, written before it runs and settled after, so a repeated call returns what the first did
-- and a restart knows what may have acted), steering records (the five ways an owner steers work already
-- going, with each amendment's outcome), and independent views on a turn (the room message it reads up to,
-- and its round's deadline). Additive: two new tables that go with their node, two nullable columns.
ALTER TABLE "node_turns" ADD COLUMN     "snapshot_seq" INTEGER,
ADD COLUMN     "deadline_at" TIMESTAMP(3);

CREATE INDEX "node_turns_trigger_message_id_idx" ON "node_turns"("trigger_message_id");

CREATE TABLE "node_tool_journal" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "node_id" TEXT NOT NULL,
    "turn_id" TEXT NOT NULL,
    "attempt_turn_id" TEXT NOT NULL,
    "call_key" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "args_hash" TEXT NOT NULL,
    "repeat" INTEGER NOT NULL DEFAULT 0,
    "state" TEXT NOT NULL DEFAULT 'recorded',
    "side_effect" BOOLEAN NOT NULL,
    "label" TEXT,
    "summary" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatched_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "node_tool_journal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "node_steers" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "node_id" TEXT NOT NULL,
    "room_id" TEXT,
    "kind" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "operation" TEXT NOT NULL,
    "message_id" TEXT,
    "job_id" TEXT,
    "outcome" TEXT NOT NULL DEFAULT 'pending',
    "handed_at" TIMESTAMP(3),
    "children" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMP(3),

    CONSTRAINT "node_steers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "node_tool_journal_turn_id_call_key_key" ON "node_tool_journal"("turn_id", "call_key");
CREATE INDEX "node_tool_journal_attempt_turn_id_idx" ON "node_tool_journal"("attempt_turn_id");
CREATE INDEX "node_tool_journal_user_id_created_at_idx" ON "node_tool_journal"("user_id", "created_at");
CREATE INDEX "node_steers_node_id_created_at_idx" ON "node_steers"("node_id", "created_at");
CREATE INDEX "node_steers_target_target_id_idx" ON "node_steers"("target", "target_id");
CREATE INDEX "node_steers_user_id_created_at_idx" ON "node_steers"("user_id", "created_at");

ALTER TABLE "node_tool_journal" ADD CONSTRAINT "node_tool_journal_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "node_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "node_tool_journal" ADD CONSTRAINT "node_tool_journal_turn_id_fkey" FOREIGN KEY ("turn_id") REFERENCES "node_turns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "node_steers" ADD CONSTRAINT "node_steers_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "node_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
