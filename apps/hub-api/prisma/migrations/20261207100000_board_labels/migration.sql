-- Labels belong to a board: each board keeps its own list (name and colour) that its pages, tasks and
-- deliverables pick from. board_key is the custom board's id, or '' for the Ensemble board, whose list
-- items on no board (standalone notes, deliverables) use too.
ALTER TABLE "task_pages" ADD COLUMN     "labels" TEXT[] DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "deliverables" ADD COLUMN     "labels" TEXT[] DEFAULT ARRAY[]::TEXT[];

CREATE TABLE "board_labels" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "board_key" TEXT NOT NULL DEFAULT '',
    "name" TEXT NOT NULL,
    "name_key" TEXT NOT NULL,
    "color" TEXT,
    "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "board_labels_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "board_labels_user_id_board_key_position_idx" ON "board_labels"("user_id", "board_key", "position");

CREATE UNIQUE INDEX "board_labels_user_id_board_key_name_key_key" ON "board_labels"("user_id", "board_key", "name_key");

-- Every free-text label a task has (Trash included) becomes a label of the task's board, once per name
-- whatever its case: the spelling most tasks use wins, the earliest on a tie. Colour stays null, so each
-- keeps the colour its name already had (labelTone).
WITH used AS (
    SELECT t."user_id", COALESCE(p."board_id", '') AS board_key,
           regexp_replace(btrim(u.label), '\s+', ' ', 'g') AS name, t."created_at"
    FROM "tasks" t
    LEFT JOIN "task_pages" p ON p."task_id" = t."id"
    CROSS JOIN LATERAL unnest(t."labels") AS u(label)
), spellings AS (
    SELECT "user_id", board_key, lower(name) AS name_key, name, count(*) AS uses, min("created_at") AS first_used,
           min(min("created_at")) OVER (PARTITION BY "user_id", board_key, lower(name)) AS label_first_used
    FROM used
    WHERE name <> ''
    GROUP BY "user_id", board_key, lower(name), name
), chosen AS (
    SELECT DISTINCT ON ("user_id", board_key, name_key) "user_id", board_key, name_key, name, label_first_used AS first_used
    FROM spellings
    ORDER BY "user_id", board_key, name_key, uses DESC, first_used ASC, name ASC
)
INSERT INTO "board_labels" ("id", "user_id", "board_key", "name", "name_key", "position", "created_at", "updated_at")
SELECT gen_random_uuid()::text, "user_id", board_key, name, name_key,
       (row_number() OVER (PARTITION BY "user_id", board_key ORDER BY first_used, name_key)) - 1,
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM chosen;

-- Tasks then carry their board's spelling, each label once, in the order they had them.
UPDATE "tasks" t
SET "labels" = fixed.labels
FROM (
    SELECT x."id", array_agg(x.name ORDER BY x.first_ord) AS labels
    FROM (
        SELECT t."id", b."name" AS name, min(u.ord) AS first_ord
        FROM "tasks" t
        LEFT JOIN "task_pages" p ON p."task_id" = t."id"
        CROSS JOIN LATERAL unnest(t."labels") WITH ORDINALITY AS u(label, ord)
        JOIN "board_labels" b ON b."user_id" = t."user_id"
            AND b."board_key" = COALESCE(p."board_id", '')
            AND b."name_key" = lower(regexp_replace(btrim(u.label), '\s+', ' ', 'g'))
        GROUP BY t."id", b."name"
    ) x
    GROUP BY x."id"
) fixed
WHERE fixed."id" = t."id" AND fixed.labels IS DISTINCT FROM t."labels";
