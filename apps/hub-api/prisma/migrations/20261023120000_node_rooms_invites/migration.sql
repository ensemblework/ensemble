-- Ensemble Node rooms with other people are kind 'room' (was 'group').
UPDATE "node_rooms" SET "kind" = 'room' WHERE "kind" = 'group';

-- Node names and crew/room titles are unique per account (case-insensitive). Number older duplicates.
WITH ranked AS (
  SELECT "id", "name", ROW_NUMBER() OVER (PARTITION BY "user_id", lower("name") ORDER BY "created_at", "id") AS n
  FROM "node_agents"
)
UPDATE "node_agents" a SET "name" = left(ranked."name", 55) || ' ' || ranked.n
FROM ranked WHERE a."id" = ranked."id" AND ranked.n > 1;

WITH ranked AS (
  SELECT "id", "title", ROW_NUMBER() OVER (PARTITION BY "user_id", "kind", lower("title") ORDER BY "created_at", "id") AS n
  FROM "node_rooms"
  WHERE "kind" IN ('crew', 'room') AND "archived_at" IS NULL
)
UPDATE "node_rooms" r SET "title" = left(ranked."title", 75) || ' ' || ranked.n
FROM ranked WHERE r."id" = ranked."id" AND ranked.n > 1;

-- Requests to join a room. A declined request blocks a new one to the same person for 30 days.
CREATE TABLE "node_room_invites" (
    "id" TEXT NOT NULL,
    "room_id" TEXT NOT NULL,
    "inviter_id" TEXT NOT NULL,
    "invitee_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responded_at" TIMESTAMP(3),

    CONSTRAINT "node_room_invites_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "node_room_invites_room_id_invitee_id_idx" ON "node_room_invites"("room_id", "invitee_id");
CREATE INDEX "node_room_invites_invitee_id_status_idx" ON "node_room_invites"("invitee_id", "status");
CREATE INDEX "node_room_invites_inviter_id_idx" ON "node_room_invites"("inviter_id");
-- At most one open request per person per room.
CREATE UNIQUE INDEX "node_room_invites_one_pending" ON "node_room_invites"("room_id", "invitee_id") WHERE "status" = 'pending';

ALTER TABLE "node_room_invites" ADD CONSTRAINT "node_room_invites_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "node_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
