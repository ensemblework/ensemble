/**
 * The board labels migration on PGlite (the desktop's database, and the same SQL as hosted Postgres):
 * free-text task labels become each board's list, once per name whatever its case, and tasks take the
 * list's spelling. Nothing is lost: every non-blank label, Trash included, is on its board's list.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { applyMigration, appliedMigrationNames, listMigrationFiles, migrationsDir, openPglite } from "../lib/pglite-engine.js";

const MIGRATION = "20261207100000_board_labels";

test("existing labels become each board's list, de-duplicated without regard to case", { timeout: 180_000 }, async () => {
  const files = listMigrationFiles(migrationsDir());
  const mine = files.find((file) => file.name === MIGRATION);
  assert.ok(mine, "the migration is bundled");
  const db = await openPglite();
  try {
    await appliedMigrationNames(db);
    for (const file of files) {
      if (file.name === MIGRATION) break;
      await applyMigration(db, file);
    }
    const task = (id: string, user: string, labels: string[], created: string, deleted = false) =>
      db.query(
        `INSERT INTO tasks (id, user_id, title, labels, created_at, updated_at, deleted_at) VALUES ($1, $2, $1, $3, $4, $4, $5)`,
        [id, user, labels, created, deleted ? created : null],
      );
    // Tasks belong to accounts: two with only the columns that have no default.
    const required = await db.query<{ column_name: string; data_type: string }>(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'users' AND is_nullable = 'NO' AND column_default IS NULL`);
    for (const user of ["u1", "u2"]) {
      const values = required.rows.map((column) => (column.column_name === "email" ? `${user}@example.test` : column.data_type.startsWith("timestamp") ? new Date().toISOString() : user));
      await db.query(`INSERT INTO users (${required.rows.map((column) => `"${column.column_name}"`).join(", ")}) VALUES (${values.map((_, index) => `$${index + 1}`).join(", ")})`, values);
    }
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

    await applyMigration(db, mine);

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
