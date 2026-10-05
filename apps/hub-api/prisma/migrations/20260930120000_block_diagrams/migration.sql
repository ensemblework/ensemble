-- Block diagrams. One row per diagram, owned by a user.
-- `document` is the versioned JSON model (maps keyed by stable id).
-- `version` increments on each save for optimistic concurrency.

CREATE TABLE IF NOT EXISTS "block_diagrams" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'Untitled diagram',
    "source" TEXT NOT NULL DEFAULT '',
    "document" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "block_diagrams_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "block_diagrams_user_id_updated_at_idx" ON "block_diagrams"("user_id", "updated_at");

ALTER TABLE "block_diagrams" ADD CONSTRAINT "block_diagrams_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
