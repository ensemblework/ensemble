-- Sharing. People are accounts (users rows with owner_id null). Every table here is
-- additive; existing rows are untouched.

-- The people an account shares with. At most five per account (enforced in the API).
CREATE TABLE IF NOT EXISTS "contacts" (
  "id" TEXT NOT NULL,
  "owner_id" TEXT NOT NULL,
  "contact_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "contacts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "contacts_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "contacts_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "contacts_owner_id_contact_id_key" ON "contacts"("owner_id", "contact_id");
CREATE INDEX IF NOT EXISTS "contacts_contact_id_idx" ON "contacts"("contact_id");

-- Whole-space access for another account. At most two per space.
CREATE TABLE IF NOT EXISTS "space_members" (
  "id" TEXT NOT NULL,
  "space_id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'editor',
  "added_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "space_members_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "space_members_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "space_members_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "space_members_space_id_account_id_key" ON "space_members"("space_id", "account_id");
CREATE INDEX IF NOT EXISTS "space_members_account_id_idx" ON "space_members"("account_id");

-- One item in a space, shared with one account.
CREATE TABLE IF NOT EXISTS "shares" (
  "id" TEXT NOT NULL,
  "space_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "resource_id" TEXT NOT NULL,
  "title" TEXT NOT NULL DEFAULT '',
  "recipient_id" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'view',
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "opened_at" TIMESTAMP(3),
  CONSTRAINT "shares_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "shares_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "shares_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "shares_space_id_kind_resource_id_recipient_id_key" ON "shares"("space_id", "kind", "resource_id", "recipient_id");
CREATE INDEX IF NOT EXISTS "shares_recipient_id_idx" ON "shares"("recipient_id");

-- Ownership changes. A space may change owner once.
CREATE TABLE IF NOT EXISTS "space_transfers" (
  "id" TEXT NOT NULL,
  "space_id" TEXT NOT NULL,
  "from_account_id" TEXT NOT NULL,
  "to_account_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "space_transfers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "space_transfers_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "space_transfers_space_id_key" ON "space_transfers"("space_id");

-- Who acted, inside a space that more than one person can open. Null means the space owner.
ALTER TABLE "workspace_jobs" ADD COLUMN IF NOT EXISTS "runner_account_id" TEXT;
ALTER TABLE "assistant_conversations" ADD COLUMN IF NOT EXISTS "account_id" TEXT;
ALTER TABLE "undo_entries" ADD COLUMN IF NOT EXISTS "actor_account_id" TEXT;
ALTER TABLE "page_discussions" ADD COLUMN IF NOT EXISTS "author_account_id" TEXT;
CREATE INDEX IF NOT EXISTS "workspace_jobs_runner_account_id_idx" ON "workspace_jobs"("runner_account_id");
