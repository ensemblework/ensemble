/**
 * Capture's leases and janitor: ending a lease ends what belongs to it, expired and dead leases are
 * swept, and at start-up whatever a crashed runtime left behind is stopped, except processes whose
 * id was reused since. One test does this with a real process group.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { LeaseTable, processIdentity, realProcessOps, type LeaseRecord, type ProcessOps } from "./leases.js";

type Proc = { identity: string; alive: boolean; groupAlive: boolean; ignoresTerm?: boolean };

/** A process table the tests control; signals are recorded and take effect at once. */
function fakeOps(processes: Map<number, Proc>, removed: string[], signals: Array<[number, string]>): ProcessOps & { clock: number } {
  const ops = {
    selfPid: 100,
    clock: 1_000_000,
    alive: (pid: number) => processes.get(pid)?.alive ?? false,
    groupAlive: (pid: number) => processes.get(pid)?.groupAlive ?? false,
    identity: (pid: number) => (processes.get(pid)?.alive ? processes.get(pid)!.identity : null),
    signalGroup: (pid: number, signal: NodeJS.Signals) => {
      signals.push([pid, signal]);
      const proc = processes.get(pid);
      if (proc && (signal === "SIGKILL" || !proc.ignoresTerm)) {
        proc.alive = false;
        proc.groupAlive = false;
      }
    },
    removeFile: (path: string) => void removed.push(path),
    now: () => ops.clock,
    sleep: async (ms: number) => void (ops.clock += ms),
  };
  return ops;
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-leases-"));
  const processes = new Map<number, Proc>([[100, { identity: "self", alive: true, groupAlive: true }]]);
  const removed: string[] = [];
  const signals: Array<[number, string]> = [];
  const ops = fakeOps(processes, removed, signals);
  const file = join(dir, "capture", "leases.json");
  const spawned = (pid: number, over: Partial<Proc> = {}) => processes.set(pid, { identity: `start-${pid}`, alive: true, groupAlive: true, ...over });
  return { dir, processes, removed, signals, ops, file, spawned, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const saved = (file: string): LeaseRecord[] => (JSON.parse(readFileSync(file, "utf8")) as { leases: LeaseRecord[] }).leases;

test("ending a display ends its window manager and app first, signals each group and removes its files", async () => {
  const t = setup();
  try {
    const table = new LeaseTable(t.file, t.ops);
    const ended: string[] = [];
    table.onEnded = (record, reason) => ended.push(`${record.kind}:${reason}`);
    t.spawned(200);
    t.spawned(201);
    t.spawned(202, { ignoresTerm: true });
    const display = table.add({ kind: "display", pid: 200, label: "virtual display :99", expiresAt: t.ops.clock + 60_000, files: ["/data/capture/displays/xauth-1"] });
    table.add({ kind: "window-manager", pid: 201, label: "openbox on :99", expiresAt: display.expiresAt, parent: display.id });
    table.add({ kind: "app", pid: 202, label: "app gedit", expiresAt: display.expiresAt, parent: display.id, operation: "job-1" });
    assert.equal(saved(t.file).length, 3);
    assert.deepEqual(saved(t.file)[0]!.owner, { pid: 100, identity: "self" });
    await table.end(display.id, "released");
    assert.deepEqual(ended, ["window-manager:released", "app:released", "display:released"]);
    assert.deepEqual(t.signals, [[201, "SIGTERM"], [202, "SIGTERM"], [202, "SIGKILL"], [200, "SIGTERM"]], "a group that ignores SIGTERM gets SIGKILL");
    assert.deepEqual(t.removed, ["/data/capture/displays/xauth-1"]);
    assert.deepEqual(table.list(), []);
    assert.deepEqual(saved(t.file), []);
  } finally {
    t.cleanup();
  }
});

test("the janitor ends expired leases and leases whose process has gone; renewing keeps one", async () => {
  const t = setup();
  try {
    const table = new LeaseTable(t.file, t.ops);
    const reasons: string[] = [];
    table.onEnded = (record, reason) => reasons.push(`${record.label}:${reason}`);
    t.spawned(300);
    t.spawned(301);
    t.spawned(302);
    const short = table.add({ kind: "recording", pid: 300, label: "short", expiresAt: t.ops.clock + 1_000 });
    const crashed = table.add({ kind: "app", pid: 301, label: "crashes", expiresAt: t.ops.clock + 60_000 });
    const kept = table.add({ kind: "app", pid: 302, label: "kept", expiresAt: t.ops.clock + 1_000 });
    table.renew(kept.id, 10_000);
    t.processes.get(301)!.alive = false;
    t.processes.get(301)!.groupAlive = false;
    t.ops.clock += 2_000;
    const swept = await table.sweep();
    assert.deepEqual(swept.sort(), [short.id, crashed.id].sort());
    assert.deepEqual(reasons.sort(), ["crashes:process ended", "short:lease expired"]);
    assert.deepEqual(table.list().map((record) => record.label), ["kept"]);
  } finally {
    t.cleanup();
  }
});

test("at start-up, leftovers of a runtime that is gone are stopped; a live runtime's and reused process ids are left alone", async () => {
  const t = setup();
  try {
    t.spawned(500, { identity: "old-display" });
    t.spawned(501, { identity: "now-someone-else" });
    t.spawned(700, { identity: "other-runtime" });
    t.spawned(701, { identity: "their-display" });
    t.processes.set(502, { identity: "gone", alive: false, groupAlive: true });
    const dead = { pid: 90, identity: "crashed" };
    const live = { pid: 700, identity: "other-runtime" };
    const record = (over: Partial<LeaseRecord>): LeaseRecord => ({ id: "x", kind: "display", pid: 0, identity: null, owner: dead, label: "", createdAt: 0, expiresAt: 0, ...over });
    mkdirSync(dirname(t.file), { recursive: true });
    const leases = [
      record({ id: "display-1", pid: 500, identity: "old-display", label: "virtual display :99", files: ["/data/capture/displays/xauth-1"] }),
      record({ id: "app-1", kind: "app", pid: 501, identity: "the-app", label: "app reused pid" }),
      record({ id: "app-2", kind: "app", pid: 502, identity: "gone-leader", label: "app with orphans" }),
      record({ id: "display-2", pid: 701, identity: "their-display", owner: live, label: "another runtime's display" }),
    ];
    writeFileSync(t.file, JSON.stringify({ version: 1, leases }));
    const table = new LeaseTable(t.file, t.ops);
    const reaped = await table.reapLeftovers(100);
    assert.deepEqual(reaped, ["display-1", "app-1", "app-2"]);
    assert.ok(t.signals.some(([pid]) => pid === 500), "our old display is stopped");
    assert.ok(!t.signals.some(([pid]) => pid === 501), "a process that reused the id is not touched");
    assert.ok(t.signals.some(([pid]) => pid === 502), "orphans of our group are stopped though their leader is gone");
    assert.ok(!t.signals.some(([pid]) => pid === 701), "a running runtime keeps its leases");
    assert.deepEqual(t.removed, ["/data/capture/displays/xauth-1"]);
    assert.deepEqual(saved(t.file).map((item) => item.id), ["display-2"]);
  } finally {
    t.cleanup();
  }
});

test("on exit every group this runtime holds is killed at once", () => {
  const t = setup();
  try {
    const table = new LeaseTable(t.file, t.ops);
    t.spawned(600);
    t.spawned(601);
    table.add({ kind: "display", pid: 600, label: "display", expiresAt: t.ops.clock + 1_000, files: ["/c/xauth"] });
    table.add({ kind: "app", pid: 601, label: "app", expiresAt: t.ops.clock + 1_000 });
    table.endAllSync();
    assert.deepEqual(t.signals, [[600, "SIGKILL"], [601, "SIGKILL"]]);
    assert.deepEqual(t.removed, ["/c/xauth"]);
    assert.deepEqual(saved(t.file), []);
  } finally {
    t.cleanup();
  }
});

const posix = process.platform === "win32" ? "process groups are POSIX" : false;

test("a killed runtime leaves nothing behind: the next start stops its real process group", { skip: posix, timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-leftover-"));
  const file = join(dir, "leases.json");
  // Stands in for an app (and its child) that a runtime started before it was killed.
  const app = spawn(process.execPath, ["-e", "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  app.unref();
  const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => gone.once("exit", resolve));
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const lease: LeaseRecord = {
      id: "app-left",
      kind: "app",
      pid: app.pid!,
      identity: processIdentity(app.pid!),
      owner: { pid: gone.pid!, identity: "a runtime that was killed" },
      label: "app left by a killed runtime",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      files: [join(dir, "xauth-left")],
    };
    writeFileSync(join(dir, "xauth-left"), "cookie");
    writeFileSync(file, JSON.stringify({ version: 1, leases: [lease] }));
    const table = new LeaseTable(file, realProcessOps());
    assert.deepEqual(await table.reapLeftovers(2_000), ["app-left"]);
    const deadline = Date.now() + 5_000;
    while (realProcessOps().groupAlive(app.pid!) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(realProcessOps().groupAlive(app.pid!), false, "the app and its child are gone");
    assert.equal(existsSync(join(dir, "xauth-left")), false);
  } finally {
    try {
      process.kill(-app.pid!, "SIGKILL");
    } catch {
      // Already gone.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
