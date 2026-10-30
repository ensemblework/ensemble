-- Rooms with other people, v2 (docs/35 §12): turns bound to where their answer goes, peer requests
-- between people, and each person's own settings for a room.

-- A question, share, review or work request from one person to another, through the other's lead.
CREATE TABLE "node_peer_requests" (
    "id" TEXT NOT NULL,
    "room_id" TEXT NOT NULL,
    "from_account_id" TEXT NOT NULL,
    "from_node_id" TEXT,
    "to_account_id" TEXT NOT NULL,
    "to_node_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "refs" JSONB NOT NULL DEFAULT '[]',
    "candidate" JSONB,
    "status" TEXT NOT NULL DEFAULT 'open',
    "answer" TEXT,
    "mission_id" TEXT,
    "card_id" TEXT,
    "owner_card_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "decided_at" TIMESTAMP(3),

    CONSTRAINT "node_peer_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "node_peer_requests_room_id_created_at_idx" ON "node_peer_requests"("room_id", "created_at");
CREATE INDEX "node_peer_requests_to_account_id_status_idx" ON "node_peer_requests"("to_account_id", "status");
ALTER TABLE "node_peer_requests" ADD CONSTRAINT "node_peer_requests_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "node_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The peer request a turn answers or plans, and who a turn was done for.
ALTER TABLE "node_turns" ADD COLUMN "peer_request_id" TEXT;
ALTER TABLE "node_turns" ADD COLUMN "principals" JSONB NOT NULL DEFAULT '{}';

-- A person's own settings for a room: trust per collaborator, budget, away, shareable items.
ALTER TABLE "node_room_members" ADD COLUMN "prefs" JSONB NOT NULL DEFAULT '{}';

-- Existing rooms with other people switch to v2. Their nodes' shared threads start a new conversation,
-- so a turn whose answer the room reads never sees history from before, when it could reach more.
UPDATE "node_room_members" SET "conversation_id" = NULL
WHERE "node_id" IS NOT NULL
  AND "room_id" IN (SELECT "id" FROM "node_rooms" WHERE "kind" = 'room' AND "archived_at" IS NULL AND COALESCE("settings"->>'version', '') <> '2');

-- One status line in each room, then its version.
WITH "bumped" AS (
  UPDATE "node_rooms"
  SET "last_seq" = "last_seq" + 1,
      "last_message_at" = CURRENT_TIMESTAMP,
      "settings" = jsonb_set(COALESCE("settings", '{}'::jsonb), '{version}', '2'::jsonb)
  WHERE "kind" = 'room' AND "archived_at" IS NULL AND COALESCE("settings"->>'version', '') <> '2'
  RETURNING "id", "user_id", "last_seq"
)
INSERT INTO "node_messages" ("id", "room_id", "seq", "user_id", "author_kind", "kind", "body", "data", "visible_to", "mentions", "bot_depth", "created_at")
SELECT gen_random_uuid()::text, "id", "last_seq", "user_id", 'system', 'status',
  'This room now follows rooms v2: only leads answer in public, and only when addressed. Use My crew to talk to your own nodes.',
  '{"roomsVersion": 2}'::jsonb, ARRAY[]::text[], '[]'::jsonb, 0, CURRENT_TIMESTAMP
FROM "bumped";
