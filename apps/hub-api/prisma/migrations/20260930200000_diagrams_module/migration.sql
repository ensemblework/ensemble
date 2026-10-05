-- Block diagrams become their own optional module, on for everyone.
-- Every template and Default carry it, so existing accounts, live sessions,
-- and the revert snapshots in template history all gain it. A template can
-- still leave it out later.

CREATE OR REPLACE FUNCTION pg_temp.with_diagrams(value TEXT) RETURNS TEXT AS $$
  SELECT array_to_string(ARRAY(
    SELECT DISTINCT part FROM unnest(string_to_array(COALESCE(value, ''), ',') || ARRAY['diagrams']) AS part
    WHERE part <> ''
    ORDER BY part
  ), ',');
$$ LANGUAGE SQL IMMUTABLE;

ALTER TABLE "users" ALTER COLUMN "module_set" SET DEFAULT 'code,diagrams,metrics,runs,skills,workspace';

UPDATE "users" SET "module_set" = pg_temp.with_diagrams("module_set");

-- Null stays null: a session without a module set is fail-closed.
UPDATE "sessions" SET "modules" = pg_temp.with_diagrams("modules") WHERE "modules" IS NOT NULL;

UPDATE "template_applications"
SET "snapshot" = jsonb_set("snapshot", '{modules}', to_jsonb(pg_temp.with_diagrams("snapshot"->>'modules')))
WHERE jsonb_typeof("snapshot") = 'object' AND "snapshot" ? 'modules';
