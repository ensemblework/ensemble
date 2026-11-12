-- The account that made a key, so a Context Bridge key reaches that account's other spaces
-- (docs/CONTEXT_BRIDGE.md §4). Where it is null, lib/auth.ts takes the key's own row as the account
-- when that row is an account (no owner_id), and keeps any other key in its space.
ALTER TABLE "api_tokens" ADD COLUMN "account_id" TEXT;

-- Who approved an `ensemble login`, for the key minted at the exchange.
ALTER TABLE "cli_auth_requests" ADD COLUMN "account_id" TEXT;
