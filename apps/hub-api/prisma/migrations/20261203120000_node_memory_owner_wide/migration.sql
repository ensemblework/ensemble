-- Owner-wide memories (scope owner) are the owner's, not the node's that wrote them: they outlive it, and the
-- writer is kept as author_node_id (docs/35 §5.6). Existing node-written rows keep their writer.
ALTER TABLE "node_memories" ALTER COLUMN "node_id" DROP NOT NULL;
ALTER TABLE "node_memories" ADD COLUMN "author_node_id" TEXT;
UPDATE "node_memories" SET "author_node_id" = "node_id" WHERE "turn_id" IS NOT NULL;
UPDATE "node_memories" SET "node_id" = NULL WHERE "scope" = 'owner';

-- Context DB retrieval (context/retrieve.ts): a meeting note's notes session, and an account's newest tasks.
CREATE INDEX "meeting_sessions_meeting_note_id_idx" ON "meeting_sessions"("meeting_note_id");
CREATE INDEX "tasks_user_id_updated_at_idx" ON "tasks"("user_id", "updated_at");
