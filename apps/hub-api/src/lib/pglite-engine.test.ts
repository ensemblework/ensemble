/**
 * The desktop database is the hosted Prisma schema on PGlite.
 * These checks are the spike: migrations, the Postgres-only statements,
 * vector and full-text search, concurrent transactions, backup, and a newer database.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claimSlot } from "../jobs/claim.js";
import { taskForPage } from "../pages/store.js";
import {
  NewerDatabaseError,
  appliedMigrationNames,
  closeDesktopDatabase,
  listMigrationFiles,
  migrationsDir,
  newerThanBundle,
  openDesktopDatabase,
  openPglite,
} from "./pglite-engine.js";

test("PGlite runs the hub schema, Postgres SQL, vector search, and backups", { timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-pglite-"));
  const dataDir = join(root, "pglite");
  process.env.DATABASE_URL ??= "postgresql://ensemble:unused@127.0.0.1:1/ensemble_desktop";
  process.env.ENSEMBLE_BACKUP_DIR = join(root, "backups");
  try {
    const opened = await openDesktopDatabase(dataDir);
    assert.equal(opened.backup, null);
    assert.ok(opened.applied.length >= 15, `applied ${opened.applied.length} migrations`);
    const bundled = listMigrationFiles(migrationsDir()).map((file) => file.name);
    assert.deepEqual(opened.applied, bundled);
    assert.equal(newerThanBundle(opened.applied, bundled), null);
    assert.equal(newerThanBundle([...opened.applied, "from-the-future"], bundled), "from-the-future");

    const { PrismaClient } = await import("@prisma/client");
    const { desktopAdapter } = await import("./desktop-db.js");
    const adapter = desktopAdapter();
    assert.ok(adapter);
    const api = new PrismaClient({ adapter });
    const worker = new PrismaClient({ adapter });
    const userId = "local";
    const taskId = randomUUID();
    await api.user.create({
      data: { id: userId, email: "local@ensemble.desktop", name: "Local", passwordHash: "scrypt:test" },
    });
    await api.task.create({ data: { id: taskId, userId, title: "spike" } });

    assert.equal(await claimSlot(api, userId, "mail", "slot-1"), true);
    assert.equal(await claimSlot(worker, userId, "mail", "slot-1"), false);
    assert.equal(await claimSlot(api, userId, "mail", "slot-2"), true);

    const locked = await api.$transaction(async (tx) => taskForPage(tx, userId, taskId, true));
    assert.equal(locked.id, taskId);

    await Promise.all([
      api.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${taskId} AND user_id = ${userId} FOR UPDATE`;
        await tx.$executeRaw`UPDATE tasks SET title = 'api' WHERE id = ${taskId}`;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }),
      worker.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${taskId} AND user_id = ${userId} FOR UPDATE`;
        await tx.$executeRaw`UPDATE tasks SET notes = 'worker' WHERE id = ${taskId}`;
      }),
    ]);

    const artifactId = randomUUID();
    await api.$executeRaw`
      INSERT INTO artifacts (id, user_id, kind, external_id, ts, title, text, search_vector, participants, metadata)
      VALUES (
        ${artifactId},
        ${userId},
        'email'::"ArtifactKind",
        ${artifactId},
        NOW(),
        'Hello',
        'pglite full text unicorn',
        to_tsvector('english', 'pglite full text unicorn'),
        '[]'::jsonb,
        '{}'::jsonb
      )
    `;
    const found = await api.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM artifacts
      WHERE search_vector @@ plainto_tsquery('english', 'unicorn') AND id = ${artifactId}
    `;
    assert.equal(found.length, 1);

    const zeros = `[${Array.from({ length: 3072 }, () => "0").join(",")}]`;
    const one = `[1,${Array.from({ length: 3071 }, () => "0").join(",")}]`;
    const chunkA = randomUUID();
    const chunkB = randomUUID();
    await api.$executeRaw`
      INSERT INTO artifact_chunks (id, artifact_id, index, text, embedding)
      VALUES (${chunkA}, ${artifactId}, 0, 'a', ${zeros}::vector)
    `;
    await api.$executeRaw`
      INSERT INTO artifact_chunks (id, artifact_id, index, text, embedding)
      VALUES (${chunkB}, ${artifactId}, 1, 'b', ${one}::vector)
    `;
    const distance = await api.$queryRaw<Array<{ dist: number }>>`
      SELECT (a.embedding <-> b.embedding)::float8 AS dist
      FROM artifact_chunks a, artifact_chunks b
      WHERE a.id = ${chunkA} AND b.id = ${chunkB}
    `;
    assert.ok(Math.abs(Number(distance[0]?.dist) - 1) < 0.001);

    await api.$disconnect();
    await worker.$disconnect();
    await closeDesktopDatabase();

    const extra = join(root, "migrations-plus");
    cpSync(migrationsDir(), extra, { recursive: true });
    const noop = join(extra, "99999999999999_noop");
    mkdirSync(noop);
    writeFileSync(join(noop, "migration.sql"), "SELECT 1;\n");
    const again = await openDesktopDatabase(dataDir, extra);
    assert.ok(again.backup);
    assert.ok(again.applied.includes("99999999999999_noop"));
    await closeDesktopDatabase();

    const probe = await openPglite(dataDir);
    await probe.query(
      `INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at, finished_at, applied_steps_count) VALUES ($1, $2, $3, NOW(), NOW(), 1)`,
      [randomUUID(), "abc", "from-the-future"],
    );
    const names = await appliedMigrationNames(probe);
    assert.ok(names.includes("from-the-future"));
    await probe.close();
    await assert.rejects(() => openDesktopDatabase(dataDir), NewerDatabaseError);
  } finally {
    await closeDesktopDatabase().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});
