CREATE TABLE "page_boards" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "columns" JSONB NOT NULL,
    "tiles" JSONB NOT NULL DEFAULT '["count","distribution"]',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "page_boards_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "page_boards_user_id_created_at_idx" ON "page_boards"("user_id", "created_at");
ALTER TABLE "task_pages"
    ADD COLUMN "board_id" TEXT,
    ADD COLUMN "board_column_id" TEXT,
    ADD COLUMN "board_order" DOUBLE PRECISION NOT NULL DEFAULT 0;
CREATE INDEX "task_pages_user_id_board_id_board_column_id_board_order_idx"
    ON "task_pages"("user_id", "board_id", "board_column_id", "board_order");
ALTER TABLE "task_pages" ADD CONSTRAINT "task_pages_board_id_fkey"
    FOREIGN KEY ("board_id") REFERENCES "page_boards"("id") ON DELETE SET NULL ON UPDATE CASCADE;
