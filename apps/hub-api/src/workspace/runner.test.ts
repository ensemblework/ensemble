import "../runtime/test-env.js";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { engineStarted } from "./engines/registry.js";
import { killGroup, ownSessions, runCommand, sessionOf, sessionTree } from "./runner.js";

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

test("without session ids (macOS), a session is its group, what its members started and the groups they lead", () => {
  const ps = [
    "  100     1   100", // the command, its session's leader
    "  101   100   100", // a child in its group
    "  102   101   102", // a job with a group of its own (`set -m`, `timeout`)
    "  103   102   102", // in that job's group
    "  104   103   104", // started by it, in yet another group
    "  105     1   100", // left in the group after its parent ended
    "  106     1   106", // left the group, then its parent ended: not found
    "  200     1   200", // unrelated
    "  201   200   200",
    "  bad line",
  ].join("\n");
  assert.deepEqual(sessionTree([100], ps).sort((a, b) => a - b), [100, 101, 102, 103, 104, 105]);
  assert.equal(sessionTree([100, 200], ps).length, 8, "a run's sessions from one look at the table");
  assert.deepEqual(sessionTree([300], ps), []);
});

test("a command run as the agent's own ran gets the PATH and HOME the agent had, not the scratch ones", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-runner-env-"));
  try {
    const scratch = await runCommand({ argv: ["sh", "-c", 'printf "%s" "$HOME"'], cwd: root, root, sandboxed: false, network: false, useCredentials: false, who: "agent", timeoutMs: 10_000, extraEnv: { HOME: "/home/mira" } });
    assert.notEqual(scratch.output, "/home/mira", "a saved secret named HOME does not change it");
    const own = await runCommand({ argv: ["sh", "-c", 'printf "%s|%s" "$HOME" "$PATH"'], cwd: root, root, sandboxed: false, network: false, useCredentials: false, who: "agent", timeoutMs: 10_000, engineEnv: { HOME: "/home/mira", PATH: "/usr/bin:/bin" } });
    assert.equal(own.output, "/home/mira|/usr/bin:/bin");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test("a coding agent's own program joins a task run's or plan step's commands once it ends: what it left running stops when the run ends", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-runner-engine-"));
  // A stand-in agent, started as the engines start theirs (a session of its own): it runs `script` and ends.
  const agent = (job: { id: string; context: unknown }, script: string) => {
    const child = spawn("sh", ["-c", script], { cwd: root, detached: true, stdio: "ignore" });
    engineStarted({ job } as never, child);
    return { child, ended: new Promise((resolve) => child.once("exit", resolve)) };
  };
  const leaves = async (job: { id: string; context: unknown }, pidFile: string): Promise<number> => {
    const { ended } = agent(job, `sleep 60 & echo $! > ${pidFile}`);
    await ended;
    for (let tries = 0; !existsSync(join(root, pidFile)) && tries < 50; tries += 1) await settle();
    return Number(readFileSync(join(root, pidFile), "utf8"));
  };
  const kept: number[] = [];
  try {
    for (const [id, context] of [["engine-task", {}], ["engine-step", { node: { nodeId: "n1" }, mission: { id: "m1", step: "s1" } }]] as const) {
      const left = await leaves({ id, context }, `${id}.pid`);
      assert.ok(alive(left), "it outlives the agent's own program");
      killGroup(id);
      await settle();
      assert.ok(!alive(left), `${id}: the run's end stops it`);
    }
    // A chat turn's, a node's session run outside a plan, and one a paired computer was told to keep: the person may want it.
    for (const [id, context] of [["engine-chat", { chat: true }], ["engine-session", { node: { nodeId: "n1" } }], ["engine-relayed", { keepsProcesses: true }]] as const) {
      const left = await leaves({ id, context }, `${id}.pid`);
      kept.push(left);
      killGroup(id);
      await settle();
      assert.ok(alive(left), `${id}: it stays`);
    }
  } finally {
    for (const pid of kept) process.kill(pid, "SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("only a session still the run's is killed: Stop leaves a working agent's own program to its engine, an empty session is dropped, and one whose processes all ended is never killed", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-runner-own-"));
  const start = (id: string, script: string) => {
    const child = spawn("sh", ["-c", script], { cwd: root, detached: true, stdio: "ignore" });
    engineStarted({ job: { id, context: {} } } as never, child);
    return { child, ended: new Promise((resolve) => child.once("exit", resolve)) };
  };
  try {
    // Stop while the agent works: its program is the engine's to stop, never killed outright.
    const working = start("own-stop", "sleep 30");
    killGroup("own-stop");
    await settle();
    assert.ok(alive(working.child.pid!), "the working agent is left to its engine's own stop");
    working.child.kill("SIGKILL");
    await working.ended;
    // An agent that leaves nothing: nothing is kept, so its id, free again, is never killed.
    const tidy = start("own-tidy", "true");
    await tidy.ended;
    await settle();
    assert.deepEqual(ownSessions("own-tidy"), []);
    await runCommand({ argv: ["true"], cwd: root, root, sandboxed: false, network: false, useCredentials: false, who: "agent", timeoutMs: 10_000, group: "own-command" });
    assert.deepEqual(ownSessions("own-command"), [], "the same for a command of the run that left nothing");
    // One that leaves a short job: kept while the job runs, not once it ended.
    const brief = start("own-brief", "sleep 1 &");
    await brief.ended;
    assert.deepEqual(ownSessions("own-brief"), [brief.child.pid], "its session holds what it left");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.deepEqual(ownSessions("own-brief"), [], "everything it left ended: the id may be someone else's now");
    killGroup("own-brief");
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
  // The grace timer is unref'd, so it never keeps a finished process alive; here nothing else would.
  const hold = setInterval(() => undefined, 1_000);
  try {
    const controller = new AbortController();
    const never = new Promise<string>(() => undefined);
    const waiting = untilStopped(never, controller.signal, 50);
    controller.abort();
    await assert.rejects(waiting, { name: "AbortError" });
    assert.equal(await untilStopped(Promise.resolve("done"), new AbortController().signal, 50), "done");
    const already = new AbortController();
    already.abort();
    await assert.rejects(untilStopped(never, already.signal, 20), { name: "AbortError" }, "a run stopped before the call still ends");
  } finally {
    clearInterval(hold);
  }
});
