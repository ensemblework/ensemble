-- Context Bridge keys that may use the account's connected apps (docs/CONTEXT_BRIDGE.md §5).
ALTER TABLE "api_tokens" ADD COLUMN "can_use_apps" BOOLEAN NOT NULL DEFAULT false;

-- "Changes" now covers Ensemble's everyday writes (bridge/actions.ts), not only the three task writes a
-- key made before this release was allowed. Those keys keep reading; making a new key, or `ensemble
-- login` again, asks for the wider grant.
UPDATE "api_tokens" SET "can_write" = false WHERE "scope" = 'bridge' AND "can_write" = true;
