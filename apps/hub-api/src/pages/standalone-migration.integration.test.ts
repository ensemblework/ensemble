/**
 * Standalone pages migration on a database that already has linked pages,
 * and on a fresh database. Skips when this process cannot create databases.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { PrismaClient } from "@prisma/client";
import { config as loadEnv } from "dotenv";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readItem, searchHub } from "../bridge/service.js";
import { backfillPageSearchText } from "./search-backfill.js";

for (const candidate of [path.resolve(process.cwd(), "../../.env"), path.resolve(process.cwd(), ".env")]) {
  if (existsSync(candidate)) loadEnv({ path: candidate, override: false });
}

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, "../../prisma/migrations");
const schema = path.resolve(here, "../../prisma/schema.prisma");
const migration = "20261004180000_standalone_pages";

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

test("standalone pages migration keeps linked rows and allows a page with no task", async (t) => {
  if (!(await canCreate())) return t.skip("Cannot create Postgres databases from DATABASE_URL");
  const folders = readdirSync(migrationsDir).filter((name) => /^\d/.test(name)).sort();
  const mine = folders.indexOf(migration);
  assert.ok(mine >= 0, "standalone pages migration folder is missing");

  const stamp = Date.now().toString(36);
  const existing = `ensemble_pages_existing_${stamp}`;
  const fresh = `ensemble_pages_fresh_${stamp}`;
  const admin = adminUrl()!;
  const drop = async (name: string) => {
    await exec("psql", [admin, "-c", `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`]).catch(() => undefined);
  };
  await drop(existing);
  await drop(fresh);
  try {
    await exec("psql", [admin, "-c", `CREATE DATABASE "${existing}"`]);
    await exec("psql", [admin, "-c", `CREATE DATABASE "${fresh}"`]);
    const existingUrl = dbUrl(existing);
    // 20261001180000_workspace_fk_indexes records its repair log with
    // UPDATE "_prisma_migrations". Raw SQL has no Prisma bookkeeping table.
    await psql(
      existingUrl,
      `CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
        id VARCHAR(36) PRIMARY KEY,
        checksum VARCHAR(64) NOT NULL,
        finished_at TIMESTAMPTZ,
        migration_name VARCHAR(255) NOT NULL,
        logs TEXT,
        rolled_back_at TIMESTAMPTZ,
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        applied_steps_count INTEGER NOT NULL DEFAULT 0
      )`,
    );
    for (const folder of folders) {
      if (folder === migration) break;
      await exec("psql", [existingUrl, "-v", "ON_ERROR_STOP=1", "-f", path.join(migrationsDir, folder, "migration.sql")]);
    }
    const userId = await psql(
      existingUrl,
      `INSERT INTO users (id, email, name, created_at) VALUES ('legacy-user', 'legacy-${stamp}@ensemble.test', 'Legacy', CURRENT_TIMESTAMP) RETURNING id`,
    );
    assert.equal(userId, "legacy-user");
    await psql(
      existingUrl,
      `INSERT INTO tasks (id, user_id, title, created_at, updated_at) VALUES ('legacy-task', 'legacy-user', 'Linked task', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    );
    const bodyWord = `zephyrbody${stamp}`;
    await psql(
      existingUrl,
      `INSERT INTO task_pages (id, user_id, task_id, notes_snapshot, content, created_at, updated_at) VALUES ('legacy-page', 'legacy-user', 'legacy-task', 'legacy violet ink', '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"${bodyWord}"}]}]}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    );
    await exec("psql", [existingUrl, "-v", "ON_ERROR_STOP=1", "-f", path.join(migrationsDir, migration, "migration.sql")]);

    const marker = await psql(existingUrl, `SELECT search_text IS NULL FROM task_pages WHERE id = 'legacy-page'`);
    assert.equal(marker, "t");
    const keptNotes = await psql(existingUrl, `SELECT task_id || '|' || notes_snapshot FROM task_pages WHERE id = 'legacy-page'`);
    assert.equal(keptNotes, "legacy-task|legacy violet ink");
    // Later migrations bring the database up to the schema the Prisma client below expects.
    for (const folder of folders.slice(mine + 1)) {
      await exec("psql", [existingUrl, "-v", "ON_ERROR_STOP=1", "-f", path.join(migrationsDir, folder, "migration.sql")]);
    }
    const indexedAt = await psql(existingUrl, `SELECT updated_at FROM task_pages WHERE id = 'legacy-page'`);
    const client = new PrismaClient({ datasources: { db: { url: existingUrl } } });
    try {
      const first = await backfillPageSearchText(client, { pauseMs: 0, log: { warn() {} } });
      assert.ok(first.updated >= 1);
      const indexed = await psql(existingUrl, `SELECT search_text FROM task_pages WHERE id = 'legacy-page'`);
      assert.match(indexed, new RegExp(bodyWord));
      assert.doesNotMatch(indexed, /legacy violet ink/);
      const second = await backfillPageSearchText(client, { pauseMs: 0, log: { warn() {} } });
      assert.equal(second.updated, 0);
      assert.equal(await psql(existingUrl, `SELECT updated_at FROM task_pages WHERE id = 'legacy-page'`), indexedAt);
      const found = await searchHub(client, "legacy-user", bodyWord, 10);
      assert.equal(found.results.some((row) => row.id === "legacy-page" && row.kind === "page"), true);
      await psql(existingUrl, `UPDATE task_pages SET search_text = 'sentinel-not-the-body' WHERE id = 'legacy-page'`);
      const read = await readItem(client, "legacy-user", "page", "legacy-page", 0, 4000);
      assert.equal(read.found, true);
      if (read.found) {
        const body = (read.item.body as { text: string }).text;
        assert.match(body, new RegExp(bodyWord));
        assert.doesNotMatch(body, /sentinel-not-the-body/);
        assert.doesNotMatch(body, /legacy violet ink/);
      }

      await psql(
        existingUrl,
        `INSERT INTO task_pages (id, user_id, content, notes_snapshot, created_at, updated_at) VALUES ('bad-page', 'legacy-user', '{"type":"nope"}'::jsonb, 'bad-notes', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      );
      await psql(
        existingUrl,
        `INSERT INTO task_pages (id, user_id, content, notes_snapshot, created_at, updated_at) VALUES ('good-page', 'legacy-user', '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"goodbodyword"}]}]}'::jsonb, 'good-notes-not-body', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      );
      const mixed = await backfillPageSearchText(client, { pauseMs: 0, batchSize: 10, log: { warn() {} } });
      assert.ok(mixed.skipped >= 1);
      assert.ok(mixed.updated >= 1);
      const good = await psql(existingUrl, `SELECT search_text FROM task_pages WHERE id = 'good-page'`);
      assert.match(good, /goodbodyword/);
      assert.doesNotMatch(good, /good-notes-not-body/);
      const bad = await psql(existingUrl, `SELECT COALESCE(search_text, '<null>') FROM task_pages WHERE id = 'bad-page'`);
      assert.equal(bad, "");
      assert.doesNotMatch(bad, /bad-notes/);
      const again = await backfillPageSearchText(client, { pauseMs: 0, batchSize: 10, log: { warn() {} } });
      assert.equal(again.updated, 0);
      assert.equal(again.skipped, 0);
    } finally {
      await client.$disconnect();
    }
    const nullable = await psql(
      existingUrl,
      `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'task_pages' AND column_name = 'task_id'`,
    );
    assert.equal(nullable, "YES");
    await psql(
      existingUrl,
      `INSERT INTO task_pages (id, user_id, title, search_text, created_at, updated_at) VALUES ('solo-page', 'legacy-user', 'Untitled', 'Untitled', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    );
    const solo = await psql(existingUrl, `SELECT task_id IS NULL AND title = 'Untitled' FROM task_pages WHERE id = 'solo-page'`);
    assert.equal(solo, "t");
    const taskCount = await psql(existingUrl, `SELECT count(*) FROM tasks`);
    assert.equal(taskCount, "1");

    const freshUrl = dbUrl(fresh);
    await exec("pnpm", ["exec", "prisma", "migrate", "deploy", "--schema", schema], {
      cwd: path.resolve(here, "../.."),
      env: { ...process.env, DATABASE_URL: freshUrl },
    });
    await psql(
      freshUrl,
      `INSERT INTO users (id, email, name, created_at) VALUES ('fresh-user', 'fresh-${stamp}@ensemble.test', 'Fresh', CURRENT_TIMESTAMP)`,
    );
    await psql(
      freshUrl,
      `INSERT INTO tasks (id, user_id, title, created_at, updated_at) VALUES ('fresh-task', 'fresh-user', 'Still linked', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    );
    await psql(
      freshUrl,
      `INSERT INTO task_pages (id, user_id, task_id, title, created_at, updated_at) VALUES ('fresh-linked', 'fresh-user', 'fresh-task', '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    );
    await psql(
      freshUrl,
      `INSERT INTO task_pages (id, user_id, title, search_text, created_at, updated_at) VALUES ('fresh-solo', 'fresh-user', 'Untitled', 'Untitled', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    );
    const linked = await psql(freshUrl, `SELECT task_id FROM task_pages WHERE id = 'fresh-linked'`);
    const alone = await psql(freshUrl, `SELECT task_id IS NULL FROM task_pages WHERE id = 'fresh-solo'`);
    assert.equal(linked, "fresh-task");
    assert.equal(alone, "t");
  } finally {
    await drop(existing);
    await drop(fresh);
  }
});
