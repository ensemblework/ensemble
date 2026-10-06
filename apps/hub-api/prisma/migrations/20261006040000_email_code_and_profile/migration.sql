-- Email verification now stores short hashed codes with attempt counts.
-- Profile fields capture the required "About you" step without forcing
-- existing onboarded accounts through it again.

ALTER TABLE "email_tokens" ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "gender" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "profession" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "organization" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "heard_from" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "profile_completed_at" TIMESTAMP(3);

UPDATE "users"
SET "profile_completed_at" = "onboarding_completed_at"
WHERE "profile_completed_at" IS NULL
  AND "onboarding_completed_at" IS NOT NULL;
