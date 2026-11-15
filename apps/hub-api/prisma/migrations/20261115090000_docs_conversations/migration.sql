ALTER TABLE "docs_chat_turns" ADD COLUMN "chat_id" TEXT NOT NULL DEFAULT 'legacy';
CREATE INDEX "docs_chat_turns_user_id_chat_id_created_at_id_idx" ON "docs_chat_turns"("user_id", "chat_id", "created_at", "id");
