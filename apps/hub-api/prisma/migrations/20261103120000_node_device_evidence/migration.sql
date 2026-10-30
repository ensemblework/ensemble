-- Evidence a run's worker attached (evidence/, docs/32 §7): screenshots, videos, traces, reports, logs
-- and files, owner-only. The bytes are in the blob store (storage_key) or on the row (bytes); a computer
-- with evidence upload off sends only the name and size (local).

-- CreateTable
CREATE TABLE "job_evidence" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "bytes" BYTEA,
    "local" BOOLEAN NOT NULL DEFAULT false,
    "caption" TEXT,
    "requirement_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "job_evidence_job_id_created_at_idx" ON "job_evidence"("job_id", "created_at");

-- CreateIndex
CREATE INDEX "job_evidence_user_id_created_at_idx" ON "job_evidence"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "job_evidence" ADD CONSTRAINT "job_evidence_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "workspace_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
