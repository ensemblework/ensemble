-- A task Ensemble opened in an agent's own app or window (docs/30_ENGINES.md).
CREATE TABLE "agent_handoffs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "app" TEXT NOT NULL,
    "folder" TEXT NOT NULL,
    "marker" TEXT NOT NULL,
    "sessions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'open',
    "summary" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_handoffs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_handoffs_marker_key" ON "agent_handoffs"("marker");
CREATE INDEX "agent_handoffs_user_id_status_idx" ON "agent_handoffs"("user_id", "status");

ALTER TABLE "agent_handoffs" ADD CONSTRAINT "agent_handoffs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
