/**
 * The device loop (doc 25 §3–§5). It runs inside the desktop sidecar, claims
 * hosted jobs, and lets the local queue run them. A dropped network is
 * retried and the pairing stays. A 401 or 403 on claim, progress, events,
 * ask, or decision stops at once, including when the server closes the event
 * stream and the reconnect is refused. A revoke frame does the same. Claim
 * runs when a job.queued frame arrives, on the heartbeat, and on the poll
 * fallback while the stream is down.
 * Quit and sleep do not start a job again.
 */
import type { FastifyInstance } from "fastify";
import type { WorkspaceJob } from "@prisma/client";
import { env } from "../config.js";
import { appendLedger } from "../lib/ledger.js";
import { loadSettings as loadHubSettings } from "../lib/settings.js";
import { applyAnswer } from "../routes/decisions.js";
import { capabilities } from "../workspace/sandbox/spawn.js";
import { liveLogSince } from "../workspace/live-log.js";
import { interruptJob, stopJob, whenQueueReady } from "../workspace/worker.js";
import { acceptClaimed, resultLinks } from "./accept.js";
import { authRejected, deviceRemovedEvent, hostedClient, remoteApiBase, RemoteError, type HostedClient } from "./client.js";
import { deviceOwnedEvents, LOG_CHUNK_BYTES, LOG_JOB_BYTES, ONLINE_WINDOW_MS, parseAnswer, parseClaim, timing } from "./contract.js";
import { actionHash, decisionOptions, judgeAnswer, publishedFolders, scrubOutgoing, type LocalDecision } from "./policy.js";
import { dropDeviceToken, loadHeld, loadSettings, readDeviceToken, saveHeld, updateSettings, type HeldJob, type RemoteSettings } from "./store.js";

const userId = () => env.ENSEMBLE_DEV_USER_ID;

/** Shown on This Mac, with the next step in the same sentence. */
export const REMOTE_NOTICE = {
  removed: "Removed from Ensemble on the web. Pair again to keep running remote tasks.",
  rejected: "This Mac's token was rejected. Pair again to keep running remote tasks.",
  unreachable: "Ensemble on the web could not be reached. Check the address. This Mac will keep trying.",
  switchedOff: "Remote tasks were switched off on this Mac. Turn them on here when you want them again.",
} as const;
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "interrupted", "blocked"]);

let jobs: Record<string, HeldJob> | null = null;
let lastHeartbeatAt = 0;
let currentSession: AbortController | null = null;
let onFatal: (error: unknown) => void = () => {};
const watching = new Set<string>();

/** The settings changed. The open connection starts again and reads them. */
export function wakeRemote(): void {
  currentSession?.abort();
}

function held(): Record<string, HeldJob> {
  if (!jobs) jobs = loadHeld();
  return jobs;
}

function persist(): void {
  if (jobs) saveHeld(jobs);
}

export function remotePresence(): { online: boolean; lastHeartbeatAt: number } {
  const settings = loadSettings();
  const fresh = settings.enabled && !settings.disconnected && Date.now() - lastHeartbeatAt < ONLINE_WINDOW_MS;
  return { online: fresh && lastHeartbeatAt > 0, lastHeartbeatAt };
}

function activeBase(settings: RemoteSettings): string | null {
  return remoteApiBase() ?? settings.apiBase;
}

export function devicePlatform(): "macos" | "linux" | "windows" {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}

export async function deviceCapabilities(app: FastifyInstance): Promise<Record<string, unknown>> {
  const settings = loadSettings();
  const hub = await loadHubSettings(app.prisma, userId()).catch(() => null);
  return {
    folders: publishedFolders(settings),
    sandbox: capabilities().strength,
    maxConcurrent: hub?.orchestration.maxConcurrentJobs ?? null,
    // The web shows this as a locked pill. Only this Mac can change it.
    runBranchPush: settings.runBranchPush,
  };
}

/**
 * Stop every remote-originated local job. Locally assigned jobs are not in
 * `held`, so they keep running. `report` tells the hosted row when the token
 * still works; a 401 cannot.
 */
export async function stopRemoteWork(app: FastifyInstance, message: string, report: "cancelled" | "none"): Promise<void> {
  const current = held();
  const settings = loadSettings();
  const token = report === "cancelled" ? await readDeviceToken() : null;
  const base = activeBase(settings);
  const client = token && base ? hostedClient(base, token) : null;
  for (const job of Object.values(current)) {
    if (job.phase === "done") continue;
    if (client) {
      await client
        .complete(job.hostedId, job.leaseToken, { outcome: "cancelled", summary: message, results: [] })
        .catch(() => undefined);
    }
    if (job.localJobId) await interruptJob(app, job.localJobId, message).catch(() => undefined);
    job.phase = "done";
  }
  persist();
}

export function startRemote(app: FastifyInstance): () => Promise<void> {
  const abort = new AbortController();
  const done = run(app, abort.signal);
  return async () => {
    abort.abort();
    await done.catch(() => undefined);
  };
}

async function run(app: FastifyInstance, signal: AbortSignal): Promise<void> {
  await whenQueueReady().catch(() => undefined);
  if (signal.aborted) return;
  while (!signal.aborted) {
    const settings = loadSettings();
    const token = await readDeviceToken();
    const base = activeBase(settings);
    if (!settings.enabled || settings.disconnected || !token || !base) {
      await sleep(400, signal);
      continue;
    }
    try {
      await session(app, base, token, signal);
    } catch (error) {
      if (signal.aborted) return;
      if (authRejected(error)) {
        await disconnect(app, error.status === 403 ? "rejected" : "removed");
        continue;
      }
      if (error instanceof RemoteError && error.status === 0) noteUnreachable();
      app.log.warn({ err: error }, "remote task connection dropped; retrying");
      await sleep(1500, signal);
    }
  }
}

async function disconnect(app: FastifyInstance, kind: "removed" | "rejected"): Promise<void> {
  const reason = kind === "rejected" ? REMOTE_NOTICE.rejected : REMOTE_NOTICE.removed;
  await stopRemoteWork(app, reason, "none");
  await dropDeviceToken();
  updateSettings({
    enabled: false,
    runBranchPush: loadSettings().runBranchPush,
    disconnected: { at: new Date().toISOString(), reason },
    unreachable: null,
  });
  lastHeartbeatAt = 0;
  await appendLedger({ userId: userId(), actor: "system", action: "remote.revoke", payload: { kind } }).catch(() => undefined);
  app.log.warn({ kind }, "remote tasks disconnected");
}

function noteUnreachable(): void {
  if (loadSettings().unreachable === REMOTE_NOTICE.unreachable) return;
  updateSettings({ unreachable: REMOTE_NOTICE.unreachable });
}

async function session(app: FastifyInstance, base: string, token: string, parent: AbortSignal): Promise<void> {
  if (parent.aborted) return;
  const abort = new AbortController();
  currentSession = abort;
  const stopParent = () => abort.abort();
  parent.addEventListener("abort", stopParent, { once: true });
  const signal = abort.signal;
  const client = hostedClient(base, token);
  let fatal: RemoteError | null = null;
  const fail = (error: unknown) => {
    if (authRejected(error)) {
      fatal = error;
      abort.abort();
      return;
    }
    if (error instanceof RemoteError && error.status === 0) noteUnreachable();
    if (signal.aborted) return;
    app.log.warn({ err: error }, "remote task sync failed");
  };
  onFatal = fail;
  await reportInterrupted(app, client);
  let claiming = false;
  const claim = async () => {
    if (claiming || signal.aborted) return;
    claiming = true;
    try {
      for (;;) {
        if (signal.aborted || !loadSettings().enabled) return;
        const res = await client.claim();
        if (res.status === 204) return;
        if (res.status >= 400) throw new RemoteError(res.status, "The claim was refused.");
        const spec = parseClaim(res.body);
        if (held()[spec.id]) return;
        held()[spec.id] = await acceptClaimed(app, client, spec);
        persist();
      }
    } finally {
      claiming = false;
    }
  };
  let streamUp = false;
  const heartbeat = setInterval(() => void beat(app, client, signal).catch(fail), timing().heartbeatMs);
  // Log batches only. Claim is not on this timer: a 2s claim poll would burn the hosted command budget.
  const sync = setInterval(() => void mirror(app, client, signal).catch(fail), timing().syncMs);
  // Fallback while the event stream is down. The shipped cadence is 15s, not the 2s log sync.
  const poll = setInterval(() => {
    if (!streamUp) void claim().catch(fail);
  }, timing().pollMs);
  try {
    await beat(app, client, signal);
    await claim();
    await mirror(app, client, signal);
    streamUp = true;
    try {
      const onFrame = (event: string, data: unknown) => {
        // device.revoked {deviceId, reason: "revoked"} is removal, before the 401 on reconnect.
        if (deviceRemovedEvent(event)) {
          fail(new RemoteError(401, "This computer is no longer paired."));
          return;
        }
        if (event === "job.cancel") {
          const id = typeof data === "object" && data !== null && typeof (data as { id?: unknown }).id === "string" ? (data as { id: string }).id : "";
          const local = id ? held()[id]?.localJobId : undefined;
          if (local) void stopJob(app, userId(), local).catch(fail);
        }
        if (event === "job.queued" || event === "job.cancel") void claim().catch(fail);
      };
      // The server ends this stream on revoke and answers the next open with
      // 401 or 403. Reconnect immediately so that refusal is not left until
      // the heartbeat. A second clean close leaves the session; the outer
      // loop opens it again.
      let reopened = false;
      while (!signal.aborted && !fatal) {
        await client.events(onFrame, signal);
        if (signal.aborted || fatal) break;
        if (reopened) break;
        reopened = true;
      }
    } finally {
      streamUp = false;
    }
    if (fatal) throw fatal;
  } finally {
    clearInterval(heartbeat);
    clearInterval(sync);
    clearInterval(poll);
    parent.removeEventListener("abort", stopParent);
    if (currentSession === abort) currentSession = null;
  }
}

async function beat(app: FastifyInstance, client: HostedClient, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const settings = loadSettings();
  if (!settings.enabled || settings.disconnected) {
    await stopRemoteWork(app, REMOTE_NOTICE.switchedOff, "cancelled");
    currentSession?.abort();
    return;
  }
  const runningJobIds = Object.values(held())
    .filter((job) => job.phase === "active")
    .map((job) => job.hostedId);
  const reply = await client.heartbeat({
    runningJobIds,
    appVersion: process.env.ENSEMBLE_APP_VERSION ?? "0.1.0",
    capabilities: await deviceCapabilities(app),
  });
  lastHeartbeatAt = Date.now();
  if (loadSettings().unreachable) updateSettings({ unreachable: null });
  for (const id of reply.cancel) {
    const local = held()[id]?.localJobId;
    if (local) await stopJob(app, userId(), local);
  }
}

/** After a quit, the local row is interrupted and is not started again. The hosted row becomes interrupted when its lease expires. */
async function reportInterrupted(app: FastifyInstance, client: HostedClient): Promise<void> {
  for (const job of Object.values(held())) {
    if (job.phase === "done" || !job.localJobId) continue;
    const local = await app.prisma.workspaceJob.findUnique({ where: { id: job.localJobId } });
    if (!local || !TERMINAL.has(local.status)) continue;
    await finish(client, job, local);
  }
  persist();
}

async function mirror(app: FastifyInstance, client: HostedClient, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  for (const job of Object.values(held())) {
    if (job.phase !== "active" || !job.localJobId || signal.aborted) continue;
    const local = await app.prisma.workspaceJob.findUnique({ where: { id: job.localJobId } });
    if (!local) continue;
    if (TERMINAL.has(local.status)) {
      // Send the last events and log text first. A job that ends between two syncs would otherwise post none of them.
      if (local.status !== "interrupted") await sendProgress(app, client, job, local, true);
      await finish(client, job, local);
      continue;
    }
    await relayDecisions(app, client, job, local, signal);
    await sendProgress(app, client, job, local);
  }
  persist();
}

async function relayDecisions(app: FastifyInstance, client: HostedClient, job: HeldJob, local: WorkspaceJob, signal: AbortSignal): Promise<void> {
  const pending = await app.prisma.agentDecision.findMany({ where: { sessionId: local.id, status: "pending" }, orderBy: { requestedAt: "asc" } });
  for (const row of pending) {
    const decision = row as unknown as LocalDecision;
    const known = job.decisions[row.id];
    if (known?.settled) continue;
    if (!known) {
      const risk = row.toolName === "git push" || row.toolName === "outside" || decisionOptions(decision).some((option) => /trust/i.test(option)) ? "high" : "ordinary";
      const hash = actionHash(decision);
      const command = typeof (row.detail as { command?: unknown }).command === "string" ? scrubOutgoing((row.detail as { command: string }).command).slice(0, 2000) : "";
      const options = decisionOptions(decision).slice(0, 12).map((option) => scrubOutgoing(option).slice(0, 200)).filter(Boolean);
      const title = scrubOutgoing(row.title).slice(0, 300) || "Needs you";
      const asked = await client.ask(job.hostedId, job.leaseToken, {
        title,
        event: row.event === "permission" ? "permission" : "question",
        ...(row.toolName ? { toolName: row.toolName.slice(0, 80) } : {}),
        ...(command ? { command } : {}),
        ...(options.length ? { options } : {}),
        // A push the Mac still has to ask about is high_risk, so a phone Yes is not offered.
        // run_branch_push is not sent: that tier shows a Yes the Mac would refuse.
        tier: risk === "high" ? "high_risk" : "ordinary",
      });
      job.decisions[row.id] = { hostedId: asked.decisionId, hash, risk, settled: false };
      persist();
    }
    const mirror = job.decisions[row.id];
    if (!mirror || watching.has(row.id)) continue;
    watching.add(row.id);
    void followAnswer(app, client, job, row.id, signal)
      .catch((error: unknown) => onFatal(error))
      .finally(() => watching.delete(row.id));
  }
}

async function followAnswer(app: FastifyInstance, client: HostedClient, job: HeldJob, localId: string, signal: AbortSignal): Promise<void> {
  const mirror = job.decisions[localId];
  if (!mirror) return;
  while (!signal.aborted && !mirror.settled && job.phase === "active") {
    const local = await app.prisma.agentDecision.findFirst({ where: { id: localId, userId: userId() } });
    if (!local || local.status !== "pending") {
      mirror.settled = true;
      persist();
      return;
    }
    let body: unknown;
    try {
      body = await client.decision(mirror.hostedId, timing().waitSeconds, signal);
    } catch (error) {
      if (signal.aborted) return;
      if (authRejected(error) || (error instanceof RemoteError && (error.status === 409 || error.status === 404))) {
        if (authRejected(error)) throw error;
        mirror.settled = true;
        persist();
        return;
      }
      await sleep(1000, signal);
      continue;
    }
    const verdict = judgeAnswer({
      askedId: mirror.hostedId,
      hash: mirror.hash,
      risk: mirror.risk,
      local: local as unknown as LocalDecision,
      answer: parseAnswer(body),
    });
    if (verdict.kind === "wait") continue;
    mirror.settled = true;
    persist();
    if (verdict.kind === "apply") {
      await applyAnswer(app, userId(), localId, { decision: verdict.decision, scope: "once", reason: verdict.reason ?? undefined }, "system").catch(() => undefined);
    } else if (verdict.kind === "refuse") {
      await appendLedger({
        userId: userId(),
        actor: "system",
        action: "remote.refuse",
        payload: { hostedJobId: job.hostedId, decisionId: localId, why: verdict.why },
      });
    }
    return;
  }
}

async function sendProgress(app: FastifyInstance, client: HostedClient, job: HeldJob, local: WorkspaceJob, last = false): Promise<void> {
  // The device route accepts only "running". waiting_approval is set by ask, and sending it is a 400.
  // On the last send, a job that ended before any sync still reports that it ran.
  const status = local.status === "running" || (last && job.sentStatus !== "running") ? "running" : null;
  const progress = scrubOutgoing(local.progress ?? "").slice(0, 200);
  const events = await unreadEvents(app, job, local.id);
  const logs = takeLog(job, local.id);
  const changed = status !== job.sentStatus || progress !== job.sentProgress || events.rows.length > 0 || Boolean(logs);
  if (!changed && (last || Date.now() - job.sentAt < timing().heartbeatMs)) return;
  await client.progress(job.hostedId, job.leaseToken, {
    ...(status ? { status } : {}),
    progress,
    events: events.rows,
    ...(logs ? { logs: { seqFrom: logs.seqFrom, seqTo: logs.seqTo, text: logs.text } } : {}),
  });
  job.eventSeq = events.last;
  job.sentStatus = status;
  job.sentProgress = progress;
  job.sentAt = Date.now();
  job.lastOkAt = Date.now();
  if (logs) {
    job.logOffset = logs.end;
    job.logBytes += Buffer.byteLength(logs.text);
    job.logSeq += 1;
  }
}

async function unreadEvents(app: FastifyInstance, job: HeldJob, localId: string): Promise<{ last: string; rows: Array<{ kind: string; data?: Record<string, unknown> }> }> {
  const rows = await app.prisma.workspaceEvent.findMany({ where: { jobId: localId }, orderBy: { sequence: "asc" }, take: 300 });
  const fresh: Array<{ kind: string; data?: Record<string, unknown> }> = [];
  let last = job.eventSeq;
  for (const row of rows) {
    const seq = row.sequence.toString();
    if (BigInt(seq) <= BigInt(job.eventSeq)) continue;
    last = seq;
    fresh.push(hostedEvent(row.kind, row.data));
  }
  return { last, rows: deviceOwnedEvents(fresh) };
}

/** Event data is a record. Anything else is wrapped so the route accepts it. */
function hostedEvent(kind: string, data: unknown): { kind: string; data?: Record<string, unknown> } {
  const name = kind.slice(0, 40);
  const scrubbed = scrubData(data);
  if (scrubbed === null || scrubbed === undefined) return { kind: name };
  if (typeof scrubbed === "object" && !Array.isArray(scrubbed)) return { kind: name, data: scrubbed as Record<string, unknown> };
  return { kind: name, data: { value: scrubbed } };
}

function takeLog(job: HeldJob, localId: string): { seqFrom: number; seqTo: number; text: string; end: number } | null {
  if (job.logBytes >= LOG_JOB_BYTES) return null;
  const slice = liveLogSince(localId, job.logOffset);
  if (!slice.text) return null;
  const room = Math.min(LOG_CHUNK_BYTES, LOG_JOB_BYTES - job.logBytes);
  const cut = sliceBytes(slice.text, room);
  const hitCap = job.logBytes + Buffer.byteLength(cut) >= LOG_JOB_BYTES;
  const text = sliceBytes(scrubOutgoing(cut) + (hitCap ? "\nlog truncated\n" : ""), LOG_CHUNK_BYTES);
  if (!text.trim()) return null;
  return { seqFrom: job.logSeq, seqTo: job.logSeq + 1, text, end: slice.from + cut.length };
}

function sliceBytes(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid)) <= max) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low);
}

function scrubData(data: unknown): unknown {
  if (typeof data === "string") return scrubOutgoing(data).slice(0, 2000);
  if (Array.isArray(data)) return data.slice(0, 20).map(scrubData);
  if (typeof data === "object" && data !== null) {
    return Object.fromEntries(Object.entries(data as Record<string, unknown>).slice(0, 20).map(([key, value]) => [key, scrubData(value)]));
  }
  return data;
}

async function finish(client: HostedClient, job: HeldJob, local: WorkspaceJob): Promise<void> {
  // The server sets interrupted when the lease expires. Posting that outcome is a 400.
  if (local.status === "interrupted") {
    job.phase = "done";
    return;
  }
  const outcome = local.status === "succeeded" ? "succeeded" : local.status === "cancelled" ? "cancelled" : local.status === "blocked" ? "blocked" : "failed";
  const summary = scrubOutgoing(local.summary || local.error || "").slice(0, 4000);
  try {
    await client.complete(job.hostedId, job.leaseToken, { outcome, summary, results: resultLinks(local) });
  } catch (error) {
    if (authRejected(error)) throw error;
    if (!(error instanceof RemoteError) || (error.status !== 409 && error.status !== 410 && error.status !== 404)) throw error;
  }
  job.phase = "done";
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
