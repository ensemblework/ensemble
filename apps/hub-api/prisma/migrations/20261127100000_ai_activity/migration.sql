-- The person's AI activity (docs/07 §1.4): model calls with their prompt and answer, tool calls with their
-- input and output, errors with their stack, and the server's and their computers' warnings and errors.
-- Deleted after 30 days (jobs/retention.ts).
CREATE TABLE "ai_activity" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "purpose" TEXT,
    "app" TEXT,
    "model" TEXT,
    "name" TEXT,
    "ok" BOOLEAN,
    "duration_ms" INTEGER,
    "input" JSONB,
    "output" JSONB,
    "error" TEXT,
    "stack" TEXT,
    "refs" JSONB NOT NULL DEFAULT '{}',
    "meta" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "ai_activity_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ai_activity_user_id_ts_idx" ON "ai_activity"("user_id", "ts");
CREATE INDEX "ai_activity_user_id_kind_ts_idx" ON "ai_activity"("user_id", "kind", "ts");

ALTER TABLE "ai_activity" ADD CONSTRAINT "ai_activity_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
