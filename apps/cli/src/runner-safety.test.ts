import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserCommand, safeBrowserUrl } from "./browser.js";
import { resolveCliPaths } from "./paths.js";
import { installRunnerService, launchAgentPlist, uninstallRunnerService } from "./services.js";
import { readRunnerPid, stopRunner, writeRunnerPid } from "./sidecar.js";
import { dailyUpdateNotice } from "./update.js";

async function sandboxPaths() {
  const root = await mkdtemp(join(tmpdir(), "ensemble-cli-safety-"));
  const paths = resolveCliPaths({ platform: "linux", env: { ENSEMBLE_CONFIG_DIR: join(root, "config"), ENSEMBLE_DATA_HOME: join(root, "data") }, home: root });
  return { root, paths };
}

test("only web addresses reach the OS opener", () => {
  assert.equal(safeBrowserUrl("https://app.ensemblework.com/link?code=BCDF-GHJK"), "https://app.ensemblework.com/link?code=BCDF-GHJK");
  assert.equal(safeBrowserUrl("http://localhost:3000/link"), "http://localhost:3000/link");
  assert.equal(safeBrowserUrl("http://127.0.0.1:3000/link"), "http://127.0.0.1:3000/link");
  assert.equal(safeBrowserUrl("http://[::1]:3000/link"), "http://[::1]:3000/link");
  assert.equal(safeBrowserUrl("http://evil.example/link"), null);
  assert.equal(safeBrowserUrl("file:///etc/passwd"), null);
  assert.equal(safeBrowserUrl("javascript:alert(1)"), null);
  assert.equal(safeBrowserUrl("smb://host/share"), null);
  assert.equal(safeBrowserUrl("https://user:pass@example.com/"), null);
  assert.equal(safeBrowserUrl("not a url"), null);
  assert.deepEqual(browserCommand("https://a.test/?x=1&y=2", "win32"), {
    command: "rundll32.exe",
    args: ["url.dll,FileProtocolHandler", "https://a.test/?x=1&y=2"],
  });
});

test("stopRunner never signals a pid that the live runner does not confirm", async () => {
  const { root, paths } = await sandboxPaths();
  const bystander = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  try {
    await writeRunnerPid({ pid: bystander.pid!, startedAt: new Date().toISOString() }, paths);
    assert.equal(await stopRunner(paths, 0), false);
    assert.equal(bystander.exitCode, null);
    assert.doesNotThrow(() => process.kill(bystander.pid!, 0));
    assert.equal(await readRunnerPid(paths), null);
    await writeFile(paths.discoveryFile, JSON.stringify({ port: 9, token: "x".repeat(32), pid: bystander.pid }));
    await writeRunnerPid({ pid: bystander.pid!, startedAt: "" }, paths);
    assert.equal(await stopRunner(paths, 0), false);
    assert.doesNotThrow(() => process.kill(bystander.pid!, 0));
  } finally {
    bystander.kill();
    await rm(root, { recursive: true, force: true });
  }
});

test("LaunchAgent restarts only after a crash, and install replaces a loaded job", async () => {
  const plist = launchAgentPlist({ launcher: "/usr/local/bin/ensemble", logPath: "/tmp/runner.log" });
  assert.match(plist, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
  const root = await mkdtemp(join(tmpdir(), "ensemble-cli-service-"));
  const calls: Array<{ command: string; args: string[]; quiet: boolean }> = [];
  const exec = async (command: string, args: string[], options?: { quiet?: boolean }) => {
    calls.push({ command, args, quiet: Boolean(options?.quiet) });
    if (args[0] === "bootout") throw new Error("Boot-out failed: 3: No such process");
  };
  try {
    await installRunnerService({ platform: "darwin", home: root, launcher: "/usr/local/bin/ensemble", logPath: "/tmp/runner.log", execFile: exec });
    assert.deepEqual(
      calls.map((call) => [call.args[0], call.quiet]),
      [
        ["bootout", true],
        ["bootstrap", false],
      ],
    );
    assert.match(calls[0]!.args[1]!, /^gui\/\d*\/com\.ensemblework\.cli\.runner$/);
    calls.length = 0;
    assert.match(await uninstallRunnerService({ platform: "darwin", home: root, execFile: exec }), /Removed LaunchAgent/);
    await assert.rejects(readFile(join(root, "Library", "LaunchAgents", "com.ensemblework.cli.runner.plist")));
    calls.length = 0;
    await installRunnerService({ platform: "linux", home: root, launcher: "/usr/bin/ensemble", logPath: "/tmp/runner.log", execFile: exec });
    assert.deepEqual(
      calls.map((call) => call.args.slice(1).join(" ")),
      ["daemon-reload", "enable ensemble-runner.service", "restart ensemble-runner.service"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed update check is cached for a day and never throws", async () => {
  const { root, paths } = await sandboxPaths();
  let calls = 0;
  const failing = async () => {
    calls += 1;
    throw new Error("network down");
  };
  try {
    const now = new Date("2026-10-06T12:00:00Z");
    assert.equal(await dailyUpdateNotice({ paths, currentVersion: "0.1.0", fetchImpl: failing, now, env: {} }), null);
    assert.equal(await dailyUpdateNotice({ paths, currentVersion: "0.1.0", fetchImpl: failing, now, env: {} }), null);
    assert.equal(calls, 1);
    const cache = JSON.parse(await readFile(paths.updateCacheFile, "utf8")) as { checkedAt: string; latest: string | null };
    assert.equal(cache.latest, null);
    let signal: AbortSignal | undefined;
    const slow = async (_input: string | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Response("[]");
    };
    await dailyUpdateNotice({ paths, currentVersion: "0.1.0", fetchImpl: slow, now: new Date("2026-10-08T12:00:00Z"), env: {} });
    assert.ok(signal, "update check passes a timeout signal");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
