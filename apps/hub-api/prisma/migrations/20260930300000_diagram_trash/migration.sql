-- Soft-delete diagrams so Trash can restore them. Links and revisions stay until the row is emptied.
ALTER TABLE "block_diagrams" ADD COLUMN "deleted_at" TIMESTAMP(3);
CREATE INDEX "block_diagrams_user_id_deleted_at_idx" ON "block_diagrams"("user_id", "deleted_at");
