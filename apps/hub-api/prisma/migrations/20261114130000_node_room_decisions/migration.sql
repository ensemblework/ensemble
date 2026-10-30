-- Contracts, the decisions log and the room steward (docs/35 §12.14, ensemble-node design C7).

ALTER TABLE "node_room_pages" ADD COLUMN "seen_revision" INTEGER;
ALTER TABLE "node_room_pages" ADD COLUMN "seen_text" TEXT;

CREATE TABLE "node_room_decisions" (
    "id" TEXT NOT NULL,
    "room_id" TEXT NOT NULL,
    "space_id" TEXT NOT NULL,
    "page_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "said_by" TEXT NOT NULL,
    "logged_by" TEXT NOT NULL,
    "supersedes_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "node_room_decisions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "node_room_decisions_room_id_message_id_key" ON "node_room_decisions"("room_id", "message_id");
ALTER TABLE "node_room_decisions" ADD CONSTRAINT "node_room_decisions_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "node_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
