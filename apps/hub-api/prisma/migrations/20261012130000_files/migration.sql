-- Files (docs/32_FILES.md): where an imported file came from, the formatting a PDF or Word
-- original had when it became a page, and the page each file became.
ALTER TABLE "context_documents" ADD COLUMN "style" JSONB;
ALTER TABLE "context_documents" ADD COLUMN "source" JSONB;

ALTER TABLE "task_pages" ADD COLUMN "source_file_id" TEXT;
CREATE INDEX "task_pages_source_file_id_idx" ON "task_pages"("source_file_id");
ALTER TABLE "task_pages" ADD CONSTRAINT "task_pages_source_file_id_fkey" FOREIGN KEY ("source_file_id") REFERENCES "context_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A removed file's text left the agents' view with it.
UPDATE "artifacts" AS a SET "deleted_at" = d."deleted_at"
FROM "context_documents" AS d
WHERE d."artifact_id" = a."id" AND d."deleted_at" IS NOT NULL AND a."deleted_at" IS NULL;
