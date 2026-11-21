-- Ensemble Node orchestration (docs/35 §6.2-6.4): each step keeps the task packet it was last given (a
-- versioned header with its body) and that packet's version, and names the step that replaced it after a
-- re-plan; a mission keeps the artifacts its steps work from (with their hashes) and what its watchdog
-- already raised; a verify or review step names the acceptance criteria it judges. Additive: four nullable
-- or defaulted columns on node_steps, two on node_missions.
ALTER TABLE "node_steps" ADD COLUMN     "packet" JSONB,
ADD COLUMN     "packet_version" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "superseded_by" TEXT,
ADD COLUMN     "acceptance_ids" TEXT[] DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "node_missions" ADD COLUMN     "artifacts" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "watchdog" JSONB NOT NULL DEFAULT '{}';
