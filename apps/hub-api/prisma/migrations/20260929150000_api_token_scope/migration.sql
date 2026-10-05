-- Context Bridge (mcp branch): personal tokens carry a scope.
-- "full" can act as the user (editor hooks); "bridge" may only read /api/bridge.
-- The mcp branch added this column with `prisma db push` only; this makes it a migration.
ALTER TABLE "api_tokens" ADD COLUMN IF NOT EXISTS "scope" TEXT NOT NULL DEFAULT 'full';
