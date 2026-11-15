/**
 * The OS sandbox is in beta and off by default (docs/24 §1). Settings saved before that hold the old
 * default, which most people never chose: `orchestration.defaultExecution: "sandbox"` and run
 * profiles with `sandbox: true`. `switchSandboxBetaOff` turns those off once per saved settings and
 * records it in the owner's `ui.sandbox-beta` preference; every settings save records it too
 * (`markSandboxBeta`), so a choice made from then on, the beta turned on included, is never undone.
 *
 * The record is a `ui.` key because those go wherever the settings go: copied with them between
 * spaces (spaces/store.ts), kept with them when data is erased (workspace-data.ts), deleted with them
 * when a space changes owner (sharing/store.ts).
 *
 * This runs at startup rather than as a Prisma migration, for the reason in code-folders.ts: hosted
 * Postgres may record a data-only migration as applied without running it. It runs on the hosted
 * server and in the person's own runtime (the desktop app's and the CLI's database), and not on a
 * server whose own runner runs code (`serverRunsOwnCode`), which keeps its isolation.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

/** Present (and not deleted) once the owner's settings have the sandbox beta's defaults. */
export const SANDBOX_BETA_KEY = "ui.sandbox-beta";

/** `value` (a settings document) with Sandbox by default off and every saved run profile's sandbox off, in order. */
const sandboxOff = (value: string) => `(
  SELECT CASE WHEN jsonb_typeof(o.v->'runProfiles') = 'array'
    THEN jsonb_set(o.v, '{runProfiles}', COALESCE((
      SELECT jsonb_agg(CASE WHEN jsonb_typeof(r.profile) = 'object' THEN r.profile || '{"sandbox": false}'::jsonb ELSE r.profile END ORDER BY r.position)
      FROM jsonb_array_elements(o.v->'runProfiles') WITH ORDINALITY AS r(profile, position)
    ), '[]'::jsonb))
    ELSE o.v END
  FROM (SELECT CASE WHEN jsonb_typeof(${value}->'orchestration') = 'object'
    THEN jsonb_set(${value}, '{orchestration,defaultExecution}', '"native"'::jsonb, true)
    ELSE ${value} END AS v) o
)`;

/**
 * One statement: the saved settings with no record yet are switched off where they differ (computed
 * from the row as it is when updated, so a save that lands first is not lost), and their owners get
 * the record. A second run finds nothing.
 */
export const SANDBOX_BETA_SQL = `
WITH pending AS (
  SELECT s."id", s."user_id"
  FROM "preferences" s
  WHERE s."key" = 'hub.settings'
    AND s."deleted_at" IS NULL
    AND jsonb_typeof(s."value") = 'object'
    AND NOT EXISTS (
      SELECT 1 FROM "preferences" m
      WHERE m."user_id" = s."user_id" AND m."key" = '${SANDBOX_BETA_KEY}' AND m."deleted_at" IS NULL
    )
), changed AS (
  UPDATE "preferences" s
  SET "value" = ${sandboxOff('s."value"')}, "updated_at" = NOW()
  FROM pending p
  WHERE s."id" = p."id" AND ${sandboxOff('s."value"')} IS DISTINCT FROM s."value"
  RETURNING s."id"
), marked AS (
  INSERT INTO "preferences" ("id", "user_id", "key", "value", "source", "created_at", "updated_at")
  SELECT gen_random_uuid()::text, p."user_id", '${SANDBOX_BETA_KEY}', 'true'::jsonb, 'system', NOW(), NOW()
  FROM pending p
  ON CONFLICT ("user_id", "key") DO UPDATE SET "value" = EXCLUDED."value", "deleted_at" = NULL, "updated_at" = NOW()
  RETURNING 1
)
SELECT (SELECT count(*) FROM changed)::int AS "changed", (SELECT count(*) FROM marked)::int AS "checked"`;

/** Only `$queryRawUnsafe` is needed, so the hosted client and the desktop PGlite client both fit. */
type RawQuery = { $queryRawUnsafe<T = unknown>(query: string): Promise<T> };

/** `checked`: saved settings given the record this run; `changed`: those of them that had the sandbox on somewhere. */
export async function switchSandboxBetaOff(db: RawQuery): Promise<{ changed: number; checked: number }> {
  const [row] = await db.$queryRawUnsafe<Array<{ changed: number; checked: number }>>(SANDBOX_BETA_SQL);
  return { changed: Number(row?.changed ?? 0), checked: Number(row?.checked ?? 0) };
}

/** Settings saved now already have the beta's defaults, or a choice made since: the switch above never touches them. */
export async function markSandboxBeta(db: PrismaClient | Prisma.TransactionClient, userId: string): Promise<void> {
  await db.preference.upsert({
    where: { userId_key: { userId, key: SANDBOX_BETA_KEY } },
    create: { userId, key: SANDBOX_BETA_KEY, value: true, source: "system" },
    update: { deletedAt: null },
  });
}
