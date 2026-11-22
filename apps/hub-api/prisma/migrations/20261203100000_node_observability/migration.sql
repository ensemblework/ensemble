-- Ensemble Node observability (docs/35 §5.6): each turn's real outcome and where it ran, one trace per
-- turn (sizes, hashes, timings and models, never content) and the decisions Node makes, with the
-- heuristics config's version. Additive: two nullable columns and two new tables that go with their turn.
ALTER TABLE "node_turns" ADD COLUMN     "outcome" TEXT,
ADD COLUMN     "placement" JSONB;

CREATE TABLE "node_turn_traces" (
    "turn_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "node_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "instruction_version" TEXT,
    "instruction_hash" TEXT,
    "sections" JSONB,
    "tool_schema_hash" TEXT,
    "tool_count" INTEGER,
    "model_requested" TEXT,
    "model_sent" TEXT,
    "model_reported" TEXT,
    "provider" TEXT,
    "effort" TEXT,
    "placement" JSONB,
    "tokens_in" INTEGER,
    "tokens_out" INTEGER,
    "credits" DOUBLE PRECISION,
    "cost_usd" DOUBLE PRECISION,
    "calls" JSONB NOT NULL DEFAULT '[]',
    "selected" JSONB,
    "verification" JSONB,
    "report" JSONB,
    "loop" JSONB,
    "error" TEXT,

    CONSTRAINT "node_turn_traces_pkey" PRIMARY KEY ("turn_id")
);

CREATE TABLE "node_decisions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "node_id" TEXT,
    "turn_id" TEXT,
    "kind" TEXT NOT NULL,
    "config_version" TEXT NOT NULL,
    "inputs" JSONB NOT NULL DEFAULT '{}',
    "scores" JSONB,
    "choice" JSONB NOT NULL DEFAULT '{}',
    "ambiguous" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "node_decisions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "node_turn_traces_user_id_created_at_idx" ON "node_turn_traces"("user_id", "created_at");
CREATE INDEX "node_decisions_user_id_created_at_idx" ON "node_decisions"("user_id", "created_at");
CREATE INDEX "node_decisions_turn_id_idx" ON "node_decisions"("turn_id");
CREATE INDEX "node_decisions_node_id_idx" ON "node_decisions"("node_id");

ALTER TABLE "node_turn_traces" ADD CONSTRAINT "node_turn_traces_turn_id_fkey" FOREIGN KEY ("turn_id") REFERENCES "node_turns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "node_decisions" ADD CONSTRAINT "node_decisions_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "node_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "node_decisions" ADD CONSTRAINT "node_decisions_turn_id_fkey" FOREIGN KEY ("turn_id") REFERENCES "node_turns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
