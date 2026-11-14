CREATE TABLE "docs_chats" (
  "user_id" TEXT NOT NULL PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "generation" INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE "docs_chat_turns" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "question" TEXT NOT NULL,
  "answer" TEXT NOT NULL,
  "found" BOOLEAN NOT NULL,
  "sources" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "docs_chat_turns_user_id_created_at_id_idx" ON "docs_chat_turns"("user_id", "created_at", "id");
