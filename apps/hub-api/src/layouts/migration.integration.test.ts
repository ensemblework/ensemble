/**
 * Applies the widget migration to a fresh database and prisma db push to another.
 * Skips when this process cannot create databases.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { config as loadEnv } from "dotenv";
import test from "node:test";
import { fileURLToPath } from "node:url";

// This file does not import the API config, which is what loads the repo .env
// for the other integration tests. Without this, `pnpm test` skips the check
// even when Postgres is up.
for (const candidate of [path.resolve(process.cwd(), "../../.env"), path.resolve(process.cwd(), ".env")]) {
  if (existsSync(candidate)) loadEnv({ path: candidate, override: false });
}

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, "../../prisma/migrations");
const schema = path.resolve(here, "../../prisma/schema.prisma");

function adminUrl(): string | null {
  const raw = process.env.DATABASE_URL;
  if (!raw) return null;
  const url = new URL(raw);
  url.pathname = "/postgres";
  return url.toString();
}

function dbUrl(name: string): string {
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${name}`;
  return url.toString();
}

async function psql(url: string, sql: string) {
  const { stdout } = await exec("psql", [url, "-q", "-v", "ON_ERROR_STOP=1", "-tA", "-c", sql], { env: process.env });
  return stdout.trim();
}

async function canCreate(): Promise<boolean> {
  const admin = adminUrl();
  if (!admin) return false;
  try {
    await exec("psql", [admin, "-c", "SELECT 1"]);
    return true;
  } catch {
    return false;
  }
}

test("widget migration sorts after cowork and applies to a fresh database and a db-push database", async (t) => {
  if (!(await canCreate())) return t.skip("Cannot create Postgres databases from DATABASE_URL");
  const folders = readdirSync(migrationsDir).filter((name) => /^\d/.test(name)).sort();
  const widget = "20260929190000_widget_layouts";
  const cowork = folders.indexOf("20260929180000_cowork_surfaces");
  const mine = folders.indexOf(widget);
  assert.ok(cowork >= 0 && mine > cowork, "widget migration must sort after cowork");

  const stamp = Date.now().toString(36);
  const migrated = `ensemble_widget_migrate_${stamp}`;
  const pushed = `ensemble_widget_push_${stamp}`;
  const admin = adminUrl()!;
  const drop = async (name: string) => {
    await exec("psql", [admin, "-c", `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`]).catch(() => undefined);
  };
  await drop(migrated);
  await drop(pushed);
  try {
    await exec("psql", [admin, "-c", `CREATE DATABASE "${migrated}"`]);
    await exec("psql", [admin, "-c", `CREATE DATABASE "${pushed}"`]);
    const migratedUrl = dbUrl(migrated);
    for (const folder of folders) {
      if (folder === widget) break;
      const file = path.join(migrationsDir, folder, "migration.sql");
      await exec("psql", [migratedUrl, "-v", "ON_ERROR_STOP=1", "-f", file]);
    }
    const userId = await psql(
      migratedUrl,
      `INSERT INTO users (id, email, name, created_at) VALUES ('legacy-user', 'legacy-${stamp}@ensemble.test', 'Legacy', CURRENT_TIMESTAMP) RETURNING id`,
    );
    assert.equal(userId, "legacy-user");
    await exec("psql", [migratedUrl, "-v", "ON_ERROR_STOP=1", "-f", path.join(migrationsDir, widget, "migration.sql")]);
    const completed = await psql(migratedUrl, `SELECT onboarding_completed_at IS NOT NULL FROM users WHERE id = 'legacy-user'`);
    assert.equal(completed, "t");
    const table = await psql(migratedUrl, `SELECT to_regclass('public.widget_layouts')`);
    assert.equal(table, "widget_layouts");

    await exec(
      "pnpm",
      ["exec", "prisma", "db", "push", "--skip-generate", "--accept-data-loss", "--schema", schema],
      { cwd: path.resolve(here, "../.."), env: { ...process.env, DATABASE_URL: dbUrl(pushed) } },
    );
    const pushedTable = await psql(dbUrl(pushed), `SELECT to_regclass('public.widget_layouts')`);
    assert.equal(pushedTable, "widget_layouts");
    const columns = await psql(
      dbUrl(pushed),
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name IN ('onboarding_role','onboarding_template_id','onboarding_completed_at') ORDER BY 1`,
    );
    assert.match(columns, /onboarding_completed_at/);
    assert.match(columns, /onboarding_role/);
    assert.match(columns, /onboarding_template_id/);
  } finally {
    await drop(migrated);
    await drop(pushed);
  }
});
