-- Room events, status nudges and catch-up (docs/35 §12.12, ensemble-node design C5).

ALTER TABLE "node_room_members" ADD COLUMN "seen_at" TIMESTAMP(3);
ALTER TABLE "node_room_members" ADD COLUMN "digest_at" TIMESTAMP(3);

CREATE TABLE "node_room_events" (
    "id" TEXT NOT NULL,
    "room_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "space_id" TEXT,
    "subject_kind" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "actor_account_id" TEXT,
    "actor_node_id" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "dedupe_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliver_after" TIMESTAMP(3) NOT NULL,
    "delivered_at" TIMESTAMP(3),
    "message_id" TEXT,
    CONSTRAINT "node_room_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "node_room_events_room_id_user_id_dedupe_key_key" ON "node_room_events"("room_id", "user_id", "dedupe_key");
CREATE INDEX "node_room_events_delivered_at_deliver_after_idx" ON "node_room_events"("delivered_at", "deliver_after");
CREATE INDEX "node_room_events_room_id_user_id_created_at_idx" ON "node_room_events"("room_id", "user_id", "created_at");
ALTER TABLE "node_room_events" ADD CONSTRAINT "node_room_events_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "node_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "node_room_tasks" (
    "room_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "assignee" TEXT,
    "status" TEXT NOT NULL,
    "task_updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "node_room_tasks_pkey" PRIMARY KEY ("room_id", "task_id")
);
ALTER TABLE "node_room_tasks" ADD CONSTRAINT "node_room_tasks_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "node_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "node_room_feeds" (
    "room_id" TEXT NOT NULL,
    "space_id" TEXT NOT NULL,
    "scanned_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "node_room_feeds_pkey" PRIMARY KEY ("room_id")
);
CREATE INDEX "node_room_feeds_space_id_idx" ON "node_room_feeds"("space_id");
ALTER TABLE "node_room_feeds" ADD CONSTRAINT "node_room_feeds_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "node_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "node_room_pages" (
    "id" TEXT NOT NULL,
    "room_id" TEXT NOT NULL,
    "space_id" TEXT NOT NULL,
    "page_id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'watched',
    "watchers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "node_room_pages_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "node_room_pages_room_id_page_id_key" ON "node_room_pages"("room_id", "page_id");
ALTER TABLE "node_room_pages" ADD CONSTRAINT "node_room_pages_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "node_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
