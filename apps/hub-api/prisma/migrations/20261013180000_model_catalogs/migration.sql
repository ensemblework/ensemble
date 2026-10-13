-- The models each key reaches, kept for a week instead of asking every provider on each visit (docs/01 §6).
CREATE TABLE "model_catalogs" (
    "user_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "entry" JSONB NOT NULL,
    "key_hint" TEXT NOT NULL DEFAULT '',
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_catalogs_pkey" PRIMARY KEY ("user_id","provider")
);
