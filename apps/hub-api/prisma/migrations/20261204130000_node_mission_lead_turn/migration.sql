-- Ensemble Node orchestration (docs/35 §6.2): the lead's plan turn now running for a mission, and whether it
-- reports or re-plans, set in the transaction that starts it, so only that turn's end concludes the
-- mission or ends its re-plan. Additive: one nullable column.
ALTER TABLE "node_missions" ADD COLUMN "lead_turn" JSONB;
