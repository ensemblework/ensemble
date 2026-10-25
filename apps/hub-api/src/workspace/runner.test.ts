import "../runtime/test-env.js";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { killGroup, runCommand, sessionOf } from "./runner.js";

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

test("a Linux stat line gives the session id, whatever the command name holds", () => {
  assert.equal(sessionOf("4242 (node (tsx) x) S 1 4242 4200 0 -1 4194560"), 4200);
  assert.equal(sessionOf("7 (sh) R 1 7 7 34816 7"), 7);
});

test("a command is over when its own process exits, even if a process it started keeps the output open", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-runner-"));
  try {
    const started = Date.now();
    const result = await runCommand({ argv: ["sh", "-c", "sleep 30 & echo $! > left.pid; echo done"], cwd: root, root, sandboxed: false, network: false, useCredentials: false, who: "agent", timeoutMs: 20_000, group: "runner-left" });
    assert.ok(Date.now() - started < 10_000, "the background sleep does not hold the result");
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /done/);
    assert.match(result.output, /still running \(pid \d+\)\. They are stopped when the run ends\./);
    const left = Number(readFileSync(join(root, "left.pid"), "utf8"));
    assert.ok(alive(left));
    killGroup("runner-left");
    await settle();
    assert.ok(!alive(left), "the run's end stops what its commands left running");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a timeout and Stop kill processes that left the command's process group", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-runner-"));
  try {
    // `set -m`: the background job gets a process group of its own, as `timeout` or a test runner may do.
    const timedOut = await runCommand({ argv: ["bash", "-c", "set -m; sleep 60 & echo $! > escaped.pid; wait"], cwd: root, root, sandboxed: false, network: false, useCredentials: false, who: "agent", timeoutMs: 1_000 });
    assert.equal(timedOut.timedOut, true);
    await settle();
    assert.ok(!alive(Number(readFileSync(join(root, "escaped.pid"), "utf8"))), "the escaped process is killed with its session");

    const controller = new AbortController();
    const running = runCommand({ argv: ["bash", "-c", "set -m; sleep 60 & echo $! > stopped.pid; wait"], cwd: root, root, sandboxed: false, network: false, useCredentials: false, who: "agent", timeoutMs: 60_000, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const started = Date.now();
    controller.abort();
    const stopped = await running;
    assert.equal(stopped.killed, true);
    assert.ok(Date.now() - started < 5_000, "Stop ends the command at once");
    await settle();
    assert.ok(!alive(Number(readFileSync(join(root, "stopped.pid"), "utf8"))));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("after Stop, a tool call that does not end within the grace no longer holds the run", async () => {
  const { untilStopped } = await import("./agent.js");
  const controller = new AbortController();
  const never = new Promise<string>(() => undefined);
  const waiting = untilStopped(never, controller.signal, 50);
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  assert.equal(await untilStopped(Promise.resolve("done"), new AbortController().signal, 50), "done");
  const already = new AbortController();
  already.abort();
  await assert.rejects(untilStopped(never, already.signal, 20), { name: "AbortError" }, "a run stopped before the call still ends");
});
