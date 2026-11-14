-- AlterTable
ALTER TABLE "api_tokens" ADD COLUMN     "expires_at" TIMESTAMP(3),
ADD COLUMN     "oauth_grant_id" TEXT,
ADD COLUMN     "oauth_scopes" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "mcp_oauth_clients" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "redirect_uris" TEXT[],
    "auth_method" TEXT NOT NULL,
    "refresh_mode" TEXT NOT NULL DEFAULT 'rotate',
    "secret_hash" TEXT,
    "metadata_expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_oauth_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_oauth_requests" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "requested_scopes" TEXT[],
    "state" TEXT,
    "code_challenge" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "session_hash" TEXT,
    "csrf_hash" TEXT,
    "account_id" TEXT,
    "space_id" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "decision" TEXT NOT NULL DEFAULT 'pending',
    "code_hash" TEXT,
    "used_at" TIMESTAMP(3),

    CONSTRAINT "mcp_oauth_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_oauth_grants" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "scopes" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "mcp_oauth_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_oauth_refresh_tokens" (
    "token_hash" TEXT NOT NULL,
    "grant_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "scopes" TEXT[],
    "used_at" TIMESTAMP(3),

    CONSTRAINT "mcp_oauth_refresh_tokens_pkey" PRIMARY KEY ("token_hash")
);

-- CreateIndex
CREATE UNIQUE INDEX "mcp_oauth_requests_code_hash_key" ON "mcp_oauth_requests"("code_hash");

-- CreateIndex
CREATE INDEX "mcp_oauth_requests_expires_at_idx" ON "mcp_oauth_requests"("expires_at");

-- CreateIndex
CREATE INDEX "mcp_oauth_requests_account_id_idx" ON "mcp_oauth_requests"("account_id");

-- CreateIndex
CREATE INDEX "mcp_oauth_grants_account_id_created_at_idx" ON "mcp_oauth_grants"("account_id", "created_at");

-- CreateIndex
CREATE INDEX "mcp_oauth_refresh_tokens_grant_id_idx" ON "mcp_oauth_refresh_tokens"("grant_id");

-- CreateIndex
CREATE INDEX "mcp_oauth_refresh_tokens_expires_at_idx" ON "mcp_oauth_refresh_tokens"("expires_at");

-- AddForeignKey
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_oauth_grant_id_fkey" FOREIGN KEY ("oauth_grant_id") REFERENCES "mcp_oauth_grants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_oauth_requests" ADD CONSTRAINT "mcp_oauth_requests_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "mcp_oauth_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_oauth_requests" ADD CONSTRAINT "mcp_oauth_requests_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_oauth_grants" ADD CONSTRAINT "mcp_oauth_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_oauth_grants" ADD CONSTRAINT "mcp_oauth_grants_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_oauth_grants" ADD CONSTRAINT "mcp_oauth_grants_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "mcp_oauth_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_oauth_refresh_tokens" ADD CONSTRAINT "mcp_oauth_refresh_tokens_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "mcp_oauth_grants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
