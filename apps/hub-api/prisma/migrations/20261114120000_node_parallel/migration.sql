-- Parallel work in one repository (ensemble-node B13): integration steps, and what steps use on a computer.

-- AlterTable
ALTER TABLE "node_steps" ADD COLUMN     "integrates" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "resource_claims" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'held',
    "mission_id" TEXT,
    "step_id" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "sequence" BIGSERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resource_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "resource_claims_kind_key_state_idx" ON "resource_claims"("kind", "key", "state");

-- CreateIndex
CREATE INDEX "resource_claims_holder_idx" ON "resource_claims"("holder");

-- CreateIndex
CREATE INDEX "resource_claims_mission_id_idx" ON "resource_claims"("mission_id");

-- CreateIndex
CREATE UNIQUE INDEX "resource_claims_kind_key_holder_key" ON "resource_claims"("kind", "key", "holder");
