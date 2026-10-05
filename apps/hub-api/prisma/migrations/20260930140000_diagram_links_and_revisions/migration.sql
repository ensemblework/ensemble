-- Diagram history and the places a diagram is shown.
-- The first block-diagrams migration created block_diagrams only.

CREATE TABLE IF NOT EXISTS "block_diagram_revisions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "diagram_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "document" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "block_diagram_revisions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "diagram_links" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "diagram_id" TEXT NOT NULL,
    "target_kind" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "diagram_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "block_diagram_revisions_diagram_id_version_key" ON "block_diagram_revisions"("diagram_id", "version");
CREATE INDEX IF NOT EXISTS "block_diagram_revisions_user_id_diagram_id_idx" ON "block_diagram_revisions"("user_id", "diagram_id");
CREATE UNIQUE INDEX IF NOT EXISTS "diagram_links_diagram_id_target_kind_target_id_key" ON "diagram_links"("diagram_id", "target_kind", "target_id");
CREATE INDEX IF NOT EXISTS "diagram_links_user_id_target_kind_target_id_idx" ON "diagram_links"("user_id", "target_kind", "target_id");

DO $$ BEGIN
  ALTER TABLE "block_diagram_revisions" ADD CONSTRAINT "block_diagram_revisions_diagram_id_fkey" FOREIGN KEY ("diagram_id") REFERENCES "block_diagrams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "diagram_links" ADD CONSTRAINT "diagram_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "diagram_links" ADD CONSTRAINT "diagram_links_diagram_id_fkey" FOREIGN KEY ("diagram_id") REFERENCES "block_diagrams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
