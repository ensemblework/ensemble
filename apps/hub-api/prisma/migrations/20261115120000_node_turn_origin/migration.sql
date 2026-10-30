-- A turn tried again (rate limit) or resumed after a restart points at the turn it continues, so it
-- keeps that turn's operation and peer request (node/queue.ts retryLater and recoverTurns).
ALTER TABLE "node_turns" ADD COLUMN "origin_turn_id" TEXT;
