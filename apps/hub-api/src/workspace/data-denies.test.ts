/**
 * Ensemble's own data, wherever this runtime keeps it, is out of every run's reach: the testing CLI's
 * data folder (which holds its workspace) and one `ENSEMBLE_DATA_HOME` puts elsewhere, with the key that
 * encrypts saved secrets, the database and the browser profiles. The guard refuses the paths, no folder
 * holding one is handed to a run, and the OS sandbox denies them even inside a folder a run was given.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

// The testing CLI's layout: its workspace inside its data folder (apps/cli/src/sidecar.ts).
const scratch = mkdtempSync(join(homedir(), ".ensemble-data-denies-"));
const data = join(scratch, "com.ensemblework.cli.testing");
const workspace = join(data, "workspace");
mkdirSync(join(workspace, "runs", "job"), { recursive: true });
mkdirSync(join(data, "pglite"), { recursive: true });
mkdirSync(join(data, "browser", "default"), { recursive: true });
writeFileSync(join(data, "secret.key"), "ensemble-testing-key-value");
writeFileSync(join(data, "browser", "default", "Cookies"), "session=cookie-value");
writeFileSync(join(workspace, "runs", "job", "app.js"), "console.log('app')\n");
writeFileSync(join(scratch, "notes.txt"), "readable notes");
process.env.ENSEMBLE_REMOTE_STATE_DIR = data;
process.env.ENSEMBLE_DATA_DIR = join(data, "pglite");
process.env.ENSEMBLE_SECRET_KEY_FILE = join(data, "secret.key");
process.env.ENSEMBLE_WORKSPACE_ROOT = workspace;
process.env.DATABASE_URL ??= "postgresql://localhost/unused";

const { ensembleDataDenies, isEnsembleData } = await import("./data-denies.js");
const { holdsProtected, outsideRefusal } = await import("./guard.js");
const { capabilities, prepareSandbox, prepareSpawn, startSandboxed } = await import("./sandbox/spawn.js");
const { browserDeniedPaths } = await import("../browser/paths.js");
after(() => rmSync(scratch, { recursive: true, force: true }));

test("the testing CLI's data folder is denied entry by entry, all but its workspace", () => {
  const denies = ensembleDataDenies();
  for (const path of [join(data, "pglite"), join(data, "secret.key"), ...browserDeniedPaths(data)]) assert.ok(denies.includes(path), `${path} is denied`);
  assert.ok(!denies.some((path) => path === data || path === workspace || workspace.startsWith(`${path}/`)), "never the workspace or a folder holding it");
  assert.equal(isEnsembleData(join(data, "secret.key")), true);
  assert.equal(isEnsembleData(join(data, "browser", "default", "Cookies")), true);
  assert.equal(isEnsembleData(join(workspace, "runs", "job", "app.js")), false);
});

test("the guard refuses the key, the database and the cookies, and still lets runs work in the workspace", () => {
  assert.match(outsideRefusal(join(data, "secret.key"), false) ?? "", /Ensemble's own data/);
  assert.match(outsideRefusal(join(data, "pglite", "PG_VERSION"), false) ?? "", /Ensemble's own data/);
  assert.match(outsideRefusal(join(data, "browser", "default", "Cookies"), false) ?? "", /Ensemble's own data/);
  assert.match(outsideRefusal(join(data, "capture", "leases.json"), true) ?? "", /Ensemble's own data/);
  assert.equal(outsideRefusal(join(workspace, "runs", "job", "app.js"), true), null);
  assert.equal(holdsProtected(data), true, "the data folder is never handed to a run");
  assert.equal(holdsProtected(scratch), true, "nor a folder that holds it");
});

test("a data folder ENSEMBLE_DATA_HOME puts outside the home folder is refused too", () => {
  const elsewhere = join(scratch, "srv", "ensemble");
  const env = { ENSEMBLE_REMOTE_STATE_DIR: elsewhere, ENSEMBLE_WORKSPACE_ROOT: join(scratch, "work") };
  const denies = ensembleDataDenies({ env, home: join(scratch, "home") });
  assert.ok(denies.includes(elsewhere), "the whole folder, when it does not hold the workspace");
  assert.ok(denies.includes(join(elsewhere, "browser")) && denies.includes(join(elsewhere, "capture")), "the browser profiles and capture's state");
});

test("the OS sandbox denies the data folder inside a folder the run was given, and the browser profiles", { timeout: 120_000 }, async (t) => {
  const caps = await prepareSandbox();
  if (!caps.osSandbox) {
    t.skip(`no OS sandbox here: ${caps.reason}`);
    return;
  }
  const policy = {
    runId: "data-denies",
    cwd: join(workspace, "runs", "job"),
    readWrite: [join(workspace, "runs", "job")],
    // A grant that reaches the data folder: the deny must still win.
    readOnly: [scratch],
    deny: [],
    network: "none" as const,
    env: { PATH: process.env.PATH ?? "" },
    who: "agent" as const,
    home: homedir(),
    ensembleSource: join(scratch, "no-source"),
    appDataDir: join(scratch, "no-desktop-data"),
    confined: true,
  };
  if (capabilities().mechanism === "bubblewrap") {
    const args = prepareSpawn(policy, { program: "/bin/cat", args: [] }).args.join(" ");
    assert.ok(args.includes(`--ro-bind /dev/null ${join(data, "secret.key")}`), "the key file is covered");
    assert.ok(args.includes(`--tmpfs ${join(data, "pglite")}`) && args.includes(`--tmpfs ${join(data, "browser")}`), "the database and the browser profiles are emptied");
  }
  const read = (path: string) =>
    new Promise<{ code: number; output: string }>((resolve, reject) => {
      let started;
      try {
        started = startSandboxed(policy, { program: process.execPath, args: ["-e", `process.stdout.write(require("fs").readFileSync(${JSON.stringify(path)}, "utf8"))`] });
      } catch (error) {
        // Landlock refuses a grant that would expose a denied place: nothing runs at all.
        resolve({ code: -1, output: error instanceof Error ? error.message : String(error) });
        return;
      }
      let output = "";
      started.child.stdout?.on("data", (chunk) => (output += chunk));
      started.child.stderr?.on("data", (chunk) => (output += chunk));
      started.child.on("error", reject);
      started.child.on("close", (code) => resolve({ code: code ?? 1, output }));
    });
  const key = await read(join(data, "secret.key"));
  assert.doesNotMatch(key.output, /ensemble-testing-key-value/, "the key that encrypts saved secrets");
  const cookies = await read(join(data, "browser", "default", "Cookies"));
  assert.doesNotMatch(cookies.output, /cookie-value/, "the browser profile's cookies");
  if (key.code !== -1) {
    const notes = await read(join(scratch, "notes.txt"));
    assert.equal(notes.output, "readable notes", "the rest of the grant stays readable");
  }
  assert.ok(existsSync(join(data, "secret.key")));
});
