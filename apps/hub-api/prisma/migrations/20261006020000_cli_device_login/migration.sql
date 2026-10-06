-- CLI device login (Plan E §3.1).
--
-- Additive only. Device/user codes are stored as SHA-256 hashes. The CLI token
-- and pairing code are minted at the one-time exchange and never stored raw.

CREATE TABLE IF NOT EXISTS "cli_auth_requests" (
    "id" TEXT NOT NULL,
    "device_code_hash" TEXT NOT NULL,
    "user_code_hash" TEXT NOT NULL,
    "client_name" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "requested_scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "approved_scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'pending',
    "user_id" TEXT,
    "token_id" TEXT,
    "pairing_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_polled_at" TIMESTAMP(3),
    "decided_at" TIMESTAMP(3),
    "consumed_at" TIMESTAMP(3),

    CONSTRAINT "cli_auth_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "cli_auth_requests_device_code_hash_key" ON "cli_auth_requests"("device_code_hash");
CREATE UNIQUE INDEX IF NOT EXISTS "cli_auth_requests_user_code_hash_key" ON "cli_auth_requests"("user_code_hash");
CREATE INDEX IF NOT EXISTS "cli_auth_requests_expires_at_idx" ON "cli_auth_requests"("expires_at");
CREATE INDEX IF NOT EXISTS "cli_auth_requests_user_id_created_at_idx" ON "cli_auth_requests"("user_id", "created_at");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cli_auth_requests_user_id_fkey') THEN
    ALTER TABLE "cli_auth_requests" ADD CONSTRAINT "cli_auth_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
