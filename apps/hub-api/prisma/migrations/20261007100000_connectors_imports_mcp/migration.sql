-- Connector store, imports from other apps, and remote MCP connections.
-- Additive only: new enum values, nullable columns, two new tables.

ALTER TYPE "TaskSource" ADD VALUE IF NOT EXISTS 'jira';
ALTER TYPE "TaskSource" ADD VALUE IF NOT EXISTS 'trello';
ALTER TYPE "TaskSource" ADD VALUE IF NOT EXISTS 'asana';
ALTER TYPE "TaskSource" ADD VALUE IF NOT EXISTS 'todoist';
ALTER TYPE "TaskSource" ADD VALUE IF NOT EXISTS 'clickup';
ALTER TYPE "TaskSource" ADD VALUE IF NOT EXISTS 'monday';

ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "labels" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "external_source" TEXT;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "external_id" TEXT;
ALTER TABLE "task_pages" ADD COLUMN IF NOT EXISTS "external_source" TEXT;
ALTER TABLE "task_pages" ADD COLUMN IF NOT EXISTS "external_id" TEXT;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "external_source" TEXT;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "external_id" TEXT;
ALTER TABLE "oauth_tokens" ADD COLUMN IF NOT EXISTS "meta" JSONB NOT NULL DEFAULT '{}';

CREATE UNIQUE INDEX IF NOT EXISTS "tasks_user_id_external_source_external_id_key" ON "tasks"("user_id", "external_source", "external_id");
CREATE UNIQUE INDEX IF NOT EXISTS "task_pages_user_id_external_source_external_id_key" ON "task_pages"("user_id", "external_source", "external_id");
CREATE UNIQUE INDEX IF NOT EXISTS "projects_user_id_external_source_external_id_key" ON "projects"("user_id", "external_source", "external_id");

CREATE TABLE IF NOT EXISTS "import_jobs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "options" JSONB NOT NULL DEFAULT '{}',
    "counts" JSONB NOT NULL DEFAULT '{}',
    "progress" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "import_jobs_user_id_created_at_idx" ON "import_jobs"("user_id", "created_at");

CREATE TABLE IF NOT EXISTS "mcp_connections" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "server_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "client_info" TEXT,
    "tokens" TEXT,
    "expires_at" TIMESTAMP(3),
    "code_verifier" TEXT,
    "oauth_state" TEXT,
    "state_expires_at" TIMESTAMP(3),
    "return_to" TEXT,
    "tools" JSONB NOT NULL DEFAULT '[]',
    "tools_synced_at" TIMESTAMP(3),
    "disabled_tools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "mcp_connections_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_connections_oauth_state_key" ON "mcp_connections"("oauth_state");
CREATE INDEX IF NOT EXISTS "mcp_connections_user_id_idx" ON "mcp_connections"("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_connections_user_id_server_id_key" ON "mcp_connections"("user_id", "server_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'import_jobs_user_id_fkey') THEN
    ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mcp_connections_user_id_fkey') THEN
    ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
