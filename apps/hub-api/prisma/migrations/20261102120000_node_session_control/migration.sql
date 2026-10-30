-- Ensemble Node session control (docs/35 §8.8–§8.11): observed run settings, the watchdog's record per
-- run, the session events a node's work board reads, and Needs me requests that close with their work.

-- AlterTable
ALTER TABLE "workspace_jobs" ADD COLUMN     "observed_settings" JSONB;

-- AlterTable
ALTER TABLE "node_runs" ADD COLUMN     "watchdog" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "node_session_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "node_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "job_id" TEXT,
    "action" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "via" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "node_session_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "node_session_events_node_id_created_at_idx" ON "node_session_events"("node_id", "created_at");

-- CreateIndex
CREATE INDEX "node_session_events_session_id_created_at_idx" ON "node_session_events"("session_id", "created_at");

-- AddForeignKey
ALTER TABLE "node_session_events" ADD CONSTRAINT "node_session_events_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "node_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A run's Needs me requests end with it (docs/05 §5). When a run reaches an end (succeeded, failed,
-- cancelled, interrupted or blocked), its pending questions and permissions close as expired with the
-- reason "Its work ended.", in the same transaction, whichever code path ended it: the computer's
-- complete, the lease sweep, a stop, a restart, a revoked computer. A late answer is then refused
-- (`applyAnswer` in routes/decisions.ts). The reason text is `WORK_ENDED` in lib/decisions.ts.
CREATE OR REPLACE FUNCTION "close_decisions_with_their_work"() RETURNS TRIGGER AS $$
BEGIN
  UPDATE "agent_decisions"
  SET "status" = 'expired', "reason" = 'Its work ended.', "decided_at" = (NOW() AT TIME ZONE 'UTC')
  WHERE "session_id" = NEW."id" AND "user_id" = NEW."user_id" AND "source" = 'ensemble' AND "status" = 'pending';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "workspace_jobs_close_decisions"
AFTER UPDATE OF "status" ON "workspace_jobs"
FOR EACH ROW
WHEN (NEW."status" IN ('succeeded', 'failed', 'cancelled', 'interrupted', 'blocked') AND OLD."status" IS DISTINCT FROM NEW."status")
EXECUTE FUNCTION "close_decisions_with_their_work"();
