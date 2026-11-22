-- A rule can end (docs/35 §8.13): an Ensemble Node's answer for this run about the agent's own calls is kept on the
-- computer for its plan or conversation until Ensemble on the web stops answering from it. Additive: one nullable column.
ALTER TABLE "decision_rules" ADD COLUMN "expires_at" TIMESTAMP(3);
