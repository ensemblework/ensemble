-- Ensemble Node runs in agent sessions: the session a run belongs to (its first run's job id, which
-- also decides which node owns the session), what the node asked, and whether its task stays off the board.
ALTER TABLE "node_runs" ADD COLUMN "session_id" TEXT;
ALTER TABLE "node_runs" ADD COLUMN "prompt" TEXT;
ALTER TABLE "node_runs" ADD COLUMN "direct" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "node_runs_session_id_idx" ON "node_runs"("session_id");
CREATE INDEX "node_runs_node_id_status_idx" ON "node_runs"("node_id", "status");
