/**
 * The sandbox beta's one-time switch-off on desktop PGlite: the bundled migrations, then the startup
 * step. Saved settings with the old default (on) are turned off once and recorded; settings saved
 * since (a new account, the beta turned on afterwards) are never touched; a second run changes nothing.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDesktopDatabase, openDesktopDatabase } from "./pglite-engine.js";

test("PGlite: saved settings with the sandbox on are turned off once, and a choice made since is kept", { timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-pglite-sandbox-"));
  process.env.DATABASE_URL ??= "postgresql://ensemble:unused@127.0.0.1:1/ensemble_desktop";
  process.env.ENSEMBLE_BACKUP_DIR = join(root, "backups");
  try {
    await openDesktopDatabase(join(root, "pglite"));
    const { PrismaClient } = await import("@prisma/client");
    const { desktopAdapter } = await import("./desktop-db.js");
    const { SANDBOX_BETA_KEY, switchSandboxBetaOff } = await import("./sandbox-beta.js");
    const { loadSettings, saveSettings } = await import("./settings.js");
    const db = new PrismaClient({ adapter: desktopAdapter()! });

    // Fresh database: nothing to switch.
    assert.deepEqual(await switchSandboxBetaOff(db), { changed: 0, checked: 0 });

    for (const id of ["local", "other", "space", "fresh", "gone"]) {
      await db.user.create({ data: { id, email: `${id}@ensemble.desktop`, name: id, passwordHash: "scrypt:test", ...(id === "space" ? { ownerId: "local" } : {}) } });
    }
    // Saved before the sandbox was a beta: the old default everywhere, two run profiles.
    await db.preference.create({
      data: {
        userId: "local",
        key: "hub.settings",
        value: {
          orchestration: { defaultExecution: "sandbox", maxTurns: 30, sandboxNetwork: false },
          runProfiles: [
            { id: "careful", name: "Careful", mode: "ask", sandbox: true, network: false },
            { id: "away", name: "Away", mode: "unattended", sandbox: false },
          ],
          defaultRunProfileId: "careful",
          timezone: "Europe/Berlin",
        },
      },
    });
    // Saved without any of it (so already off by the new defaults), and a space's own settings already off.
    await db.preference.create({ data: { userId: "other", key: "hub.settings", value: { timezone: "UTC" } } });
    await db.preference.create({ data: { userId: "space", key: "hub.settings", value: { orchestration: { defaultExecution: "native" }, runProfiles: [] } } });
    // A new account saves its settings after the change, with the beta turned on.
    await saveSettings(db, "fresh", { orchestration: { defaultExecution: "sandbox" }, runProfiles: [{ id: "mine", name: "Mine", sandbox: true }] });
    // Deleted settings, and a preference that is not settings: never touched.
    await db.preference.create({ data: { userId: "gone", key: "hub.settings", value: { orchestration: { defaultExecution: "sandbox" } }, deletedAt: new Date() } });
    await db.preference.create({ data: { userId: "local", key: "desk.sample", value: { orchestration: { defaultExecution: "sandbox" } } } });

    assert.deepEqual(await switchSandboxBetaOff(db), { changed: 1, checked: 3 });
    const read = async (userId: string, key = "hub.settings") => (await db.preference.findFirstOrThrow({ where: { userId, key } })).value as Record<string, any>;
    const local = await read("local");
    assert.equal(local.orchestration.defaultExecution, "native");
    assert.deepEqual(local.runProfiles.map((row: { id: string; sandbox: boolean }) => [row.id, row.sandbox]), [["careful", false], ["away", false]], "every profile off, in order");
    assert.equal(local.runProfiles[0].mode, "ask", "the rest of a profile is kept");
    assert.equal(local.orchestration.maxTurns, 30, "the rest of the settings are kept");
    assert.equal(local.timezone, "Europe/Berlin");
    assert.deepEqual(await read("other"), { timezone: "UTC" }, "nothing to change: left as saved");
    assert.equal((await loadSettings(db, "other")).orchestration.defaultExecution, "native");
    const fresh = await loadSettings(db, "fresh");
    assert.equal(fresh.orchestration.defaultExecution, "sandbox", "a choice saved since is kept");
    assert.equal(fresh.runProfiles[0]!.sandbox, true);
    assert.equal((await read("gone")).orchestration.defaultExecution, "sandbox");
    assert.equal((await read("local", "desk.sample")).orchestration.defaultExecution, "sandbox");
    for (const userId of ["local", "other", "space", "fresh"]) {
      const marker = await db.preference.findUniqueOrThrow({ where: { userId_key: { userId, key: SANDBOX_BETA_KEY } } });
      assert.equal(marker.deletedAt, null, userId);
    }
    assert.equal(await db.preference.findUnique({ where: { userId_key: { userId: "gone", key: SANDBOX_BETA_KEY } } }), null);

    // The person turns the beta on afterwards: it stays on, and a second run changes nothing.
    await saveSettings(db, "local", { orchestration: { defaultExecution: "sandbox" } });
    const before = await db.preference.findMany({ orderBy: [{ userId: "asc" }, { key: "asc" }] });
    assert.deepEqual(await switchSandboxBetaOff(db), { changed: 0, checked: 0 });
    assert.deepEqual(await db.preference.findMany({ orderBy: [{ userId: "asc" }, { key: "asc" }] }), before);
    assert.equal((await loadSettings(db, "local")).orchestration.defaultExecution, "sandbox");

    // Settings copied in without the record (from settings never saved since) are switched once more.
    await db.preference.update({ where: { userId_key: { userId: "space", key: SANDBOX_BETA_KEY } }, data: { deletedAt: new Date() } });
    await db.preference.update({ where: { userId_key: { userId: "space", key: "hub.settings" } }, data: { value: { orchestration: { defaultExecution: "sandbox" } } } });
    assert.deepEqual(await switchSandboxBetaOff(db), { changed: 1, checked: 1 });
    assert.equal((await read("space")).orchestration.defaultExecution, "native");
    assert.equal((await db.preference.findUniqueOrThrow({ where: { userId_key: { userId: "space", key: SANDBOX_BETA_KEY } } })).deletedAt, null);
    await db.$disconnect();
  } finally {
    await closeDesktopDatabase();
    rmSync(root, { recursive: true, force: true });
  }
});
