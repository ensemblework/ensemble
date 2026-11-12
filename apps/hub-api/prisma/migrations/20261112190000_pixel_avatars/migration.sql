-- Assign the shared pixel collection to existing accounts, preserving any current dot selection.
WITH choices AS (
  SELECT "id", ROW_NUMBER() OVER (ORDER BY "created_at", "id") - 1 AS position
  FROM "users"
  WHERE "owner_id" IS NULL
    AND ("avatar" IS NULL OR "avatar" !~ '^dots\.([1-9]|1[0-2])\.(apricot|terracotta|lilac|blue|moss|teal)\.(hills|grove|garden|valley|none)$')
)
UPDATE "users" AS account
SET "avatar" = 'dots.' || (choices.position % 12 + 1)::text || '.' ||
  (ARRAY['apricot','terracotta','lilac','blue','moss','teal'])[(choices.position % 6 + 1)::integer] || '.hills'
FROM choices
WHERE account."id" = choices."id";

UPDATE "users" AS space
SET "avatar" = account."avatar"
FROM "users" AS account
WHERE space."owner_id" = account."id" AND space."avatar" IS DISTINCT FROM account."avatar";
