/**
 * Embedded Postgres for the desktop app.
 *
 * PGlite 0.5 is Postgres 18 compiled to WASM, with the same extensions the
 * hosted schema creates: pg_trgm, uuid-ossp, and pgvector. Prisma talks to it
 * through the pglite-prisma-adapter driver adapter, in this process. The
 * migration SQL files are the ones `prisma migrate deploy` runs against
 * hosted Postgres. Nothing here rewrites the schema.
 */
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";
import { vector } from "@electric-sql/pglite-pgvector";
import { PrismaPGlite } from "pglite-prisma-adapter";
import { setDesktopAdapter } from "./desktop-db.js";

const MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    id VARCHAR(36) PRIMARY KEY,
    checksum VARCHAR(64) NOT NULL,
    finished_at TIMESTAMPTZ,
    migration_name VARCHAR(255) NOT NULL,
    logs TEXT,
    rolled_back_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_steps_count INTEGER NOT NULL DEFAULT 0
  )
`;

export class NewerDatabaseError extends Error {
  constructor(migration: string) {
    super(
      `This Ensemble database was written by a newer version of the app (it already has migration ${migration}). Refusing to open it. Install that newer Ensemble, or restore a backup from the backups folder.`,
    );
    this.name = "NewerDatabaseError";
  }
}

type MigrationFile = { name: string; sql: string; checksum: string };

let active: PGlite | null = null;

export function migrationsDir(): string {
  const override = process.env.ENSEMBLE_MIGRATIONS_DIR?.trim();
  if (override) return override;
  return fileURLToPath(new URL("../../prisma/migrations/", import.meta.url));
}

export function listMigrationFiles(dir: string): MigrationFile[] {
  return readdirSync(dir)
    .filter((name) => /^\d/.test(name))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name, "migration.sql"), "utf8");
      return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
    });
}

export async function openPglite(dataDir?: string): Promise<PGlite> {
  const db = new PGlite({
    dataDir,
    extensions: { pg_trgm, uuid_ossp, vector },
  });
  await db.waitReady;
  return db;
}

export async function appliedMigrationNames(db: PGlite): Promise<string[]> {
  await db.exec(MIGRATIONS_TABLE);
  const rows = await db.query<{ migration_name: string }>(
    `SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY started_at, migration_name`,
  );
  return rows.rows.map((row) => row.migration_name);
}

export function newerThanBundle(applied: string[], bundled: string[]): string | null {
  const known = new Set(bundled);
  return applied.find((name) => !known.has(name)) ?? null;
}

export async function applyMigration(db: PGlite, file: MigrationFile): Promise<void> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at, applied_steps_count) VALUES ($1, $2, $3, NOW(), 0)`,
    [id, file.checksum, file.name],
  );
  try {
    await db.exec(file.sql);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.query(`UPDATE "_prisma_migrations" SET logs = $1 WHERE id = $2`, [message.slice(0, 4000), id]).catch(() => undefined);
    throw new Error(`Migration ${file.name} failed. ${message}`);
  }
  await db.query(`UPDATE "_prisma_migrations" SET finished_at = NOW(), applied_steps_count = 1 WHERE id = $1`, [id]);
}

function databaseExists(dataDir: string): boolean {
  return existsSync(join(dataDir, "PG_VERSION"));
}

export function backupDatabase(dataDir: string, backupRoot: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(backupRoot, `pglite-${stamp}`);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(dataDir, dest, { recursive: true });
  if (!existsSync(join(dest, "PG_VERSION"))) {
    throw new Error(`Backup of the local database did not complete (${dest}).`);
  }
  return dest;
}

export type DesktopDatabase = {
  dir: string;
  applied: string[];
  backup: string | null;
};

/**
 * Open the on-disk database, refuse a newer migration history, back up when
 * this launch still has migrations to apply, then apply those files.
 */
export async function openDesktopDatabase(dataDir: string, dir = migrationsDir()): Promise<DesktopDatabase> {
  const files = listMigrationFiles(dir);
  const names = files.map((file) => file.name);
  const existed = databaseExists(dataDir);
  mkdirSync(dirname(dataDir), { recursive: true });
  let db = await openPglite(dataDir);
  let applied = await appliedMigrationNames(db);
  const newer = newerThanBundle(applied, names);
  if (newer) {
    await db.close();
    throw new NewerDatabaseError(newer);
  }
  const pending = files.filter((file) => !applied.includes(file.name));
  let backup: string | null = null;
  if (pending.length > 0 && existed) {
    await db.close();
    const backupRoot = process.env.ENSEMBLE_BACKUP_DIR?.trim() || join(dirname(dataDir), "backups");
    backup = backupDatabase(dataDir, backupRoot);
    db = await openPglite(dataDir);
    applied = await appliedMigrationNames(db);
    const raced = newerThanBundle(applied, names);
    if (raced) {
      await db.close();
      throw new NewerDatabaseError(raced);
    }
  }
  for (const file of files) {
    if (applied.includes(file.name)) continue;
    await applyMigration(db, file);
    applied.push(file.name);
  }
  activateDatabase(db);
  return { dir: dataDir, applied, backup };
}

export async function openMemoryDatabase(dir = migrationsDir()): Promise<void> {
  if (active) throw new Error("A PGlite database is already open in this process.");
  const db = await openPglite();
  try {
    await appliedMigrationNames(db);
    for (const file of listMigrationFiles(dir)) await applyMigration(db, file);
  } catch (error) {
    await db.close();
    throw error;
  }
  activateDatabase(db);
}

function activateDatabase(db: PGlite): void {
  active = db;
  setDesktopAdapter(new PrismaPGlite(db) as never);
}

export async function closeDesktopDatabase(): Promise<void> {
  setDesktopAdapter(undefined);
  const db = active;
  active = null;
  if (db) await db.close();
}

export function pgliteDataLooksValid(dataDir: string): boolean {
  try {
    return statSync(join(dataDir, "PG_VERSION")).isFile();
  } catch {
    return false;
  }
}
