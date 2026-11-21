-- Node memories with a scope, a key, where each came from and earlier revisions (docs/35 §5.6). Existing rows are the node's own.
ALTER TABLE "node_memories" ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'node',
ADD COLUMN "scope_id" TEXT,
ADD COLUMN "key" TEXT,
ADD COLUMN "source_message_id" TEXT,
ADD COLUMN "turn_id" TEXT,
ADD COLUMN "superseded_by_id" TEXT,
ADD COLUMN "pinned" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "archived_at" TIMESTAMP(3),
ADD COLUMN "last_used_at" TIMESTAMP(3),
ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "node_memories" SET "updated_at" = "created_at";

CREATE INDEX "node_memories_user_id_scope_idx" ON "node_memories"("user_id", "scope");
CREATE INDEX "node_memories_superseded_by_id_idx" ON "node_memories"("superseded_by_id");
