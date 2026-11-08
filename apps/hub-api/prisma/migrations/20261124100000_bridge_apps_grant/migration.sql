-- Context Bridge keys that may use the account's connected apps (docs/CONTEXT_BRIDGE.md §5).
ALTER TABLE "api_tokens" ADD COLUMN "can_use_apps" BOOLEAN NOT NULL DEFAULT false;
