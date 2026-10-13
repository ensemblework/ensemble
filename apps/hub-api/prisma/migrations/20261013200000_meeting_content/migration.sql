-- Meeting notes are a page: the block editor document, with `notes` kept as its Markdown.
ALTER TABLE "meeting_sessions" ADD COLUMN "content" JSONB;
