-- Crew plans (node/plans.ts): a lead's plan card, the turns and runs of its steps, and cards shown inside it.
ALTER TABLE "node_messages" ADD COLUMN "plan_id" TEXT;
ALTER TABLE "node_runs" ADD COLUMN "plan_id" TEXT;
ALTER TABLE "node_runs" ADD COLUMN "plan_step" TEXT;
ALTER TABLE "node_turns" ADD COLUMN "plan_id" TEXT;
ALTER TABLE "node_turns" ADD COLUMN "plan_step" TEXT;
ALTER TABLE "node_turns" ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "node_turns" ADD COLUMN "run_after" TIMESTAMP(3);
CREATE INDEX "node_runs_plan_id_idx" ON "node_runs"("plan_id");
