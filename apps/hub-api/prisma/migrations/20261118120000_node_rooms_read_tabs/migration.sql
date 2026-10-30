-- One read mark per tab in rooms with other people (docs/35 §9): the Room tab keeps read_seq, My crew gets its own.
ALTER TABLE "node_room_members" ADD COLUMN "read_seq_crew" INTEGER NOT NULL DEFAULT 0;
-- What a person had read stays read in both tabs.
UPDATE "node_room_members" SET "read_seq_crew" = "read_seq" WHERE "node_id" IS NULL;
