import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bareSystemPath, knownToolDirs, loginShellPath, mergePath, pathFromShellOutput, userToolPath } from "./user-path.js";

test("the usual install folders: ~/.local/bin (Claude Code, Cursor), Homebrew, npm, nvm newest first", () => {
  const home = mkdtempSync(join(tmpdir(), "ensemble-home-"));
  for (const version of ["v18.20.1", "v22.3.0", "v20.11.0"]) mkdirSync(join(home, ".nvm", "versions", "node", version, "bin"), { recursive: true });
  const mac = knownToolDirs("darwin", home, {});
  assert.equal(mac[0], join(home, ".local", "bin"));
  assert.ok(mac.includes("/opt/homebrew/bin"));
  assert.ok(mac.includes(join(home, ".npm-global", "bin")));
  const nvm = mac.filter((dir) => dir.includes(".nvm"));
  assert.deepEqual(nvm.map((dir) => dir.split("/").at(-2)), ["v22.3.0", "v20.11.0", "v18.20.1"]);
  const windows = knownToolDirs("win32", "C:\\Users\\me", { APPDATA: "C:\\Users\\me\\AppData\\Roaming" });
  assert.ok(windows.some((dir) => dir.endsWith("npm")));
});

test("merged PATH: each folder once, in order, absolute only, nothing inside the workspace, known folders only if present", () => {
  const present = mkdtempSync(join(tmpdir(), "ensemble-bin-"));
  const merged = mergePath(
    [
      { entries: ["/opt/homebrew/bin", "/usr/bin", "relative/bin", "", "/work/space/node_modules/.bin"] },
      { entries: ["/usr/bin", "/bin"] },
      { entries: [present, "/no/such/folder"], mustExist: true },
    ],
    "/work/space",
    ":",
  );
  assert.equal(merged, ["/opt/homebrew/bin", "/usr/bin", "/bin", present].join(":"));
});

test("the login shell's PATH is read between markers, past whatever the rc files print", () => {
  assert.equal(pathFromShellOutput("conda says hi\n__ENSEMBLE_PATH__\n/a:/b\n__ENSEMBLE_PATH__\n"), "/a:/b");
  assert.equal(pathFromShellOutput("no markers"), null);
});

test("a login shell that prints its PATH is read; one that hangs gives up", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-shell-"));
  const quick = join(dir, "quick-shell");
  writeFileSync(quick, "#!/bin/sh\necho 'welcome!'\nexport PATH=/from/login:/usr/bin\neval \"$2\"\n");
  chmodSync(quick, 0o755);
  assert.equal(await loginShellPath(quick), "/from/login:/usr/bin");
  const slow = join(dir, "slow-shell");
  writeFileSync(slow, "#!/bin/sh\nsleep 30\n");
  chmodSync(slow, 0o755);
  const started = Date.now();
  assert.equal(await loginShellPath(slow, 300), null);
  assert.ok(Date.now() - started < 3000);
});

test("started with the bare system PATH (login service, GUI), the login shell's PATH comes first", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-shell-"));
  const shell = join(dir, "zsh");
  writeFileSync(shell, "#!/bin/sh\nexport PATH=/Users/me/.local/bin:/opt/homebrew/bin:/usr/bin\neval \"$2\"\n");
  chmodSync(shell, 0o755);
  const home = mkdtempSync(join(tmpdir(), "ensemble-home-"));
  const path = await userToolPath({ platform: "darwin", home, env: { SHELL: shell, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, workspaceRoot: "/Users/me/ensemble-workspace" });
  assert.equal(path.split(":").slice(0, 5).join(":"), "/Users/me/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin");
  // Started from the person's terminal: that PATH (an `nvm use`, a stand-in in a test) stays first.
  const fromTerminal = await userToolPath({ platform: "darwin", home, env: { SHELL: shell, PATH: "/tmp/stand-in/bin:/usr/bin:/bin" } });
  assert.equal(fromTerminal.split(":").slice(0, 4).join(":"), "/tmp/stand-in/bin:/usr/bin:/bin:/Users/me/.local/bin");
  assert.equal(bareSystemPath("/usr/bin:/bin:/usr/sbin:/sbin"), true);
  assert.equal(bareSystemPath("/opt/homebrew/bin:/usr/bin"), false);
});
