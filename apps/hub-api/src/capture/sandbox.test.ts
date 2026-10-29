/**
 * An app started for capture runs confined like an agent's command (capture/sandbox.ts): it reaches
 * its own private display (the X socket and the cookie, both hidden by the sandbox otherwise) and
 * nothing of the owner's: not another display, not Ensemble's data, not a credential variable, and it
 * writes only its own folder. Live on bubblewrap; skipped where this computer has another sandbox.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const scratch = mkdtempSync(join(homedir(), ".ensemble-capture-sandbox-"));
const app = join(scratch, "app");
const cookies = join(scratch, "display-cookie");
const sockets = join(scratch, "sockets");
const data = join(scratch, "data");
for (const dir of [app, cookies, sockets, join(data, "pglite")]) mkdirSync(dir, { recursive: true });
writeFileSync(join(cookies, "xauthority"), "magic-cookie");
writeFileSync(join(data, "secret.key"), "ensemble-key-value");
process.env.ENSEMBLE_REMOTE_STATE_DIR = data;
process.env.ENSEMBLE_WORKSPACE_ROOT = join(scratch, "workspace");
process.env.DATABASE_URL ??= "postgresql://localhost/unused";

const { captureAppWrapper, displayNumber } = await import("./sandbox.js");
const { capabilities, prepareSandbox } = await import("../workspace/sandbox/spawn.js");
after(() => rmSync(scratch, { recursive: true, force: true }));

test("display numbers: local displays only", () => {
  assert.equal(displayNumber(":7"), "7");
  assert.equal(displayNumber(":12.0"), "12");
  assert.equal(displayNumber("localhost:10.0"), null);
  assert.equal(displayNumber(undefined), null);
});

test("an app in the sandbox reaches its own display and nothing of the owner's", { timeout: 60_000 }, async (t) => {
  await prepareSandbox();
  if (capabilities().mechanism !== "bubblewrap") {
    t.skip(`this computer's sandbox is ${capabilities().mechanism}; the display binds are bubblewrap's`);
    return;
  }
  const server = createServer((socket) => socket.end("x-server")).listen(join(sockets, "X77"));
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const wrap = captureAppWrapper({ socketDir: sockets });
    const script = `
      const fs = require("fs"), net = require("net");
      const tryRead = (path) => { try { return fs.readFileSync(path, "utf8"); } catch (error) { return "refused:" + error.code; } };
      const tryWrite = (path) => { try { fs.writeFileSync(path, "x"); return "written"; } catch (error) { return "refused:" + error.code; } };
      const connect = (path) => new Promise((resolve) => { const s = net.connect(path); s.on("data", (d) => resolve(String(d))); s.on("error", (e) => resolve("refused:" + e.code)); });
      (async () => {
        const out = {
          cookie: tryRead(process.env.XAUTHORITY),
          display: await connect("/tmp/.X11-unix/X77"),
          other: await connect("/tmp/.X11-unix/X0"),
          key: tryRead(${JSON.stringify(join(data, "secret.key"))}),
          own: tryWrite("made-by-app.txt"),
          outside: tryWrite(${JSON.stringify(join(scratch, "escaped.txt"))}),
          lease: process.env.ENSEMBLE_CAPTURE_LEASE ?? null,
          token: process.env.GITHUB_TOKEN ?? null,
          mode: process.env.APP_MODE ?? null,
          display_env: process.env.DISPLAY,
        };
        process.stdout.write(JSON.stringify(out));
      })();`;
    const wrapped = await wrap({
      program: process.execPath,
      args: ["-e", script],
      cwd: app,
      env: { ...process.env, DISPLAY: ":77", XAUTHORITY: join(cookies, "xauthority"), ENSEMBLE_CAPTURE_LEASE: "lease-test", GITHUB_TOKEN: "ghp_not_for_apps", APP_MODE: "capture" },
      kind: "gui",
      network: false,
      appEnv: { APP_MODE: "capture" },
    });
    assert.equal(wrapped.program, "/usr/bin/bwrap");
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(wrapped.program, wrapped.args, { cwd: app, env: wrapped.env, stdio: ["ignore", "pipe", "pipe"] });
      let text = "";
      child.stdout.on("data", (chunk) => (text += chunk));
      child.stderr.on("data", (chunk) => (text += chunk));
      child.on("error", reject);
      child.on("close", () => resolve(text));
    });
    const seen = JSON.parse(output) as Record<string, string | null>;
    assert.equal(seen.cookie, "magic-cookie", "its display's cookie");
    assert.equal(seen.display, "x-server", "its display's socket");
    assert.match(seen.other ?? "", /^refused:/, "never another display, the owner's included");
    assert.match(seen.key ?? "", /^refused:/, "never Ensemble's data");
    assert.equal(seen.own, "written", "its own folder");
    // bubblewrap's home is an empty tmpfs: a write outside the grants lands there and is gone.
    assert.equal(existsSync(join(scratch, "escaped.txt")), false, "nothing outside its folder");
    assert.equal(existsSync(join(app, "made-by-app.txt")), true);
    assert.equal(seen.lease, "lease-test", "the lease's id, which the janitor reads");
    assert.equal(seen.token, null, "no credential variable");
    assert.equal(seen.mode, "capture", "the variables the app was given");
    assert.equal(seen.display_env, ":77");
  } finally {
    server.close();
  }
});

test("an app is never started in the home folder or Ensemble's data", async () => {
  const wrap = captureAppWrapper({ socketDir: sockets });
  for (const cwd of [homedir(), data]) {
    await assert.rejects(wrap({ program: "/bin/sh", args: ["-c", "true"], cwd, env: {}, kind: "gui" }), /not started/);
  }
});
