-- CreateTable
CREATE TABLE "included_usage" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "answered_by" TEXT,
    "purpose" TEXT,
    "status" TEXT NOT NULL DEFAULT 'reserved',
    "estimated_input_tokens" INTEGER NOT NULL,
    "max_output_tokens" INTEGER NOT NULL,
    "reserved_usd" DECIMAL(20,10) NOT NULL,
    "usd" DECIMAL(20,10) NOT NULL DEFAULT 0,
    "input_usd" DECIMAL(20,10) NOT NULL DEFAULT 0,
    "output_usd" DECIMAL(20,10) NOT NULL DEFAULT 0,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_read_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_write_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMP(3),

    CONSTRAINT "included_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "included_periods" (
    "period" TEXT NOT NULL,
    "spent_usd" DECIMAL(20,10) NOT NULL DEFAULT 0,
    "reserved_usd" DECIMAL(20,10) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "included_periods_pkey" PRIMARY KEY ("period")
);

-- CreateIndex
CREATE INDEX "included_usage_account_id_period_idx" ON "included_usage"("account_id", "period");

-- CreateIndex
CREATE INDEX "included_usage_status_created_at_idx" ON "included_usage"("status", "created_at");

-- AddForeignKey
ALTER TABLE "included_usage" ADD CONSTRAINT "included_usage_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
