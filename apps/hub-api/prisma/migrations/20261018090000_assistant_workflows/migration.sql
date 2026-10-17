CREATE TABLE "assistant_workflows" (
  "id" TEXT PRIMARY KEY,
  "user_id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "plan_hash" TEXT NOT NULL,
  "steps" JSONB NOT NULL DEFAULT '[]',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "assistant_workflows_user_id_conversation_id_idx" ON "assistant_workflows"("user_id", "conversation_id");
