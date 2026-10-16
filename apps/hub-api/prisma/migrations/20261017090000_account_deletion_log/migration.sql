CREATE TABLE "account_deletion_logs" (
  "email_key" TEXT PRIMARY KEY,
  "deleted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "account_deletion_logs_expires_at_idx" ON "account_deletion_logs"("expires_at");
