CREATE TABLE "interaction_events" (
  "id" BIGSERIAL NOT NULL,
  "user_id" TEXT NOT NULL,
  "session_key" TEXT NOT NULL,
  "at" TIMESTAMP(3) NOT NULL,
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "kind" TEXT NOT NULL,
  "surface" TEXT NOT NULL,
  "route" TEXT NOT NULL,
  "action" TEXT,
  "duration_ms" INTEGER,
  "props" JSONB NOT NULL DEFAULT '{}',
  "client" TEXT NOT NULL DEFAULT 'web',
  "viewport" TEXT,
  CONSTRAINT "interaction_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "interaction_events_user_id_at_idx" ON "interaction_events"("user_id", "at");
CREATE INDEX "interaction_events_at_idx" ON "interaction_events"("at");
CREATE INDEX "interaction_events_surface_at_idx" ON "interaction_events"("surface", "at");
ALTER TABLE "interaction_events" ADD CONSTRAINT "interaction_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
