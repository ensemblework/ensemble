-- Ensemble Node: a temporary helper node works for another node (parent_node_id); each node has a
-- thinking level for its chat model (null: low).
ALTER TABLE "node_agents" ADD COLUMN "parent_node_id" TEXT;
ALTER TABLE "node_agents" ADD COLUMN "effort" TEXT;
CREATE INDEX "node_agents_parent_node_id_idx" ON "node_agents"("parent_node_id");

-- Secrets a person saved on their own computer for its agent runs (lib/run-secrets.ts), encrypted with
-- that computer's key. Ensemble on the web never stores one.
CREATE TABLE "run_secrets" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "run_secrets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "run_secrets_user_id_name_key" ON "run_secrets"("user_id", "name");
