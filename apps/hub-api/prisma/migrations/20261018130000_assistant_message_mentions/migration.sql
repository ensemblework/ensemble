ALTER TABLE "assistant_messages" ADD COLUMN "mentions" JSONB NOT NULL DEFAULT '[]';
