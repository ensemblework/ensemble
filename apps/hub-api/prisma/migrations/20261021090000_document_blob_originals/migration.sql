-- Originals may live in blob storage (ENSEMBLE_FILE_STORAGE=azure-blob); the row then keeps only the key.
ALTER TABLE "context_documents" ALTER COLUMN "original" DROP NOT NULL;
ALTER TABLE "context_documents" ADD COLUMN "blob_key" TEXT;
ALTER TABLE "context_documents" ADD CONSTRAINT "context_documents_original_or_blob" CHECK ("original" IS NOT NULL OR "blob_key" IS NOT NULL);
CREATE INDEX "context_documents_blob_key_idx" ON "context_documents"("blob_key");
