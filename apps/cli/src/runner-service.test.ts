import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveCliPaths, type CliPaths } from "./paths.js";
import { installedRunnerService, startRunnerService, type ExecFile } from "./services.js";
import { startRunner, waitForOtherRuntime, type RunnerService } from "./sidecar.js";

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "ensemble-cli-service-start-"));
  const paths = resolveCliPaths({ platform: "linux", env: { ENSEMBLE_CONFIG_DIR: join(root, "config"), ENSEMBLE_DATA_HOME: join(root, "data") }, home: root });
  return { root, paths };
}

const TOKEN = "t".repeat(32);

/** What a runtime does once it is up: answer /health with its token and say where in the discovery file. */
async function fakeRuntime(paths: CliPaths): Promise<Server> {
  const server = createServer((request, response) => {
    response.writeHead(request.headers.authorization === `Bearer ${TOKEN}` ? 200 : 401);
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  await mkdir(dirname(paths.discoveryFile), { recursive: true });
  await writeFile(paths.discoveryFile, JSON.stringify({ port: (server.address() as AddressInfo).port, token: TOKEN, pid: process.pid, owner: "cli", mode: "runner", version: "cli-0.0.0" }));
  return server;
}

test("with the login service installed, Ensemble starts the service and uses its runtime, never a second one of its own", async () => {
  const { root, paths } = await sandbox();
  const servers: Server[] = [];
  const calls: string[] = [];
  const service: RunnerService = {
    installed: async () => "com.ensemblework.cli.runner",
    start: async () => {
      calls.push("start");
      servers.push(await fakeRuntime(paths));
    },
  };
  // No sidecar here: a runtime of the launcher's own could not start, so the test fails if one is tried.
  const sidecarDir = join(root, "no-sidecar");
  try {
    const session = await startRunner({ sidecarDir, paths, service, serviceWaitMs: 5_000 });
    assert.deepEqual(calls, ["start"]);
    assert.equal(session?.service, "com.ensemblework.cli.runner");
    assert.equal(session?.child, undefined, "nothing of the launcher's own runs");
    assert.equal(session?.discovery.token, TOKEN, "it attaches to the service's runtime");
    assert.equal(await startRunner({ sidecarDir, paths, service }), null, "once it runs, starting again starts nothing");
    assert.deepEqual(calls, ["start"]);
  } finally {
    for (const server of servers) server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the service itself (runner start --foreground) never starts the service, and a service that does not bring Ensemble up is reported", async () => {
  const { root, paths } = await sandbox();
  const calls: string[] = [];
  const service: RunnerService = { installed: async () => "ensemble-runner.service", start: async () => void calls.push("start") };
  const sidecarDir = join(root, "no-sidecar");
  try {
    await assert.rejects(startRunner({ sidecarDir, paths, service, foreground: true }), /packaged Ensemble sidecar is not installed/);
    assert.deepEqual(calls, [], "the service's own launcher runs the runtime itself");
    await assert.rejects(startRunner({ sidecarDir, paths, service, serviceWaitMs: 600 }), /login service \(ensemble-runner\.service\) did not start Ensemble within 1 second\./);
    assert.deepEqual(calls, ["start"], "no runtime of the launcher's own was started instead");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the installed login service is found, and started the way each service manager starts one", async () => {
  const home = await mkdtemp(join(tmpdir(), "ensemble-cli-service-home-"));
  const calls: string[] = [];
  let failing: string[] = [];
  const exec: ExecFile = async (command, args) => {
    calls.push([command, ...args].join(" "));
    if (failing.some((word) => args.includes(word))) throw new Error(`${command} ${args[0]} failed`);
  };
  try {
    assert.equal(await installedRunnerService({ platform: "darwin", home }), null);
    await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(join(home, "Library", "LaunchAgents", "com.ensemblework.cli.runner.plist"), "<plist/>");
    assert.equal(await installedRunnerService({ platform: "darwin", home }), "com.ensemblework.cli.runner");
    assert.equal(await installedRunnerService({ platform: "linux", home }), null);
    await mkdir(join(home, ".config", "systemd", "user"), { recursive: true });
    await writeFile(join(home, ".config", "systemd", "user", "ensemble-runner.service"), "[Unit]");
    assert.equal(await installedRunnerService({ platform: "linux", home }), "ensemble-runner.service");
    assert.equal(await installedRunnerService({ platform: "win32", home, execFile: exec }), "Ensemble Runner");
    failing = ["/Query"];
    assert.equal(await installedRunnerService({ platform: "win32", home, execFile: exec }), null);

    calls.length = 0;
    failing = [];
    await startRunnerService({ platform: "darwin", home, execFile: exec });
    assert.equal(calls.length, 1);
    assert.match(calls[0]!, /^launchctl kickstart gui\/\d*\/com\.ensemblework\.cli\.runner$/, "a running service is left as it is (no -k)");
    calls.length = 0;
    failing = ["kickstart"];
    await startRunnerService({ platform: "darwin", home, execFile: exec });
    assert.match(calls[1]!, /^launchctl bootstrap gui\/\d* .*com\.ensemblework\.cli\.runner\.plist$/, "a service that is not loaded is loaded, which starts it");
    failing = ["kickstart", "bootstrap"];
    await assert.rejects(startRunnerService({ platform: "darwin", home, execFile: exec }), /installed but did not start .*runner install/);
    calls.length = 0;
    failing = [];
    await startRunnerService({ platform: "linux", home, execFile: exec });
    await startRunnerService({ platform: "win32", home, execFile: exec });
    assert.deepEqual(calls, ["systemctl --user start ensemble-runner.service", "schtasks.exe /Run /TN Ensemble Runner"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the service waits while another runtime holds the data folder, not only while one answers", async () => {
  const { root, paths } = await sandbox();
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 800)"], { stdio: "ignore" });
  let server: Server | null = null;
  try {
    await mkdir(paths.dataHome, { recursive: true });
    await writeFile(join(paths.dataHome, "runtime.lock"), JSON.stringify({ pid: holder.pid, owner: "cli", startedAt: new Date().toISOString() }));
    const began = Date.now();
    await waitForOtherRuntime(paths, 50);
    assert.ok(Date.now() - began >= 500, "it waits until the process holding the lock exits, though that one never answered");

    await rm(join(paths.dataHome, "runtime.lock"), { force: true });
    server = await fakeRuntime(paths);
    const answering = server;
    setTimeout(() => {
      answering.close();
      answering.closeAllConnections();
    }, 400);
    const waited = Date.now();
    await waitForOtherRuntime(paths, 50);
    assert.ok(Date.now() - waited >= 300, "and while one answers");
  } finally {
    holder.kill();
    server?.close();
    await rm(root, { recursive: true, force: true });
  }
});
