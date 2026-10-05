-- Bounded undo stack (docs/design/assistant-trash-comments.md §20).
-- Adds the patch column the new journal writes. Older rows keep inverse/forward;
-- an empty ops array is treated as unreadable and dropped instead of replayed.
ALTER TABLE "undo_entries" ADD COLUMN IF NOT EXISTS "ops" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "undo_entries" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'ui';
ALTER TABLE "undo_entries" ADD COLUMN IF NOT EXISTS "group_id" TEXT;
