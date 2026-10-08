-- Ensemble spaces. A space is a user row owned by the signed-in account. Every
-- record is already scoped by user_id, so a space shares nothing with its
-- siblings. owner_id is null for the account itself, which is also its first space.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "owner_id" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "space_name" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "space_icon" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "space_position" INTEGER NOT NULL DEFAULT 0;
-- On the account: settings, model keys and shortcuts are mirrored to every space.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "space_settings_sync" BOOLEAN NOT NULL DEFAULT false;
-- On the account: the space a new sign-in opens.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_space_id" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_owner_id_fkey') THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "users_owner_id_idx" ON "users"("owner_id");
