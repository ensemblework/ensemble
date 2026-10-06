/**
 * The real desktop sidecar against a fake hosted API (doc 25 §4.3).
 * Pair, claim, run, answer from the web, refuse a server that answers the
 * wrong question or a push to another branch, stop on 401, and do not re-run
 * after the lease expires while the app is quit.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { makeTestDirectory } from "../test/temporary.js";
import { join } from "node:path";
import test from "node:test";
import { bootSidecar, git, makeSourceRepo, prepareAccount, sleep, startStubRuntime, type Sidecar } from "../desktop/e2e-harness.js";
import { startFakeHost } from "./fake-host.js";

async function until<T>(what: string, probe: () => Promise<T | undefined | null | false>, timeoutMs = 90_000): Promise<T> {
  const started = Date.now();
  let last: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
}

type Card = {
  id: string;
  title: string;
  status: string;
  origin?: "local" | "web";
  branch: string;
  folder: string;
  error: string | null;
};

async function cards(side: Sidecar): Promise<Card[]> {
  const read = await side.api<{ queued: Card[]; running: Card[]; waiting: Card[]; stopped: Card[]; completed: Card[] }>("/api/workspace");
  assert.equal(read.status, 200, JSON.stringify(read.body));
  return [...read.body.queued, ...read.body.running, ...read.body.waiting, ...read.body.stopped, ...read.body.completed];
}

const findCard = (rows: Card[], title: string, origin: "web" | "local") => rows.find((row) => row.title === title && row.origin === origin);

async function waitJob(side: Sidecar, title: string, origin: "web" | "local", statuses: string[], timeoutMs = 90_000): Promise<Card> {
  return until(
    `${title} → ${statuses.join("/")}`,
    async () => {
      const row = findCard(await cards(side), title, origin);
      if (!row) return null;
      if (["failed", "blocked"].includes(row.status) && !statuses.includes(row.status)) throw new Error(`${title} ${row.status}: ${row.error}`);
      return statuses.includes(row.status) ? row : null;
    },
    timeoutMs,
  );
}

type Decision = { id: string; event: string; toolName: string; sessionId: string | null; status?: string; detail: { options?: string[] } };

async function pendingFor(side: Sidecar, jobId: string): Promise<Decision> {
  return until(`a Needs me card for ${jobId}`, async () => {
    const rows = await side.api<{ decisions: Decision[] }>("/api/decisions?status=pending");
    return rows.body.decisions.find((row) => row.sessionId === jobId) ?? null;
  });
}

const spec = (title: string, extra: Record<string, unknown> = {}) => ({
  task: { title },
  kind: "code",
  folderLabel: "source",
  delivery: "local",
  provider: "openai",
  model: "stub-model",
  instructions: title,
  ...extra,
});

test("remote tasks: pair, run, refuse a server overreach, disconnect, and do not re-run after quit", { timeout: 600_000 }, async (t) => {
  const root = makeTestDirectory("ensemble-remote-flow-");
  const stub = await startStubRuntime();
  const host = await startFakeHost({ leaseMs: 8_000, sweepMs: 300 });
  const source = makeSourceRepo(root);
  const main = git(source, "rev-parse", "HEAD");
  const extraEnv = {
    ENSEMBLE_REMOTE_API: host.origin,
    ENSEMBLE_REMOTE_HEARTBEAT_MS: "400",
    ENSEMBLE_REMOTE_POLL_MS: "300",
    ENSEMBLE_REMOTE_SYNC_MS: "200",
    ENSEMBLE_REMOTE_WAIT_MS: "1500",
  };
  let side = await bootSidecar(root, stub.url, extraEnv);
  t.after(async () => {
    await side.stop("SIGKILL");
    await host.close();
    await stub.close();
    rmSync(root, { recursive: true, force: true });
  });

  try {
    await prepareAccount(side);
    const shared = await side.api("/api/remote/folders", { json: { label: "source", path: source, kind: "repo", access: "read-write" } });
    assert.equal(shared.status, 200, JSON.stringify(shared.body));

    const before = await side.api<{ enabled: boolean; paired: boolean }>("/api/remote");
    assert.equal(before.body.enabled, false);
    assert.equal(before.body.paired, false);
    assert.equal((await cards(side)).some((row) => row.origin === "web"), false);

    const paired = await side.api<{ paired: boolean; enabled: boolean }>("/api/remote/pair", { json: { apiBase: host.origin, code: host.code } });
    assert.equal(paired.status, 200, JSON.stringify(paired.body));
    assert.equal(paired.body.paired, true);
    assert.equal(paired.body.enabled, false, "pairing does not turn the switch on");
    const heldBack = host.enqueue(spec("Unknown folder", { folderLabel: "not-shared" }));
    await sleep(1200);
    assert.equal(host.job(heldBack).status, "queued", "paired but off still claims nothing");
    assert.equal((await cards(side)).some((row) => row.origin === "web"), false);

    const enabled = await side.api<{ enabled: boolean; online: boolean }>("/api/remote", { method: "PUT", json: { enabled: true } });
    assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
    assert.equal(enabled.body.enabled, true);
    await until("the Mac shows online", async () => {
      const status = await side.api<{ online: boolean }>("/api/remote");
      return status.body.online ? status.body : null;
    });

    await until("the unknown folder is refused", async () => host.job(heldBack).complete);
    assert.equal(host.job(heldBack).complete?.outcome, "failed");
    assert.match(host.job(heldBack).complete?.summary ?? "", /has not shared a folder/);
    const refused = await waitJob(side, "Unknown folder", "web", ["failed"]);
    assert.equal(refused.origin, "web");

    const privateId = host.enqueue(spec("Private clone", { folderLabel: undefined, repoUrl: "git@github.com:acme/secret.git" }));
    await until("the private clone is refused", async () => host.job(privateId).complete);
    assert.match(host.job(privateId).complete?.summary ?? "", /desktop steps 2 and 4/);
    const privateJob = await waitJob(side, "Private clone", "web", ["failed"]);
    assert.match(privateJob.error ?? "", /desktop steps 2 and 4/);

    const editTitle = "[edit] Change the greeting";
    const editHosted = host.enqueue(spec(editTitle));
    const asking = await waitJob(side, editTitle, "web", ["waiting_approval"]);
    const question = await pendingFor(side, asking.id);
    assert.equal(question.event, "question");
    assert.deepEqual(question.detail.options, ["world", "there"]);
    const ask = await until("the hosted question", async () => host.asks().find((row) => row.jobId === editHosted));
    host.answer(ask.id, { decision: "allow", scope: "once", reason: "world", actionHash: ask.actionHash });
    const edited = await waitJob(side, editTitle, "web", ["succeeded"]);
    assert.equal(readFileSync(join(edited.folder, "hello.txt"), "utf8"), "hello, world\n");
    await until("the hosted edit completes", async () => host.job(editHosted).complete?.outcome === "succeeded");
    const posted = host.job(editHosted).events.map((event) => event.kind);
    assert.ok(posted.includes("tool"), posted.join(","));
    assert.equal(posted.some((kind) => kind === "needs_me" || kind === "interrupted"), false, posted.join(","));
    assert.ok(posted.every((kind) => kind === "prepared" || kind === "tool" || kind === "command"), posted.join(","));
    assert.equal(git(source, "show", "main:hello.txt"), "hello", "the source repository is not pushed");

    const rogueTitle = "[edit] Do not trust the server";
    const rogueHosted = host.enqueue(spec(rogueTitle));
    const rogueJob = await waitJob(side, rogueTitle, "web", ["waiting_approval"]);
    const rogueAsk = await until("the rogue question", async () => host.asks().find((row) => row.jobId === rogueHosted));
    host.rogue(rogueAsk.id, { id: "not-ours", status: "decided", decision: "allow", scope: "always", reason: "world", actionHash: rogueAsk.actionHash });
    await sleep(1500);
    const still = await pendingFor(side, rogueJob.id);
    assert.equal(still.toolName, "Question");
    assert.equal(readFileSync(join(rogueJob.folder, "hello.txt"), "utf8"), "hello\n");
    const trust = await side.api<{ folders: unknown[] }>("/api/workspace/trust");
    assert.deepEqual(trust.body.folders, []);
    assert.notEqual(host.job(rogueHosted).status, "succeeded");
    const stopped = await side.api(`/api/agent/jobs/${rogueJob.id}/stop`, { json: {} });
    assert.equal(stopped.status, 204);
    await waitJob(side, rogueTitle, "web", ["cancelled"]);

    const otherTitle = "[push-other] Push main";
    const otherHosted = host.enqueue(spec(otherTitle, { delivery: "push" }));
    const other = await waitJob(side, otherTitle, "web", ["succeeded"]);
    assert.equal(host.asks().some((row) => row.jobId === otherHosted), false, "a push to another branch is refused before the Mac asks");
    assert.equal(git(source, "rev-parse", "HEAD"), main);
    assert.throws(() => git(source, "rev-parse", "--verify", "--quiet", `refs/heads/${other.branch}`));

    const heldTitle = "[push-run] Needs the Mac";
    const heldHosted = host.enqueue(spec(heldTitle, { delivery: "push" }));
    const heldJob = await waitJob(side, heldTitle, "web", ["waiting_approval"]);
    const pushAsk = await until("the push question", async () => host.asks().find((row) => row.jobId === heldHosted));
    assert.equal(pushAsk.body.toolName, "git push");
    host.answer(pushAsk.id, { decision: "allow", scope: "once" });
    await sleep(1500);
    const pushCard = await pendingFor(side, heldJob.id);
    assert.equal(pushCard.toolName, "git push", "a phone allow does not push when the Mac had to ask");
    assert.throws(() => git(source, "rev-parse", "--verify", "--quiet", `refs/heads/${heldJob.branch}`));
    const denied = await side.api(`/api/decisions/${pushCard.id}/decide`, { json: { decision: "deny" } });
    assert.equal(denied.status, 200, JSON.stringify(denied.body));
    await waitJob(side, heldTitle, "web", ["succeeded"]);
    assert.throws(() => git(source, "rev-parse", "--verify", "--quiet", `refs/heads/${heldJob.branch}`));

    const pushOn = await side.api<{ runBranchPush: boolean }>("/api/remote", { method: "PUT", json: { runBranchPush: true } });
    assert.equal(pushOn.body.runBranchPush, true);
    const allowTitle = "[push-run] Own branch";
    const allowHosted = host.enqueue(spec(allowTitle, { delivery: "push" }));
    const allowJob = await waitJob(side, allowTitle, "web", ["succeeded"]);
    assert.equal(host.asks().some((row) => row.jobId === allowHosted), false, "the Mac's own run-branch setting pushes without asking");
    assert.equal(git(source, "rev-parse", `refs/heads/${allowJob.branch}`), git(allowJob.folder, "rev-parse", "HEAD"));
    await side.api("/api/remote", { method: "PUT", json: { runBranchPush: false } });

    const remoteSlow = "[slow] Remote revoke";
    const localSlow = "[slow] Local keeps going";
    const remoteHosted = host.enqueue(spec(remoteSlow));
    await until("the remote slow job starts", async () => (stub.calls.get(remoteSlow) ?? 0) > 0);
    const created = await side.api<{ task: { id: string } }>("/api/tasks", { json: { title: localSlow } });
    assert.equal(created.status, 201);
    const assigned = await side.api<{ jobId: string }>("/api/agent/assign", {
      json: { taskId: created.body.task.id, kind: "code", provider: "openai", model: "stub-model", repoUrl: source, delivery: "local" },
    });
    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
    await until("the local slow job starts", async () => (stub.calls.get(localSlow) ?? 0) > 0);
    const remoteCalls = stub.calls.get(remoteSlow);
    host.revoke();
    await until("removed from the web", async () => {
      const status = await side.api<{ enabled: boolean; paired: boolean; disconnected: { reason: string } | null }>("/api/remote");
      const body = status.body;
      return body.disconnected?.reason === "Removed from Ensemble on the web. Pair again to keep running remote tasks." && body.enabled === false && body.paired === false ? body : null;
    });
    await waitJob(side, remoteSlow, "web", ["interrupted"]);
    await until("the hosted lease expires", async () => host.job(remoteHosted).status === "interrupted", 20_000);
    const localCard = findCard(await cards(side), localSlow, "local");
    assert.equal(localCard?.status, "running", "a job started on this Mac keeps running after the device token is revoked");
    assert.equal(stub.calls.get(remoteSlow), remoteCalls, "a revoked remote task is not started again");

    const repaired = await side.api<{ paired: boolean; enabled: boolean }>("/api/remote/pair", { json: { apiBase: host.origin, code: host.code } });
    assert.equal(repaired.status, 200, JSON.stringify(repaired.body));
    assert.equal(repaired.body.enabled, false);
    const on = await side.api<{ enabled: boolean }>("/api/remote", { method: "PUT", json: { enabled: true, runBranchPush: false } });
    assert.equal(on.body.enabled, true);
    const quitTitle = "[slow] Remote quit";
    const quitHosted = host.enqueue(spec(quitTitle));
    await until("the quit job starts", async () => (stub.calls.get(quitTitle) ?? 0) > 0);
    const quitCalls = stub.calls.get(quitTitle);
    await side.stop("SIGTERM");
    await until("the lease expires while the app is quit", async () => host.job(quitHosted).status === "interrupted", 20_000);
    side = await bootSidecar(root, stub.url, extraEnv);
    await sleep(4000);
    assert.equal(stub.calls.get(quitTitle), quitCalls, "quit does not re-run the task");
    assert.equal(host.job(quitHosted).status, "interrupted");
    const quitCards = (await cards(side)).filter((row) => row.title === quitTitle);
    assert.equal(quitCards.length, 1);
    assert.equal(quitCards[0]?.status, "interrupted");
  } catch (error) {
    console.error(side.logs().slice(-8000));
    throw error;
  }
});

test("a claim with networkAccess still runs on this Mac's network setting", { timeout: 180_000 }, async (t) => {
  const root = makeTestDirectory("ensemble-remote-net-");
  const stub = await startStubRuntime();
  const host = await startFakeHost();
  const source = makeSourceRepo(root);
  const side = await bootSidecar(root, stub.url, {
    ENSEMBLE_REMOTE_API: host.origin,
    ENSEMBLE_REMOTE_HEARTBEAT_MS: "400",
    ENSEMBLE_REMOTE_POLL_MS: "300",
    ENSEMBLE_REMOTE_SYNC_MS: "200",
  });
  t.after(async () => {
    await side.stop("SIGKILL");
    await host.close();
    await stub.close();
    rmSync(root, { recursive: true, force: true });
  });

  try {
    await prepareAccount(side);
    const shared = await side.api("/api/remote/folders", { json: { label: "source", path: source, kind: "repo", access: "read-write" } });
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    const networkOff = await side.api("/api/settings", { method: "PATCH", json: { orchestration: { sandboxNetwork: false } } });
    assert.equal(networkOff.status, 200, JSON.stringify(networkOff.body));
    const paired = await side.api("/api/remote/pair", { json: { apiBase: host.origin, code: host.code } });
    assert.equal(paired.status, 200, JSON.stringify(paired.body));
    const enabled = await side.api("/api/remote", { method: "PUT", json: { enabled: true } });
    assert.equal(enabled.status, 200, JSON.stringify(enabled.body));

    const title = "[net] No network";
    const hosted = host.enqueue(spec(title, { networkAccess: true }));
    const card = await waitJob(side, title, "web", ["succeeded"]);
    const detail = await side.api<{ job: { networkAccess: boolean }; events: Array<{ kind: string; data: { summary?: string } }> }>(`/api/agent/jobs/${card.id}`);
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.job.networkAccess, false);
    assert.ok(
      detail.body.events.some((event) => event.kind === "tool" && /needs network access, which is off/.test(event.data?.summary ?? "")),
      JSON.stringify(detail.body.events),
    );
    await until("the hosted job completes without network", async () => host.job(hosted).complete?.outcome === "succeeded");
  } catch (error) {
    console.error(side.logs().slice(-8000));
    throw error;
  }
});

test("a closed event stream that 401s on reconnect, a 403, or a device.revoked frame stops remote work", { timeout: 180_000 }, async (t) => {
  const root = makeTestDirectory("ensemble-remote-revoke-");
  const stub = await startStubRuntime();
  const host = await startFakeHost({ leaseMs: 120_000, sweepMs: 5_000 });
  const source = makeSourceRepo(root);
  const side = await bootSidecar(root, stub.url, {
    ENSEMBLE_REMOTE_API: host.origin,
    // Longer than the stop we assert, so a pass cannot be the old heartbeat wait.
    ENSEMBLE_REMOTE_HEARTBEAT_MS: "30000",
    ENSEMBLE_REMOTE_POLL_MS: "30000",
    ENSEMBLE_REMOTE_SYNC_MS: "200",
  });
  t.after(async () => {
    await side.stop("SIGKILL");
    await host.close();
    await stub.close();
    rmSync(root, { recursive: true, force: true });
  });

  const stopWithinMs = 8_000;
  const removedReason = "Removed from Ensemble on the web. Pair again to keep running remote tasks.";
  const rejectedReason = "This Mac's token was rejected. Pair again to keep running remote tasks.";
  const switchedOffReason = "Remote tasks were switched off on this Mac. Turn them on here when you want them again.";
  const unreachableReason = "Ensemble on the web could not be reached. Check the address. This Mac will keep trying.";
    const stopped = async (reason: string) => {
    const started = Date.now();
    await until(
      reason,
      async () => {
        const status = await side.api<{ enabled: boolean; paired: boolean; disconnected: { reason: string } | null }>("/api/remote");
        const row = status.body;
        return row.disconnected?.reason === reason && row.enabled === false && row.paired === false ? row : null;
      },
      stopWithinMs,
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < stopWithinMs, `still working ${elapsed}ms after the web rejected this computer`);
    return elapsed;
  };
  const enable = async () => {
    const paired = await side.api("/api/remote/pair", { json: { apiBase: host.origin, code: host.code } });
    assert.equal(paired.status, 200, JSON.stringify(paired.body));
    const on = await side.api("/api/remote", { method: "PUT", json: { enabled: true } });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    await until("the event stream", async () => (host.streaming ? true : null));
  };
  const startRemote = async (title: string) => {
    host.enqueue(spec(title));
    await until(`${title} starts`, async () => ((stub.calls.get(title) ?? 0) > 0 ? true : null));
    return stub.calls.get(title) ?? 0;
  };

  try {
    await prepareAccount(side);
    const shared = await side.api("/api/remote/folders", { json: { label: "source", path: source, kind: "repo", access: "read-write" } });
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    await enable();

    const localSlow = "[slow] Local keeps going";
    const created = await side.api<{ task: { id: string } }>("/api/tasks", { json: { title: localSlow } });
    assert.equal(created.status, 201);
    const assigned = await side.api("/api/agent/assign", {
      json: { taskId: created.body.task.id, kind: "code", provider: "openai", model: "stub-model", repoUrl: source, delivery: "local" },
    });
    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
    await until("the local slow job starts", async () => ((stub.calls.get(localSlow) ?? 0) > 0 ? true : null));

    const removed = "[slow] Remote device removed";
    const removedCalls = await startRemote(removed);
    await until("the event stream is up", async () => (host.streaming ? true : null));
    host.emit("device.revoked", { deviceId: host.deviceId, reason: "revoked" });
    await stopped(removedReason);
    await waitJob(side, removed, "web", ["interrupted"]);
    assert.equal(stub.calls.get(removed), removedCalls, "a removed remote task is not started again");
    assert.equal(findCard(await cards(side), localSlow, "local")?.status, "running");

    await enable();
    const rejected = "[slow] Remote token rejected";
    const rejectedCalls = await startRemote(rejected);
    host.rejectScope();
    host.closeStream();
    await stopped(rejectedReason);
    await waitJob(side, rejected, "web", ["interrupted"]);
    assert.equal(stub.calls.get(rejected), rejectedCalls);
    assert.equal(findCard(await cards(side), localSlow, "local")?.status, "running");

    await enable();
    const revoked = "[slow] Remote revoked";
    const revokedCalls = await startRemote(revoked);
    const revokeStarted = Date.now();
    host.revoke();
    const revokeMs = await stopped(removedReason);
    console.log(`revoke via device.revoked then stream close: ${Date.now() - revokeStarted}ms (status ${revokeMs}ms)`);
    await waitJob(side, revoked, "web", ["interrupted"]);
    assert.equal(stub.calls.get(revoked), revokedCalls);
    assert.equal(findCard(await cards(side), localSlow, "local")?.status, "running", "a job started on this Mac keeps running");

    await enable();
    const closed = "[slow] Stream closed then 401";
    const closedCalls = await startRemote(closed);
    const refusals = host.unauthorizedEvents;
    host.closeThenUnauthorized();
    await stopped(removedReason);
    assert.ok(host.unauthorizedEvents > refusals, "the reconnect after the stream closed was a 401");
    await waitJob(side, closed, "web", ["interrupted"]);
    assert.equal(stub.calls.get(closed), closedCalls, "a 401 after the stream closes does not start the task again");
    assert.equal(findCard(await cards(side), localSlow, "local")?.status, "running");

    await enable();
    const switched = "[slow] Remote switched off";
    const switchedCalls = await startRemote(switched);
    const off = await side.api<{ enabled: boolean; paired: boolean; disconnected: { reason: string } | null }>("/api/remote", { method: "PUT", json: { enabled: false } });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(off.body.enabled, false);
    assert.equal(off.body.paired, true, "switching off here keeps the pairing");
    assert.equal(off.body.disconnected?.reason, switchedOffReason);
    await waitJob(side, switched, "web", ["interrupted"]);
    assert.equal(stub.calls.get(switched), switchedCalls);
    assert.equal(findCard(await cards(side), localSlow, "local")?.status, "running");

    const back = await side.api<{ enabled: boolean; disconnected: { reason: string } | null; unreachable: string | null }>("/api/remote", { method: "PUT", json: { enabled: true } });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal(back.body.enabled, true);
    assert.equal(back.body.disconnected, null);
    await until("the event stream returns", async () => (host.streaming ? true : null));
    const offlineTitle = "[slow] Remote while the web is down";
    const offlineCalls = await startRemote(offlineTitle);
    await host.close();
    await until("the web is unreachable", async () => {
      const status = await side.api<{ enabled: boolean; paired: boolean; disconnected: { reason: string } | null; unreachable: string | null }>("/api/remote");
      const row = status.body;
      return row.unreachable === unreachableReason && row.enabled && row.paired && !row.disconnected ? row : null;
    });
    await sleep(1000);
    assert.equal(findCard(await cards(side), offlineTitle, "web")?.status, "running", "a blip does not stop the remote job");
    assert.equal(stub.calls.get(offlineTitle), offlineCalls);
    assert.equal(findCard(await cards(side), localSlow, "local")?.status, "running");
  } catch (error) {
    console.error(side.logs().slice(-8000));
    throw error;
  }
});
