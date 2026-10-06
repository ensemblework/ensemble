ALTER TABLE "users" ADD COLUMN "email_verified_at" TIMESTAMP(3);

-- Existing password accounts came from the private/allowlisted deployment.
UPDATE "users" SET "email_verified_at" = "created_at" WHERE "password_hash" IS NOT NULL;

CREATE TABLE "auth_identities" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "email" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "auth_identities_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "auth_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "auth_identities_provider_subject_key" ON "auth_identities"("provider", "subject");
CREATE UNIQUE INDEX "auth_identities_user_id_provider_key" ON "auth_identities"("user_id", "provider");

CREATE TABLE "email_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "email_tokens_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "email_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "email_tokens_user_id_kind_idx" ON "email_tokens"("user_id", "kind");
CREATE INDEX "email_tokens_expires_at_idx" ON "email_tokens"("expires_at");

CREATE TABLE "auth_flows" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "code_verifier" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "user_id" TEXT,
    "session_id" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "auth_flows_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "auth_flows_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "auth_flows_expires_at_idx" ON "auth_flows"("expires_at");
