-- Captures as evidence (docs/35 §8.16, docs/32 §7): a node's own screenshots and videos (its device
-- tools, no job: node_id and its tool operation), media the computer holds for the owner to preview
-- first (held, never sent to a model or shown in a chat until released), the computer that keeps a
-- file, a video's poster and preview images (variant_of, variant), and what capture measured.

-- AlterTable
ALTER TABLE "job_evidence" ALTER COLUMN "job_id" DROP NOT NULL;
ALTER TABLE "job_evidence" ADD COLUMN "node_id" TEXT;
ALTER TABLE "job_evidence" ADD COLUMN "operation" TEXT;
ALTER TABLE "job_evidence" ADD COLUMN "held" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "job_evidence" ADD COLUMN "hold_reason" TEXT;
ALTER TABLE "job_evidence" ADD COLUMN "device_id" TEXT;
ALTER TABLE "job_evidence" ADD COLUMN "variant_of" TEXT;
ALTER TABLE "job_evidence" ADD COLUMN "variant" TEXT;
ALTER TABLE "job_evidence" ADD COLUMN "details" JSONB;

-- CreateIndex
CREATE INDEX "job_evidence_node_id_created_at_idx" ON "job_evidence"("node_id", "created_at");

-- CreateIndex
CREATE INDEX "job_evidence_variant_of_idx" ON "job_evidence"("variant_of");
