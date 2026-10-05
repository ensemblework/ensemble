/**
 * The Code folders upgrade on desktop PGlite: the bundled migrations, then the
 * startup step, on a fresh database and on one with folders saved before the
 * split. A second run changes nothing.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { upgradeCodeFolders } from "./code-folders.js";
import { closeDesktopDatabase, openDesktopDatabase } from "./pglite-engine.js";

test("PGlite: the upgrade copies saved folders into the Code list once, and a second run changes nothing", { timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-pglite-code-"));
  process.env.DATABASE_URL ??= "postgresql://ensemble:unused@127.0.0.1:1/ensemble_desktop";
  process.env.ENSEMBLE_BACKUP_DIR = join(root, "backups");
  try {
    await openDesktopDatabase(join(root, "pglite"));
    const { PrismaClient } = await import("@prisma/client");
    const { desktopAdapter } = await import("./desktop-db.js");
    const db = new PrismaClient({ adapter: desktopAdapter()! });

    // Fresh database: nothing to copy.
    assert.equal(await upgradeCodeFolders(db), 0);

    await db.user.create({ data: { id: "local", email: "local@ensemble.desktop", name: "Local", passwordHash: "scrypt:test" } });
    await db.user.create({ data: { id: "other", email: "other@ensemble.desktop", name: "Other", passwordHash: "scrypt:test" } });
    // Saved before the split: one list, under terminal.
    await db.preference.create({ data: { userId: "local", key: "hub.settings", value: { terminal: { enabled: true, roots: ["/Users/p/src", "~/work"] } } } });
    // Already upgraded, with every Code folder removed: must stay empty.
    await db.preference.create({ data: { userId: "other", key: "hub.settings", value: { terminal: { roots: ["/Users/o/src"] }, code: { roots: [] } } } });
    // Not settings: never touched.
    await db.preference.create({ data: { userId: "local", key: "desk.sample", value: { terminal: { roots: ["/x"] } } } });

    assert.equal(await upgradeCodeFolders(db), 1);
    const read = async (userId: string, key = "hub.settings") => (await db.preference.findFirstOrThrow({ where: { userId, key } })).value as Record<string, any>;
    const local = await read("local");
    assert.deepEqual(local.code, { roots: ["/Users/p/src", "~/work"] });
    assert.deepEqual(local.terminal, { enabled: true, roots: ["/Users/p/src", "~/work"] });
    assert.deepEqual((await read("other")).code, { roots: [] });
    assert.equal((await read("local", "desk.sample")).code, undefined);

    const before = await db.preference.findMany({ orderBy: [{ userId: "asc" }, { key: "asc" }] });
    assert.equal(await upgradeCodeFolders(db), 0);
    const after = await db.preference.findMany({ orderBy: [{ userId: "asc" }, { key: "asc" }] });
    assert.deepEqual(after, before);
    await db.$disconnect();
  } finally {
    await closeDesktopDatabase();
    rmSync(root, { recursive: true, force: true });
  }
});
