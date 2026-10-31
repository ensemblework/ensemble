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
import { prisma } from "../lib/prisma.js";
import { loadSettings as loadHubSettings } from "../lib/settings.js";
import { applyAnswer } from "../routes/decisions.js";
import { capabilities } from "../workspace/sandbox/spawn.js";
import { liveLogSince } from "../workspace/live-log.js";
import { interruptJob, stopJob, whenQueueReady } from "../workspace/worker.js";
import { INTERRUPTED_MESSAGE } from "../workspace/lifecycle.js";
import { workspaceRoot } from "../workspace/guard.js";
import { removeWorktrees } from "../workspace/worktrees.js";
import { acceptClaimed, resultLinks } from "./accept.js";
import { authRejected, deviceRemovedEvent, hostedClient, remoteApiBase, RemoteError, type HostedClient } from "./client.js";
import { sliceBytes } from "../lib/text.js";
import { answerCodeRequest } from "./code.js";
import { answerSecretSave, SECRETS_API } from "./secrets.js";
import { credentialCapabilities } from "../credentials/capabilities.js";
import { answerFileRequest, uploadChangedFiles } from "./files.js";
import { answerTerminalRequest, stopWebTerminal } from "./terminal.js";
import { answerAssistantTurn, stopAllAssistantTurns, stopAssistantTurn } from "./assistant.js";
import { answerNodeToolRequest } from "../device-tools/answer.js";
import { stopNodeCommands } from "../device-tools/run.js";
import { sendEvidence } from "../evidence/upload.js";
import { answerEvidenceRequest } from "../evidence/requests.js";
import { setLiveSink } from "./live.js";
import { setRunLoginSink } from "../logins/run.js";
import { setLoginStateSink } from "../logins/requests.js";
import { answerLoginResolve } from "../logins/answer.js";
import { answerTakeoverControl, answerTakeoverEnd, answerTakeoverStart, endAllTakeovers, takeoverExtend, takeoverInput } from "../takeover/session.js";
import { parseReport } from "../node/report.js";
import { ASSISTANT_TURNS_API, CODE_ENGINES, SUBSCRIPTION_PROVIDERS, type SubscriptionAgent, type SubscriptionProvider } from "@ensemble/shared-types";
import { cachedAgents, detectAgents } from "../subscriptions/detect.js";
import { startSignIn } from "../subscriptions/signin.js";
import { BROWSER_API, CLI_LOGINS_API, CODE_API, deviceOwnedEvents, LIVE_API, LOGINS_API, TAKEOVER_API, LEGACY_SUMMARY_CHARS, LOG_CHUNK_BYTES, LOG_JOB_BYTES, MAX_UPLOADED_STEPS, missionOf, NODE_FILES_API, NODE_TOOLS_API, ONLINE_WINDOW_MS, parseAnswer, parseClaim, STEP_POST_BYTES, timing, type ObservedSettings, type RunTotals, type UploadedStep } from "./contract.js";
import { anyObserved, observedFromEvents, sameObserved } from "../workspace/engines/observed.js";
import { actionHash, decisionOptions, judgeAnswer, publishedFolders, riskOf, scrubOutgoing, type LocalDecision } from "./policy.js";
import { dropDeviceToken, installId, loadHeld, loadSettings, readDeviceToken, saveHeld, updateSettings, type HeldJob, type RemoteSettings } from "./store.js";
import { launcherRemoved } from "./installed.js";

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
    // What the web's Assign dialog shows for this computer's sandbox. Never a path.
    sandboxInfo: (() => {
      const caps = capabilities();
      return { mechanism: caps.mechanism, osSandbox: caps.osSandbox, networkOff: caps.networkOff ?? false, setupNeeded: Boolean(caps.setup?.needed), reason: caps.reason.slice(0, 300) };
    })(),
    maxConcurrent: hub?.orchestration.maxConcurrentJobs ?? null,
    acceptWebApprovals: settings.acceptWebApprovals,
    // The web offers the task's files only when this computer shows them (protocol 3).
    browseFiles: settings.browseFiles,
    // The web's Code tab and terminal work here (protocol 4); each switch is this computer's.
    code: true,
    codeApi: CODE_API,
    webEdit: settings.webEdit,
    webTerminal: settings.webTerminal,
    // The person's own AI subscriptions here, for the assistant on the web (docs/30 §8).
    assistantTurns: ASSISTANT_TURNS_API,
    agents: await agentsNow(),
    // Coding agents this runtime can run a code task with; the web refuses others for this computer.
    engines: [...CODE_ENGINES],
    // Runs here can end in a pull request into any branch, and take any branch or git choice from the web (docs/24 §5.1).
    pullRequests: 2,
    // Secrets typed on the web are kept here for this computer's agent runs (docs/35 §8.7).
    secrets: SECRETS_API,
    // The same installation after it is paired again: the web finds this computer's earlier runs here (devices/successor.ts).
    installId: installId(),
    // Reconnect and carry-on after an outage (docs/25 §3): reattach a run that kept going, resume one that was cut off.
    recovery: 1,
    // A run that continues another goes on in the agent's own session, and takes a steer (Ensemble Node's queue, steer, replace).
    sessions: 1,
    // A permission answered on the web "for this run" becomes a rule of the run here (remote/policy.ts `judgeAnswer`).
    runAnswers: 1,
    // A node's own tool calls run here (`node.tool.request`, protocol 6), judged here; `sandbox` says how strong the floor is.
    nodeTools: NODE_TOOLS_API,
    // A node shares a folder (zipped here) and files up to 100 MB, and puts its owner's files (chat attachments) here.
    nodeFiles: NODE_FILES_API,
    // Files a run's worker attaches go to the web, unless the person turned it off here (`ensemble evidence off`).
    evidenceUpload: settings.evidenceUpload,
    // A run from Ensemble Node gets only the saved secrets it names (the claim's `secrets`).
    secretScope: 1,
    // An Ensemble Node build can work in its own git worktree of a shared folder (the claim's `mission.worktree`, B13).
    worktrees: 1,
    // The key the web encrypts secrets for, how runs get secrets, and secrets used by reference (B12).
    ...credentialCapabilities(settings),
    // A node's browser and capture tools run here (protocol 7), and what this computer can capture.
    browser: BROWSER_API,
    // Sign-ins and human checks handed to the owner: the card's answers (`login.resolve`), saved logins here, seen done here (B11, protocol 8; 2: purpose, codes, checks).
    logins: LOGINS_API,
    // The owner can control a tab of this computer's browser from the web, end to end (B21, protocol 8; 2: sign-ins in a clean browser; 3: live views, control and extend).
    takeover: TAKEOVER_API,
    // A node's terminals stay open here between its calls, and the owner watches them and the node's tabs live (C3).
    live: LIVE_API,
    // A node's command that needs a sign-in: its code goes to the owner's card, a page it opens to this computer's sign-in browser (C2).
    cliLogins: CLI_LOGINS_API,
    capture: await (await import("../capture/runtime.js")).captureSummary().catch(() => null),
  };
}

/** The last check of this computer's agents; the first heartbeat waits a little for one. */
async function agentsNow(): Promise<SubscriptionAgent[]> {
  const cached = cachedAgents();
  if (cached) return cached;
  return Promise.race([detectAgents().catch(() => []), new Promise<SubscriptionAgent[]>((resolve) => setTimeout(() => resolve([]), 12_000).unref())]);
}

/**
 * Stop every remote-originated local job. Locally assigned jobs are not in
 * `held`, so they keep running. `report` tells the hosted row when the token
 * still works; a 401 cannot.
 */
export async function stopRemoteWork(app: FastifyInstance, message: string, report: "cancelled" | "none"): Promise<void> {
  stopWebTerminal();
  stopNodeCommands();
  await endAllTakeovers("stopped").catch(() => undefined);
  await (await import("../logins/requests.js")).endAllLogins(message).catch(() => undefined);
  stopAllAssistantTurns();
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
  // A run's live view goes to the web under its hosted job and lease, one small frame at a time (protocol 7).
  setLiveSink((localJobId, frame) => {
    const job = Object.values(held()).find((row) => row.localJobId === localJobId && row.phase === "active");
    if (!job || (job.protocol ?? 1) < 7 || !client.liveFrame || (frame.jpeg && frame.jpeg.length > 220_000)) return false;
    const picture = frame.jpeg ? { jpeg: frame.jpeg.toString("base64"), ...(frame.width ? { width: frame.width } : {}), ...(frame.height ? { height: frame.height } : {}) } : {};
    void client.liveFrame(job.hostedId, { leaseToken: job.leaseToken, tab: frame.tab, url: frame.url, title: frame.title, at: frame.at, ...picture, ...(frame.paused ? { paused: frame.paused } : {}) }).catch(() => undefined);
    return true;
  });
  // A run's agent waits for its owner to sign in: the web raises the card where the run is followed (protocol 8).
  setRunLoginSink(async (localJobId, login) => {
    const job = Object.values(held()).find((row) => row.localJobId === localJobId && row.phase === "active");
    if (!job || (job.protocol ?? 1) < 8 || !client.runLogin) return null;
    return client.runLogin(job.hostedId, { leaseToken: job.leaseToken, ...login });
  });
  // A sign-in seen done here by itself (or gone, or expired) is told to the web, which updates its card (logins 2).
  setLoginStateSink(async (loginId, state) => client.loginState?.(loginId, state));
  await reconcile(app, client);
  let claiming = false;
  // A wake-up that arrives while a claim is under way claims again after it, so no queued job is missed.
  let claimAgain = false;
  const claim = async () => {
    if (signal.aborted) return;
    if (claiming) {
      claimAgain = true;
      return;
    }
    claiming = true;
    try {
      do {
        claimAgain = false;
        for (;;) {
          if (signal.aborted || !loadSettings().enabled) return;
          const res = await client.claim();
          if (res.status === 204) break;
          if (res.status >= 400) throw new RemoteError(res.status, "The claim was refused.");
          const spec = parseClaim(res.body);
          if (held()[spec.id]) break;
          held()[spec.id] = await acceptClaimed(app, client, spec);
          persist();
        }
      } while (claimAgain && !signal.aborted);
    } finally {
      claiming = false;
    }
  };
  let streamUp = false;
  // Each heartbeat also claims: the server refuses a claim past the person's concurrent runs, and a slot can free without a wake-up.
  const heartbeat = setInterval(() => void beat(app, client, signal).then(() => claim()).catch(fail), timing().heartbeatMs);
  // Log batches only. Claim is not on this timer: a 2s claim poll would burn the hosted command budget.
  // One mirror at a time: a job's last posts can take longer than the timer, and two at once would send twice.
  let mirroring: Promise<void> | null = null;
  const mirrorOnce = () => (mirroring ??= mirror(app, client, signal).finally(() => (mirroring = null)));
  const sync = setInterval(() => void mirrorOnce().catch(fail), timing().syncMs);
  // Fallback while the event stream is down. The shipped cadence is 15s, not the 2s log sync.
  const poll = setInterval(() => {
    if (!streamUp) void claim().catch(fail);
  }, timing().pollMs);
  try {
    await beat(app, client, signal);
    await claim();
    await mirrorOnce();
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
        // The web opened a file or folder of a task run here. A failure to answer leaves the web to time out.
        if (event === "files.request") void answerFileRequest(app, client, data).catch(() => undefined);
        // The web's Code tab and terminal on this computer (protocol 4). Each answers once; a lost answer times out on the web.
        if (event === "code.request") void answerCodeRequest(app, client, data).catch(() => undefined);
        if (event === "terminal.request") void answerTerminalRequest(app, client, data).catch(() => undefined);
        // A node's own tool call (protocol 6): judged and run here; a lost answer times out on the web.
        if (event === "node.tool.request") void answerNodeToolRequest(app, client, data).catch(() => undefined);
        // A secret typed on the web for this computer's runs: kept here only.
        if (event === "secret.save") void answerSecretSave(client, data).catch(() => undefined);
        // The owner's answer to a sign-in card (B11, protocol 8).
        if (event === "login.resolve") void answerLoginResolve(client, data).catch(() => undefined);
        // The owner controls a tab from the web, end to end (B21, protocol 8): a run's tab is its local job's.
        if (event === "takeover.start") void answerTakeoverStart(client, data, (hostedJobId) => Object.values(held()).find((row) => row.hostedId === hostedJobId && row.phase === "active")?.localJobId ?? null).catch(() => undefined);
        if (event === "takeover.input") takeoverInput(data);
        if (event === "takeover.extend") takeoverExtend(data);
        if (event === "takeover.end") void answerTakeoverEnd(client, data).catch(() => undefined);
        if (event === "takeover.control") void answerTakeoverControl(client, data).catch(() => undefined);
        // The owner previews, releases or discards a file kept here (protocol 7).
        if (event === "evidence.request") void answerEvidenceRequest(app, client, data).catch(() => undefined);
        // The assistant on the web, on one of the person's own subscriptions here (docs/25 §4.9).
        if (event === "assistant.turn") void answerAssistantTurn(client, data).catch(fail);
        if (event === "assistant.stop") stopAssistantTurn(data);
        if (event === "agents.refresh") void detectAgents({ force: true }).then(() => beat(app, client, signal)).catch(fail);
        if (event === "agents.signin") {
          const agent = typeof data === "object" && data !== null ? (data as { agent?: unknown }).agent : null;
          if (SUBSCRIPTION_PROVIDERS.includes(agent as SubscriptionProvider)) {
            void startSignIn(agent as SubscriptionProvider, () => void beat(app, client, signal).catch(fail)).catch((error: unknown) => app.log.warn({ err: error }, "sign-in could not start"));
          }
        }
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
    if (currentSession === abort) {
      currentSession = null;
      setLiveSink(null);
      setRunLoginSink(null);
      setLoginStateSink(null);
    }
  }
}

async function beat(app: FastifyInstance, client: HostedClient, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const settings = loadSettings();
  if (launcherRemoved(process.env.ENSEMBLE_INSTALL_PATH)) {
    await stopRemoteWork(app, "Ensemble was uninstalled from this computer.", "cancelled");
    await client.unpairSelf().catch(() => undefined);
    await dropDeviceToken();
    updateSettings({ enabled: false, pairedAt: null, deviceId: null });
    currentSession?.abort();
    return;
  }
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

/**
 * When the connection opens (a start, or the end of an outage), each run held here is settled with
 * the web (docs/25 §3): one that ended reports its result; one cut off by a restart asks to be
 * carried on; one still running carries on, and its next post reattaches it if its lease ran out.
 */
async function reconcile(app: FastifyInstance, client: HostedClient): Promise<void> {
  for (const job of Object.values(held())) {
    if (job.phase === "done" || !job.localJobId) continue;
    const local = await app.prisma.workspaceJob.findUnique({ where: { id: job.localJobId } });
    if (!local || !TERMINAL.has(local.status)) continue;
    await finish(app, client, job, local);
  }
  persist();
}

/** The web refused this run's lease. 409: it ran out while this computer was cut off. */
function leaseLost(error: unknown): boolean {
  return error instanceof RemoteError && error.status === 409;
}

/**
 * Takes a run back after its lease ran out (protocol 5): a new lease, and the questions it is waiting
 * on asked on the web again. When the web no longer wants it (stopped, run again, ended), it stops
 * here too. True when the run is back.
 */
async function reattach(app: FastifyInstance, client: HostedClient, job: HeldJob, local: WorkspaceJob): Promise<boolean> {
  if ((job.protocol ?? 1) < 5 || !client.reattach) return false;
  const status = TERMINAL.has(local.status) ? "finished" : local.status === "waiting_approval" ? "waiting_approval" : "running";
  const answer = await client.reattach(job.hostedId, { leaseToken: job.leaseToken, status });
  if ("leaseToken" in answer) {
    job.leaseToken = answer.leaseToken;
    job.sentStatus = null;
    job.decisions = {};
    job.lastOkAt = Date.now();
    persist();
    await appendLedger({ userId: userId(), actor: "system", action: "remote.reattach", payload: { hostedJobId: job.hostedId } }).catch(() => undefined);
    return true;
  }
  if (!TERMINAL.has(local.status)) await interruptJob(app, local.id, `Stopped: Ensemble on the web no longer runs this task here. ${answer.refused}`.trim()).catch(() => undefined);
  job.phase = "done";
  persist();
  return false;
}

/**
 * A run cut off because Ensemble quit (a restart, a power cut, a crash) asks the web to carry it on
 * (protocol 5); the new run arrives with the next claim and continues in the same folder and agent
 * session. Any other interruption, or a refusal, leaves it for Run again.
 */
async function carryOn(client: HostedClient, job: HeldJob, local: WorkspaceJob): Promise<void> {
  if ((job.protocol ?? 1) < 5 || !client.resume || local.error !== INTERRUPTED_MESSAGE) {
    job.phase = "done";
    return;
  }
  const at = (local.finishedAt ?? new Date()).toISOString().slice(0, 16).replace("T", " ");
  const answer = await client.resume(job.hostedId, { leaseToken: job.leaseToken, reason: `this computer restarted or Ensemble quit while the run was going (around ${at} UTC)` });
  job.phase = "done";
  await appendLedger({ userId: userId(), actor: "system", action: "remote.resume", payload: { hostedJobId: job.hostedId, ...("jobId" in answer ? { next: answer.jobId } : { refused: answer.refused }) } }).catch(() => undefined);
}

async function mirror(app: FastifyInstance, client: HostedClient, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  for (const job of Object.values(held())) {
    if (job.phase !== "active" || !job.localJobId || signal.aborted) continue;
    const local = await app.prisma.workspaceJob.findUnique({ where: { id: job.localJobId } });
    if (!local) continue;
    try {
      if (TERMINAL.has(local.status)) {
        // Send the last events, log text and steps first. A job that ends between two syncs would otherwise post
        // none of them, and a long run's remainder can take more than one post.
        if (local.status !== "interrupted") {
          for (let round = 0; round < 20; round += 1) if (!(await sendProgress(app, client, job, local, true))) break;
        }
        await finish(app, client, job, local);
        continue;
      }
      await relayDecisions(app, client, job, local, signal);
      // Files the worker attached go as soon as they are attached, while the run holds its lease.
      await sendEvidence(app, client, job, local);
      await sendProgress(app, client, job, local);
    } catch (error) {
      // The lease ran out while this computer was cut off and the run kept going: take it back; the next sync sends.
      if (!leaseLost(error)) throw error;
      await reattach(app, client, job, local);
    }
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
      const risk = riskOf(decision);
      const web = loadSettings().acceptWebApprovals;
      const detail = (row.detail ?? {}) as { allowCustom?: unknown; recommended?: unknown };
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
        // high_risk means "only on this computer": sent only when this computer refuses web answers to it.
        // Otherwise a risky question is ordinary and the web asks the person to confirm before allowing.
        tier: risk === "high" && !web ? "high_risk" : "ordinary",
        ...(risk === "high" && web ? { confirm: true } : {}),
        ...(detail.allowCustom === true ? { allowCustom: true } : {}),
        ...(typeof detail.recommended === "string" && detail.recommended ? { recommended: scrubOutgoing(detail.recommended).slice(0, 200) } : {}),
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
      // Answered here (the app, the CLI): close the card on the web as well. Withdrawn here (the agent
      // stopped waiting) while the run goes on: withdraw it there too.
      if (local?.status === "decided" && (local.decision === "allow" || local.decision === "deny")) {
        await client.closeDecision(mirror.hostedId, { decision: local.decision, reason: local.reason ?? null }).catch(() => undefined);
      } else if (local?.status === "expired" && !signal.aborted && job.phase === "active") {
        await client.closeDecision(mirror.hostedId, { decision: "expired", reason: null }).catch(() => undefined);
      }
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
      acceptWeb: loadSettings().acceptWebApprovals,
    });
    if (verdict.kind === "wait") continue;
    mirror.settled = true;
    persist();
    if (verdict.kind === "apply") {
      // "For this run" is saved here as a rule of the run (routes/decisions.ts); should this computer refuse that, the answer still counts once.
      const apply = (scope: "once" | "session") => applyAnswer(app, userId(), localId, { decision: verdict.decision, scope, reason: verdict.reason ?? undefined }, "system");
      await apply(verdict.scope ?? "once")
        .catch((error: unknown) => (verdict.scope ? apply("once") : Promise.reject(error)))
        .catch(() => undefined);
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

/** One progress post when anything changed (or the heartbeat is due). True when it posted. */
async function sendProgress(app: FastifyInstance, client: HostedClient, job: HeldJob, local: WorkspaceJob, last = false): Promise<boolean> {
  // The device route accepts only "running". waiting_approval is set by ask, and sending it is a 400.
  // On the last sends, a job that ended before any sync still reports that it ran, once.
  const status = local.status === "running" || (last && job.sentStatus !== "running") ? "running" : null;
  const statusChanged = last ? status === "running" : status !== job.sentStatus;
  const progress = scrubOutgoing(local.progress ?? "").slice(0, 200);
  const events = await unreadEvents(app, job, local.id);
  const logs = takeLog(job, local.id);
  const steps = await changedSteps(app, job, local.runId);
  // What the engine reported it runs with goes when it changes (servers before it ignore the field).
  const observed = await observedHere(app.prisma, local.id);
  const observedChanged = anyObserved(observed) && !sameObserved(observed, job.sentObserved);
  const changed = statusChanged || progress !== job.sentProgress || events.rows.length > 0 || Boolean(logs) || steps.rows.length > 0 || observedChanged;
  if (!changed && (last || Date.now() - job.sentAt < timing().heartbeatMs)) return false;
  await client.progress(job.hostedId, job.leaseToken, {
    ...(status ? { status } : {}),
    progress,
    events: events.rows,
    ...(logs ? { logs: { seqFrom: logs.seqFrom, seqTo: logs.seqTo, text: logs.text } } : {}),
    ...(steps.rows.length ? { steps: steps.rows } : {}),
    ...(observedChanged ? { observed } : {}),
  });
  job.eventSeq = events.last;
  job.stepsSent = { ...(job.stepsSent ?? {}), ...steps.sent };
  if (observedChanged) job.sentObserved = observed;
  if (!last || status) job.sentStatus = status;
  job.sentProgress = progress;
  job.sentAt = Date.now();
  job.lastOkAt = Date.now();
  if (logs) {
    job.logOffset = logs.end;
    job.logBytes += Buffer.byteLength(logs.text);
    job.logSeq += 1;
  }
  return changed;
}

/**
 * Events after the last one sent, the kinds a computer may post, at most 50 a post. The cursor stops
 * at the last event sent, so a busy run's events go on later posts instead of being skipped; and it
 * reads after the cursor, so a run with hundreds of events keeps sending.
 */
async function unreadEvents(app: FastifyInstance, job: HeldJob, localId: string): Promise<{ last: string; rows: Array<{ kind: string; data?: Record<string, unknown> }> }> {
  const rows = await app.prisma.workspaceEvent.findMany({ where: { jobId: localId, sequence: { gt: BigInt(job.eventSeq) } }, orderBy: { sequence: "asc" }, take: 300 });
  const fresh: Array<{ kind: string; data?: Record<string, unknown> }> = [];
  let last = job.eventSeq;
  for (const row of rows) {
    const event = hostedEvent(row.kind, row.data);
    if (deviceOwnedEvents([event], job.protocol ?? 1).length) {
      if (fresh.length >= 50) break;
      fresh.push(event);
    }
    last = row.sequence.toString();
  }
  return { last, rows: fresh };
}

/** A step's signature: it is sent again only when this changes. */
const stepSignature = (step: { status: string; title: string; endedAt: Date | null; output: string | null; reasoning: string | null }) =>
  `${step.status}|${step.title.length}|${step.endedAt?.toISOString() ?? ""}|${step.output?.length ?? 0}|${step.reasoning?.length ?? 0}`;

/** The run's steps that changed since the last post, scrubbed and cut to previews (docs/25 §4.5). */
async function changedSteps(app: FastifyInstance, job: HeldJob, runId: string | null): Promise<{ rows: UploadedStep[]; sent: Record<string, string> }> {
  // A server before protocol 2 does not take steps.
  if (!runId || (job.protocol ?? 1) < 2) return { rows: [], sent: {} };
  const steps = await app.prisma.runStep.findMany({ where: { runId, index: { lt: MAX_UPLOADED_STEPS } }, orderBy: { index: "asc" } });
  const rows: UploadedStep[] = [];
  const sent: Record<string, string> = {};
  const cut = (value: string | null, max: number) => (value ? scrubOutgoing(value).slice(0, max) : null);
  let bytes = 0;
  for (const step of steps) {
    const signature = stepSignature(step);
    if (job.stepsSent?.[String(step.index)] === signature) continue;
    if (rows.length >= 60 || bytes >= STEP_POST_BYTES) break;
    const calls = (Array.isArray(step.toolCalls) ? step.toolCalls : []) as Array<Record<string, unknown>>;
    const row: UploadedStep = {
      index: step.index,
      title: scrubOutgoing(step.title).slice(0, 300),
      status: step.status,
      output: cut(step.output, 4000),
      reasoning: cut(step.reasoning, 4000),
      error: cut(step.error, 1000),
      model: step.model,
      tokensIn: step.tokensIn,
      tokensOut: step.tokensOut,
      toolCalls: calls.slice(0, 10).map((call) => ({
        ...(typeof call.id === "string" ? { id: call.id.slice(0, 200) } : {}),
        name: String(call.name ?? "tool").slice(0, 120),
        ...(call.args !== undefined ? { args: scrubOutgoing(typeof call.args === "string" ? call.args : JSON.stringify(call.args)).slice(0, 2000) } : {}),
        ...(call.output !== undefined ? { output: scrubOutgoing(typeof call.output === "string" ? call.output : JSON.stringify(call.output)).slice(0, 4000) } : {}),
        ...(typeof call.ok === "boolean" ? { ok: call.ok } : {}),
        ...(typeof call.ms === "number" && call.ms >= 0 ? { ms: call.ms } : {}),
        ...(typeof call.engine === "string" ? { engine: call.engine.slice(0, 40) } : {}),
        ...(typeof call.summary === "string" && call.summary ? { summary: scrubOutgoing(call.summary).slice(0, 300) } : {}),
      })),
      startedAt: step.startedAt?.toISOString() ?? null,
      endedAt: step.endedAt?.toISOString() ?? null,
    };
    rows.push(row);
    bytes += JSON.stringify(row).length;
    sent[String(step.index)] = signature;
  }
  return { rows, sent };
}

/** What the engine reported this run went with (workspace/engines/observed.ts), scrubbed like everything sent. */
async function observedHere(db: Pick<typeof prisma, "workspaceEvent">, localId: string): Promise<ObservedSettings> {
  const rows = await db.workspaceEvent.findMany({ where: { jobId: localId, kind: { in: ["engine", "engine_context"] } }, orderBy: { sequence: "desc" }, take: 20, select: { kind: true, data: true } });
  const found = observedFromEvents(rows.reverse());
  return {
    ...found,
    ...(found.model ? { model: scrubOutgoing(found.model).slice(0, 200) } : {}),
    ...(found.effort ? { effort: scrubOutgoing(found.effort).slice(0, 40) } : {}),
  };
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


function scrubData(data: unknown): unknown {
  if (typeof data === "string") return scrubOutgoing(data).slice(0, 2000);
  if (Array.isArray(data)) return data.slice(0, 20).map(scrubData);
  if (typeof data === "object" && data !== null) {
    return Object.fromEntries(Object.entries(data as Record<string, unknown>).slice(0, 20).map(([key, value]) => [key, scrubData(value)]));
  }
  return data;
}

async function finish(app: FastifyInstance, client: HostedClient, job: HeldJob, local: WorkspaceJob): Promise<void> {
  // Interrupted here (Ensemble quit): the web may carry it on. Posting that outcome is a 400.
  if (local.status === "interrupted") {
    await carryOn(client, job, local);
    return;
  }
  const outcome = local.status === "succeeded" ? "succeeded" : local.status === "cancelled" ? "cancelled" : local.status === "blocked" ? "blocked" : "failed";
  const current = (job.protocol ?? 1) >= 2;
  const summary = scrubOutgoing(local.summary || local.error || "").slice(0, current ? 20_000 : LEGACY_SUMMARY_CHARS);
  const report = (job.protocol ?? 1) >= 6 ? parseReport(local.report) : null;
  const send = async () => {
    // The changed files' text and the attached files first: the lease ends with complete.
    await uploadChangedFiles(client, job, local).catch((error: unknown) => {
      if (authRejected(error)) throw error;
    });
    await sendEvidence(app, client, job, local).catch((error: unknown) => {
      if (authRejected(error) || (error instanceof RemoteError && error.status === 409)) throw error;
      app.log.warn({ err: error }, "could not send the run's evidence");
    });
    await client.complete(job.hostedId, job.leaseToken, { outcome, summary, results: resultLinks(local), ...(current ? { totals: await runTotals(local) } : {}), ...(report ? { report } : {}) });
  };
  try {
    await send();
  } catch (error) {
    if (authRejected(error)) throw error;
    if (!(error instanceof RemoteError) || (error.status !== 409 && error.status !== 410 && error.status !== 404)) throw error;
    // Finished while this computer was cut off and the lease ran out: take the run back, then report it.
    if (error.status === 409 && (await reattach(app, client, job, local))) {
      await send().catch((again: unknown) => {
        if (authRejected(again)) throw again;
      });
    }
  }
  // An integration step that succeeded: the worktrees it brought in go, when nothing would be lost (B13).
  if (local.status === "succeeded") await removeIntegrated(local).catch((error: unknown) => app.log.warn({ err: error }, "could not remove integrated worktrees"));
  job.phase = "done";
}

async function removeIntegrated(local: WorkspaceJob): Promise<void> {
  const mission = missionOf(local.context);
  const root = (local.context as { mission?: { root?: unknown } } | null)?.mission?.root;
  if (!mission?.integrates?.length || typeof root !== "string") return;
  await removeWorktrees({ userId: userId(), folder: root, workspace: await workspaceRoot(), names: mission.integrates });
}

/** What the run reports when it ends: counts, the model that answered, its cost estimate, the files changed (names and line counts). */
async function runTotals(local: WorkspaceJob): Promise<RunTotals> {
  const evidence = (local.evidence && typeof local.evidence === "object" && !Array.isArray(local.evidence) ? local.evidence : {}) as {
    files?: Array<{ path?: unknown; added?: unknown; removed?: unknown; status?: unknown; binary?: unknown }>;
    model?: unknown;
    costUsd?: unknown;
  };
  const files = (Array.isArray(evidence.files) ? evidence.files : [])
    .filter((file) => typeof file.path === "string")
    .slice(0, 200)
    .map((file) => ({
      path: scrubOutgoing(String(file.path)).slice(0, 500),
      added: Math.max(0, Number(file.added) || 0),
      removed: Math.max(0, Number(file.removed) || 0),
      ...(file.status === "added" || file.status === "modified" || file.status === "deleted" ? { status: file.status as "added" | "modified" | "deleted" } : {}),
      ...(file.binary === true ? { binary: true } : {}),
    }));
  return {
    model: typeof evidence.model === "string" ? evidence.model.slice(0, 200) : local.model?.slice(0, 200) ?? null,
    turns: local.turns,
    toolCalls: local.toolCalls,
    tokensIn: local.tokensIn,
    tokensOut: local.tokensOut,
    costUsd: typeof evidence.costUsd === "number" && evidence.costUsd >= 0 ? evidence.costUsd : null,
    reviewId: (await prisma.codeReview.findUnique({ where: { jobId: local.id }, select: { id: true } }).catch(() => null))?.id ?? null,
    files,
    observed: await observedHere(prisma, local.id).catch(() => ({})),
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
