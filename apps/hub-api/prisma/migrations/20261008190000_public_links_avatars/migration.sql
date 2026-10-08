-- A picture avatar the person picked (`role.gender.n`, see packages/shared-types/src/avatars.ts).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "avatar" TEXT;

-- One item anyone with the link can open, with no account. At most 5 per account (sharing/links.ts).
CREATE TABLE IF NOT EXISTS "public_links" (
  "id" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "space_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "resource_id" TEXT NOT NULL,
  "title" TEXT NOT NULL DEFAULT '',
  "role" TEXT NOT NULL DEFAULT 'view',
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "opened_at" TIMESTAMP(3),
  "opens" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "public_links_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "public_links_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "public_links_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "public_links_token_key" ON "public_links"("token");
CREATE UNIQUE INDEX IF NOT EXISTS "public_links_space_id_kind_resource_id_key" ON "public_links"("space_id", "kind", "resource_id");
CREATE INDEX IF NOT EXISTS "public_links_created_by_idx" ON "public_links"("created_by");
