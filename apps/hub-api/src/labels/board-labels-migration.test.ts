/**
 * The board labels migration on PGlite (the desktop's database, and the same SQL as hosted Postgres):
 * free-text task labels become each board's list, once per name whatever its case, and tasks take the
 * list's spelling. Nothing is lost: every non-blank label, Trash included, is on its board's list or
 * stays on its task as written.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { applyMigration, appliedMigrationNames, listMigrationFiles, migrationsDir, openPglite } from "../lib/pglite-engine.js";

const MIGRATION = "20261207100000_board_labels";

type Db = Awaited<ReturnType<typeof openPglite>>;

/** A database with every migration before this one. */
async function before() {
  const files = listMigrationFiles(migrationsDir());
  const mine = files.find((file) => file.name === MIGRATION);
  assert.ok(mine, "the migration is bundled");
  const db = await openPglite();
  await appliedMigrationNames(db);
  for (const file of files) {
    if (file.name === MIGRATION) break;
    await applyMigration(db, file);
  }
  return { db, mine };
}

/** Accounts, with only the columns that have no default. */
async function users(db: Db, ids: string[]) {
  const required = await db.query<{ column_name: string; data_type: string }>(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'users' AND is_nullable = 'NO' AND column_default IS NULL`);
  for (const user of ids) {
    const values = required.rows.map((column) => (column.column_name === "email" ? `${user}@example.test` : column.data_type.startsWith("timestamp") ? new Date().toISOString() : user));
    await db.query(`INSERT INTO users (${required.rows.map((column) => `"${column.column_name}"`).join(", ")}) VALUES (${values.map((_, index) => `$${index + 1}`).join(", ")})`, values);
  }
}

const seedTask = (db: Db, id: string, user: string, labels: string[], created: string, deleted = false) =>
  db.query(`INSERT INTO tasks (id, user_id, title, labels, created_at, updated_at, deleted_at) VALUES ($1, $2, $1, $3, $4, $4, $5)`, [id, user, labels, created, deleted ? created : null]);

test("existing labels become each board's list, de-duplicated without regard to case", { timeout: 180_000 }, async () => {
  const { db, mine } = await before();
  try {
    const task = (id: string, user: string, labels: string[], created: string, deleted = false) => seedTask(db, id, user, labels, created, deleted);
    await users(db, ["u1", "u2"]);
    await db.query(`INSERT INTO page_boards (id, user_id, title, columns, updated_at) VALUES ('b1', 'u1', 'Research', '[]', NOW())`);
    // "Launch" is the spelling most tasks use; "launch" and "LAUNCH " are the same label.
    await task("t1", "u1", ["launch", "Field  work"], "2026-01-01");
    await task("t2", "u1", ["Launch"], "2026-01-02");
    await task("t3", "u1", ["Launch", "LAUNCH ", "  "], "2026-01-03");
    await task("t4", "u1", ["Old"], "2026-01-04", true);
    // On the custom board: its own list, even for a name the Ensemble board has.
    await task("t5", "u1", ["launch", "Lab"], "2026-01-05");
    await db.query(`INSERT INTO task_pages (id, user_id, task_id, board_id, updated_at) VALUES ('p5', 'u1', 't5', 'b1', NOW())`);
    await task("t6", "u2", ["LAUNCH"], "2026-01-06");
    await task("t7", "u1", [], "2026-01-07");

    await applyMigration(db, mine!);

    const labels = await db.query<{ user_id: string; board_key: string; name: string; name_key: string; color: string | null; position: number }>(
      `SELECT user_id, board_key, name, name_key, color, position FROM board_labels ORDER BY user_id, board_key, position`,
    );
    assert.deepEqual(labels.rows.map((row) => [row.user_id, row.board_key, row.name, row.name_key, row.color, row.position]), [
      // In the order they were first used; a tie by name.
      ["u1", "", "Field work", "field work", null, 0],
      ["u1", "", "Launch", "launch", null, 1],
      ["u1", "", "Old", "old", null, 2],
      ["u1", "b1", "Lab", "lab", null, 0],
      ["u1", "b1", "launch", "launch", null, 1],
      ["u2", "", "LAUNCH", "launch", null, 0],
    ]);
    const tasks = await db.query<{ id: string; labels: string[] }>(`SELECT id, labels FROM tasks ORDER BY id`);
    assert.deepEqual(Object.fromEntries(tasks.rows.map((row) => [row.id, row.labels])), {
      t1: ["Launch", "Field work"],
      t2: ["Launch"],
      t3: ["Launch"],
      t4: ["Old"],
      t5: ["launch", "Lab"],
      t6: ["LAUNCH"],
      t7: [],
    });
    const columns = await db.query<{ table_name: string }>(`SELECT table_name FROM information_schema.columns WHERE column_name = 'labels' AND table_name IN ('task_pages', 'deliverables') ORDER BY table_name`);
    assert.deepEqual(columns.rows.map((row) => row.table_name), ["deliverables", "task_pages"]);
    const duplicate = await db.query(`INSERT INTO board_labels (id, user_id, board_key, name, name_key, updated_at) VALUES ('x', 'u1', '', 'LAUNCH', 'launch', NOW())`).then(() => "inserted", () => "refused");
    assert.equal(duplicate, "refused", "one label per name on a board");
  } finally {
    await db.close();
  }
});

test("a label the running app writes during the migration is kept, and the Hub then fixes keys SQL lower() left", { timeout: 180_000 }, async () => {
  process.env.DATABASE_URL ??= "postgresql://none:none@127.0.0.1:1/unused_test";
  const { db, mine } = await before();
  try {
    await users(db, ["u1"]);
    await seedTask(db, "t1", "u1", ["Launch"], "2026-01-01");
    await seedTask(db, "t2", "u1", ["Über"], "2026-01-02");
    await seedTask(db, "t3", "u1", ["über"], "2026-01-03");
    await seedTask(db, "t4", "u1", ["ÜBER"], "2026-01-04", true);
    const marker = "-- Tasks then carry";
    const at = mine!.sql.indexOf(marker);
    assert.ok(at > 0, "the migration builds the lists before it rewrites tasks");
    await db.exec(mine!.sql.slice(0, at));
    // The old app, still running during the deploy, writes after the lists were built.
    await db.query(`UPDATE tasks SET labels = ARRAY['launch', 'Brand  new'] WHERE id = 't1'`);
    await db.exec(mine!.sql.slice(at));
    const row = await db.query<{ labels: string[]; updated_at: string }>(`SELECT labels, updated_at::text AS updated_at FROM tasks WHERE id = 't1'`);
    assert.deepEqual(row.rows[0]!.labels, ["Launch", "Brand new"], "the list's spelling, and a name the list lacks stays as written");
    assert.equal(row.rows[0]!.updated_at, "2026-01-01 00:00:00", "updated_at left alone");

    const { PrismaClient } = await import("@prisma/client");
    const { generatedRustFreeClient, pgliteAdapter } = await import("../lib/pglite-adapter.js");
    const { repairLabelKeys } = await import("./board-labels.js");
    const { labelKey } = await import("@ensemble/shared-types");
    const prisma = new PrismaClient({ adapter: pgliteAdapter(db, { rustFree: generatedRustFreeClient() }) as never });
    try {
      await repairLabelKeys(prisma);
      const labels = await prisma.boardLabel.findMany({ where: { userId: "u1" }, select: { name: true, nameKey: true } });
      assert.deepEqual(labels.filter((label) => label.nameKey !== labelKey(label.name)), [], "every key is the Hub's own");
      const uber = labels.filter((label) => label.nameKey === "über");
      assert.equal(uber.length, 1, "Über, über and ÜBER are one label");
      const tasks = await prisma.task.findMany({ where: { id: { in: ["t2", "t3", "t4"] } }, select: { labels: true } });
      assert.deepEqual(tasks.map((task) => task.labels), [[uber[0]!.name], [uber[0]!.name], [uber[0]!.name]]);
      assert.equal(await repairLabelKeys(prisma), 0, "a second run changes nothing");
    } finally {
      await prisma.$disconnect();
    }
  } finally {
    await db.close();
  }
});
