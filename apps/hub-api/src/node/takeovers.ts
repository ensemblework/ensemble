/**
 * Taking over a browser tab from the web (design B21, docs/35 §8.16.2): the owner controls a tab of
 * their computer's Ensemble browser from Node, end to end. This server only relays: it hands out a
 * short-lived, single-use capability bound to the account, the browser session that asked, the computer,
 * the tab, its site and the sign-in card or run; relays the channel's secret in a box sealed for the
 * computer (it cannot open it); keeps the latest encrypted frame for a few seconds so the page can fetch
 * it; and passes encrypted input on in order. It never holds a readable frame, key or keystroke: the
 * browser and the computer encrypt with keys only they derive. One controller at a time; it ends on
 * expiry, sign-out, unpairing, the computer ending it, Stop or I'm done (which checks the sign-in).
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Device, NodeMessage } from "@prisma/client";
import { SEAL_MAX_TTL_MS, type SealKeyInfo, type Sealed } from "@ensemble/shared-types";
import { deviceOnline } from "../devices/constants.js";
import { askDeviceFor } from "../devices/file-relay.js";
import { fileAnswers, publishDeviceFrame, publishFileAnswer } from "../devices/revoke-notify.js";
import { appendLedger } from "../lib/ledger.js";
import { readAad, SealError } from "../credentials/seal.js";
import { CodeAnswer, LIVE_API, TAKEOVER_CLEAN_API, TAKEOVER_EXTEND_API, TAKEOVER_EXTEND_MS, TAKEOVER_LONGEST_MS, TAKEOVER_MIN_API, type ChannelMessage } from "../remote/contract.js";
import { secretRouteFor } from "./node-secrets.js";
import { loginTakeoverEnded } from "./logins.js";
import { endLiveCard, liveCardTarget } from "./live-views.js";

type Redisish = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
};

/** How long a capability waits for its browser to start the takeover. */
const START_MS = 2 * 60_000;
/** The relay keeps the latest frame this long; a page that stops fetching misses nothing it would show. */
const FRAME_TTL_SECONDS = 30;
/** A frames request waits this long for a new one. */
const FRAMES_WAIT_MS = 20_000;
const RECORD_TTL_SECONDS = 2 * 3600;

/** The longest a takeover lasts (`ENSEMBLE_TAKEOVER_SECONDS`, default 15 minutes), as the computer has it too. */
export function takeoverMaxMs(source: NodeJS.ProcessEnv = process.env): number {
  const seconds = Number(source.ENSEMBLE_TAKEOVER_SECONDS ?? 900);
  return Math.min(Math.max(Number.isFinite(seconds) ? seconds : 900, 2), 3600) * 1000;
}

export class TakeoverError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 401 | 403 | 404 | 409 | 410 | 502,
    readonly code?: string,
  ) {
    super(message);
  }
}

export type TakeoverRecord = {
  id: string;
  accountId: string;
  /** The browser session that asked: only it may use the capability. */
  sessionId: string;
  controllerHash: string;
  deviceId: string;
  computer: string;
  tab: string;
  origin: string;
  loginCardId: string | null;
  loginId: string | null;
  jobId: string | null;
  /** "clean": a sign-in in a clean browser on the computer (`TAKEOVER_CLEAN_API`); "tab": the tab itself. */
  mode?: "tab" | "clean";
  /** A live view (node/live-views.ts): its card, what it shows, the node's operation that owns it, and whether the owner watches or controls it. */
  liveCardId?: string | null;
  kind?: "browser" | "terminal";
  operation?: string | null;
  view?: "watch" | "control";
  createdAt: string;
  startBy: string;
  /** When the computer started it: an extend never moves its end past an hour after this. */
  startedAt?: string;
  endsAt: string | null;
  state: "created" | "live" | "ended";
  reason?: string;
};

const recordKey = (id: string) => `ensemble:takeover:${id}`;
const targetKey = (deviceId: string, tab: string) => `ensemble:takeover:target:${deviceId}:${tab}`;
const startedKey = (id: string) => `ensemble:takeover:started:${id}`;
const frameKey = (id: string) => `ensemble:takeover:frame:${id}`;
const wake = (id: string) => `takeover:${id}`;

const hash = (token: string) => createHash("sha256").update(token).digest();
const redisOf = (app: FastifyInstance) => app.redis as unknown as Redisish;

async function read(app: FastifyInstance, id: string): Promise<TakeoverRecord | null> {
  const raw = await redisOf(app).get(recordKey(id));
  return raw ? (JSON.parse(raw) as TakeoverRecord) : null;
}

async function write(app: FastifyInstance, record: TakeoverRecord): Promise<void> {
  await redisOf(app).set(recordKey(record.id), JSON.stringify(record), "EX", RECORD_TTL_SECONDS);
}

/**
 * What the page is given about a takeover: never the token's hash or the session. `tab` is what the
 * start box is sealed for (a terminal's session id for a terminal); `mode` whether the owner watches or
 * controls it; `browser` which browser it shows.
 */
export function publicTakeover(record: TakeoverRecord, sealKey?: SealKeyInfo) {
  return {
    id: record.id,
    computer: { id: record.deviceId, name: record.computer },
    tab: record.tab,
    origin: record.origin,
    state: record.state,
    startBy: record.startBy,
    endsAt: record.endsAt,
    // The latest its end can be moved to with More time.
    ...(record.startedAt ? { maxEndsAt: new Date(Date.parse(record.startedAt) + TAKEOVER_LONGEST_MS).toISOString() } : {}),
    loginCardId: record.loginCardId,
    kind: record.kind ?? "browser",
    mode: record.view ?? "control",
    browser: record.mode ?? "tab",
    ...(record.liveCardId ? { liveCardId: record.liveCardId } : {}),
    ...(record.kind === "terminal" ? { session: record.tab } : {}),
    ...(sealKey ? { sealKey } : {}),
    ...(record.reason ? { reason: record.reason } : {}),
  };
}

/** Ends a takeover here: no more frames or input; the tab is free for another controller. */
async function markEnded(app: FastifyInstance, record: TakeoverRecord, reason: string, detail?: string): Promise<TakeoverRecord> {
  if (record.state === "ended") return record;
  relays.delete(record.id);
  const ended: TakeoverRecord = { ...record, state: "ended", reason };
  await write(app, ended);
  const redis = redisOf(app);
  if ((await redis.get(targetKey(record.deviceId, record.tab))) === record.id) await redis.del(targetKey(record.deviceId, record.tab));
  await redis.del(frameKey(record.id));
  publishFileAnswer(wake(record.id));
  await appendLedger({ userId: record.accountId, actor: "me", action: "node.takeover_ended", payload: { takeoverId: record.id, deviceId: record.deviceId, reason, ...(detail ? { detail: detail.slice(0, 200) } : {}) } }).catch(() => undefined);
  return ended;
}

/** Whether the computer runs a sign-in's takeover in a clean browser (`TAKEOVER_CLEAN_API`); older ones show the tab itself. */
export function cleanTakeover(device: Pick<Device, "capabilities">): boolean {
  const caps = (device.capabilities ?? {}) as { takeover?: unknown };
  return typeof caps.takeover === "number" && caps.takeover >= TAKEOVER_CLEAN_API;
}

/** The computer a takeover may use: the owner's, paired, online, able to take over and with a pinned key. */
async function takeoverDevice(app: FastifyInstance, accountId: string, deviceId: string, live = false): Promise<{ device: Device; sealKey: SealKeyInfo }> {
  const device = await app.prisma.device.findFirst({ where: { id: deviceId, userId: accountId, revokedAt: null } });
  if (!device) throw new TakeoverError("That computer is no longer paired.", 409);
  const caps = (device.capabilities ?? {}) as { takeover?: unknown; live?: unknown };
  if (typeof caps.takeover !== "number" || caps.takeover < TAKEOVER_MIN_API) throw new TakeoverError(`Update Ensemble on ${device.name}: it is too old to show its browser here.`, 409, "update");
  if (live && !(typeof caps.live === "number" && caps.live >= LIVE_API)) throw new TakeoverError(`Update Ensemble on ${device.name}: it is too old to show this live.`, 409, "update");
  const route = secretRouteFor(device);
  if (route.mode === "pair_again") throw new TakeoverError(`${device.name} now reports a different key from the one it was paired with. Pair it again first.`, 409, "pair_again");
  if (route.mode !== "sealed") throw new TakeoverError(`Update Ensemble on ${device.name}: it cannot encrypt its browser for this page yet.`, 409, "update");
  if (!deviceOnline(device.lastSeenAt)) throw new TakeoverError(`${device.name} is offline. Open Ensemble there, then try again.`, 409, "offline");
  return { device, sealKey: route.sealKey };
}

/** What a takeover is of: a sign-in card's tab, a run's tab (the one its live view shows), or a live card's terminal or tab. */
export type TakeoverTarget = { loginCardId: string } | { jobId: string; tab?: string } | { liveCardId: string };

type Target = { deviceId: string; tab: string; origin: string; loginCardId: string | null; loginId: string | null; jobId: string | null; live?: { cardId: string; kind: "browser" | "terminal"; operation: string } };

async function targetOf(app: FastifyInstance, accountId: string, input: TakeoverTarget): Promise<Target> {
  if ("liveCardId" in input) {
    const live = await liveCardTarget(app, accountId, input.liveCardId);
    if (!live) throw new TakeoverError("That live view is not available.", 404);
    if (live.data.status !== "open") throw new TakeoverError(live.data.kind === "terminal" ? "That terminal has ended." : "That tab has closed.", 410, "ended");
    const tab = live.data.kind === "terminal" ? live.data.session : live.data.tab;
    if (!tab) throw new TakeoverError("That live view cannot be opened here.", 409);
    return { deviceId: live.data.deviceId, tab, origin: "", loginCardId: null, loginId: null, jobId: null, live: { cardId: live.card.id, kind: live.data.kind, operation: live.operation } };
  }
  if ("loginCardId" in input) {
    const card = await app.prisma.nodeMessage.findUnique({ where: { id: input.loginCardId } });
    const data = (card?.data ?? {}) as { type?: unknown; status?: unknown; deviceId?: unknown; tab?: unknown; origin?: unknown; loginId?: unknown };
    if (!card || card.kind !== "approval" || data.type !== "login" || card.userId !== accountId || card.visibleTo.length !== 1 || card.visibleTo[0] !== accountId) throw new TakeoverError("That sign-in is not available.", 404);
    // A site that asks for a code can be answered on the page itself too.
    if (data.status !== "pending" && data.status !== "needs_code") throw new TakeoverError("That sign-in was already answered.", 409);
    if (typeof data.deviceId !== "string" || typeof data.tab !== "string" || typeof data.origin !== "string" || typeof data.loginId !== "string") throw new TakeoverError("That sign-in cannot be opened here.", 409);
    return { deviceId: data.deviceId, tab: data.tab, origin: data.origin, loginCardId: card.id, loginId: data.loginId, jobId: null };
  }
  const job = await app.prisma.workspaceJob.findUnique({ where: { id: input.jobId }, select: { id: true, status: true, deviceId: true, device: { select: { userId: true } } } });
  if (!job?.deviceId || job.device?.userId !== accountId) throw new TakeoverError("That run is not available.", 404);
  if (!["claimed", "running", "waiting_approval"].includes(job.status)) throw new TakeoverError("That run is not running.", 409);
  const live = await redisOf(app).get(`ensemble:live:${job.id}`);
  const frame = live ? (JSON.parse(live) as { tab?: string; url?: string }) : null;
  const tab = input.tab ?? frame?.tab;
  if (!tab || !/^t\d{1,9}$/.test(tab)) throw new TakeoverError("This run has no browser tab open.", 409, "no_tab");
  let origin = "";
  try {
    origin = frame?.url ? new URL(frame.url).origin : "";
  } catch {
    origin = "";
  }
  return { deviceId: job.deviceId, tab, origin, loginCardId: null, loginId: null, jobId: job.id };
}

/**
 * A new takeover for the signed-in owner's browser: the capability (`controller`, shown once) and what
 * the page needs to seal the channel's secret for the computer. Refused while someone controls the tab.
 */
export async function createTakeover(app: FastifyInstance, accountId: string, sessionId: string, input: TakeoverTarget): Promise<{ takeover: ReturnType<typeof publicTakeover>; controller: string }> {
  const target = await targetOf(app, accountId, input);
  const { device, sealKey } = await takeoverDevice(app, accountId, target.deviceId, Boolean(target.live));
  const redis = redisOf(app);
  const id = randomUUID();
  const lock = targetKey(device.id, target.tab);
  const taken = (await redis.set(lock, id, "EX", Math.ceil((START_MS + takeoverMaxMs()) / 1000) + 60, "NX")) === "OK";
  if (!taken) {
    const holder = await redis.get(lock);
    let current = holder ? await read(app, holder) : null;
    // The owner watching the tab live makes way for its sign-in (the computer ends the watch too).
    if (current && current.state !== "ended" && target.loginId && current.liveCardId && current.accountId === accountId && (current.view ?? "watch") === "watch") current = await endOnComputer(app, current, "sign_in");
    if (current && current.state !== "ended" && !(current.state === "created" && Date.parse(current.startBy) < Date.now())) throw new TakeoverError("Someone is already controlling this tab. Stop there first.", 409, "controlled");
    await redis.set(lock, id, "EX", Math.ceil((START_MS + takeoverMaxMs()) / 1000) + 60);
  }
  const controller = randomBytes(32).toString("base64url");
  const now = Date.now();
  const record: TakeoverRecord = {
    id,
    accountId,
    sessionId,
    controllerHash: hash(controller).toString("hex"),
    deviceId: device.id,
    computer: device.name,
    tab: target.tab,
    origin: target.origin,
    loginCardId: target.loginCardId,
    loginId: target.loginId,
    jobId: target.jobId,
    mode: target.loginId && cleanTakeover(device) ? "clean" : "tab",
    ...(target.live ? { liveCardId: target.live.cardId, kind: target.live.kind, operation: target.live.operation, view: "watch" as const } : {}),
    createdAt: new Date(now).toISOString(),
    startBy: new Date(now + START_MS).toISOString(),
    endsAt: null,
    state: "created",
  };
  await write(app, record);
  await appendLedger({ userId: accountId, actor: "me", action: "node.takeover_created", payload: { takeoverId: id, deviceId: device.id, tab: target.tab, origin: target.origin, login: Boolean(target.loginId), ...(target.live ? { kind: target.live.kind } : {}) } });
  return { takeover: publicTakeover(record, sealKey), controller };
}

/**
 * The takeover, if this request may use it: its owner, from the browser session that made it, with
 * its capability. A session that signed out ends it.
 */
export async function ownTakeover(app: FastifyInstance, accountId: string, sessionId: string | null, id: string, controller: string | undefined): Promise<TakeoverRecord> {
  const record = await read(app, id);
  if (!record || record.accountId !== accountId) throw new TakeoverError("That takeover is not available.", 404);
  if (!controller || !sessionId || sessionId !== record.sessionId) throw new TakeoverError("Only the browser that opened it can control it.", 403, "controller");
  const given = hash(controller);
  const known = Buffer.from(record.controllerHash, "hex");
  if (given.length !== known.length || !timingSafeEqual(given, known)) throw new TakeoverError("Only the browser that opened it can control it.", 403, "controller");
  return record;
}

/** Ends a takeover whose time ran out, whose session signed out or whose computer was unpaired. */
async function stillGood(app: FastifyInstance, record: TakeoverRecord): Promise<TakeoverRecord> {
  if (record.state === "ended") return record;
  if (record.state === "created" && Date.parse(record.startBy) <= Date.now()) return markEnded(app, record, "expired");
  if (record.endsAt && Date.parse(record.endsAt) <= Date.now()) return endOnComputer(app, record, "expired");
  const [session, device] = await Promise.all([
    app.prisma.session.findUnique({ where: { id: record.sessionId }, select: { expiresAt: true } }),
    app.prisma.device.findFirst({ where: { id: record.deviceId, revokedAt: null }, select: { id: true } }),
  ]);
  if (!session || session.expiresAt <= new Date()) return endOnComputer(app, record, "signed_out");
  if (!device) return markEnded(app, record, "unpaired");
  return record;
}

/** Tells the computer to stop (without waiting), then ends it here. */
async function endOnComputer(app: FastifyInstance, record: TakeoverRecord, reason: string): Promise<TakeoverRecord> {
  if (record.state === "live") publishDeviceFrame(record.deviceId, "takeover.end", { takeoverId: record.id, done: false, reason });
  return markEnded(app, record, reason);
}

/** A start box, checked against this takeover, its computer's pinned key and the page that sent it; the computer checks again. */
function checkStartBox(sealed: Sealed, record: TakeoverRecord, sealKey: SealKeyInfo, origin: string | undefined): void {
  let aad;
  try {
    aad = readAad(sealed);
  } catch (error) {
    throw new TakeoverError(error instanceof SealError ? error.message : "The takeover's key could not be read.", 400, "seal_shape");
  }
  const now = Date.now();
  const expires = Date.parse(aad.expiresAt);
  const problem =
    sealed.kid !== sealKey.kid || aad.kid !== sealKey.kid
      ? "It was encrypted for an older key of this computer. Reload the page."
      : aad.deviceId !== record.deviceId || aad.decisionId !== record.id || aad.purpose !== "takeover" || aad.name !== record.tab
        ? "It was encrypted for another takeover."
        : origin && aad.origin !== origin
          ? "It was encrypted on another site."
          : !Number.isFinite(expires) || expires <= now || expires - now > SEAL_MAX_TTL_MS
            ? "It expired. Open the browser again."
            : null;
  if (problem) throw new TakeoverError(problem, 400, "seal_bound");
}

/** Starts it, once: relays the sealed secret to the computer, which starts streaming the tab. */
export async function startTakeover(app: FastifyInstance, record: TakeoverRecord, sealed: Sealed, origin: string | undefined): Promise<{ takeover: ReturnType<typeof publicTakeover>; width?: number; height?: number; note?: string }> {
  const current = await stillGood(app, record);
  if (current.state !== "created") throw new TakeoverError(current.state === "live" ? "This takeover has started already." : "This takeover has ended. Open the browser again.", 409, "state");
  const { device, sealKey } = await takeoverDevice(app, current.accountId, current.deviceId, Boolean(current.liveCardId));
  checkStartBox(sealed, current, sealKey, origin);
  // Single use: the first start wins.
  if ((await redisOf(app).set(startedKey(current.id), "1", "EX", RECORD_TTL_SECONDS, "NX")) !== "OK") throw new TakeoverError("This takeover has started already.", 409, "state");
  const endsAt = new Date(Date.now() + takeoverMaxMs()).toISOString();
  // A sign-in on a computer that can runs in a clean browser; an older computer is never sent a mode it does not know.
  const mode = current.loginId && cleanTakeover(device) ? { mode: "clean" as const } : {};
  // A live view says what it shows, whose it must be, and that it starts by watching.
  const liveView = current.liveCardId ? { kind: current.kind ?? "browser", operation: current.operation, view: current.view ?? "watch" } : {};
  const raw = await askDeviceFor(app.redis as never, { deviceId: device.id, event: "takeover.start", data: { takeoverId: current.id, tab: current.tab, ...(current.loginId ? { loginId: current.loginId } : {}), ...(current.jobId ? { jobId: current.jobId } : {}), sealed, endsAt, ...mode, ...liveView } }, 25_000).catch(() => null);
  const answer = raw ? CodeAnswer.safeParse(raw) : null;
  const body = (answer?.success && answer.data.body && typeof answer.data.body === "object" ? answer.data.body : {}) as { error?: unknown; width?: unknown; height?: unknown; endsAt?: unknown; mode?: unknown; note?: unknown };
  if (!answer?.success || answer.data.status >= 400) {
    const why = typeof body.error === "string" ? body.error : `${device.name} did not answer. Check Ensemble is running there.`;
    // Why it was refused (never a value: the computer's own words, such as "That tab is closed.").
    await markEnded(app, current, "refused", raw ? `${answer?.success ? answer.data.status : "bad answer"}: ${why}` : "no answer");
    // The terminal or tab is gone from the computer: its card ends.
    if (current.liveCardId && answer?.success && answer.data.status === 410) {
      const card = await app.prisma.nodeMessage.findUnique({ where: { id: current.liveCardId }, select: { data: true } });
      const liveId = (card?.data as { liveId?: unknown } | null)?.liveId;
      if (typeof liveId === "string") await endLiveCard(app, current.accountId, liveId, "gone");
    }
    throw new TakeoverError(why, 502);
  }
  // The computer says which browser it shows (takeover 2): the clean one, or the tab when that could not start (`note` says why).
  const shown: Pick<TakeoverRecord, "mode"> = body.mode === "clean" || body.mode === "tab" ? { mode: body.mode } : {};
  const live: TakeoverRecord = { ...current, ...shown, state: "live", startedAt: new Date().toISOString(), endsAt: typeof body.endsAt === "string" ? body.endsAt : endsAt };
  await write(app, live);
  await appendLedger({ userId: current.accountId, actor: "me", action: "node.takeover_started", payload: { takeoverId: current.id, deviceId: device.id } });
  return { takeover: publicTakeover(live), ...(typeof body.width === "number" ? { width: body.width } : {}), ...(typeof body.height === "number" ? { height: body.height } : {}), ...(typeof body.note === "string" && body.note.trim() ? { note: body.note.slice(0, 500) } : {}) };
}

/** The latest frame after `after`, waiting up to 20 s for one; or that the takeover ended, and why. */
export async function nextFrame(app: FastifyInstance, record: TakeoverRecord, after: number, signal?: AbortSignal): Promise<{ state: TakeoverRecord["state"]; reason?: string; frame: ChannelMessage | null }> {
  const deadline = Date.now() + FRAMES_WAIT_MS;
  let checked = 0;
  for (;;) {
    let current = (await read(app, record.id)) ?? { ...record, state: "ended" as const, reason: "expired" };
    if (Date.now() - checked > 2_000) {
      current = await stillGood(app, current);
      checked = Date.now();
    }
    if (current.state === "ended") return { state: "ended", reason: current.reason, frame: null };
    const raw = await redisOf(app).get(frameKey(record.id));
    const frame = raw ? (JSON.parse(raw) as ChannelMessage) : null;
    if ((frame && frame.seq > after) || Date.now() >= deadline || signal?.aborted) return { state: current.state, frame: frame && frame.seq > after ? frame : null };
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, Math.min(1_000, Math.max(0, deadline - Date.now())));
      function done() {
        clearTimeout(timer);
        fileAnswers.off(wake(record.id), done);
        resolve();
      }
      fileAnswers.once(wake(record.id), done);
    });
  }
}

/**
 * Input waiting to go to the computer, per takeover: the next number it expects, and messages that came
 * early (the page sends several at once, and their requests can overtake each other).
 */
type Relay = { next: number; early: Map<number, { deviceId: string; message: ChannelMessage }>; timer: NodeJS.Timeout | null };
const relays = new Map<string, Relay>();
/** A message that came before the one it follows waits this long for it; then the gap is skipped. */
export const INPUT_GAP_MS = 250;
const EARLY_MAX = 64;

function send(id: string, deviceId: string, message: ChannelMessage): void {
  publishDeviceFrame(deviceId, "takeover.input", { takeoverId: id, seq: message.seq, iv: message.iv, ct: message.ct });
}

/** Sends what waited, in order, from the next number on; `skip`: past a gap that did not fill in time. */
function flush(id: string, relay: Relay, skip: boolean): void {
  if (relay.timer) clearTimeout(relay.timer);
  relay.timer = null;
  for (;;) {
    let item = relay.early.get(relay.next);
    if (!item && skip && relay.early.size) {
      relay.next = Math.min(...relay.early.keys());
      item = relay.early.get(relay.next);
    }
    if (!item) break;
    relay.early.delete(relay.next);
    send(id, item.deviceId, item.message);
    relay.next += 1;
    skip = false;
  }
  if (relay.early.size) {
    relay.timer = setTimeout(() => flush(id, relay, true), INPUT_GAP_MS);
    relay.timer.unref();
  }
}

/**
 * Passes encrypted input on to the computer in sequence order: one that came early waits briefly for
 * those before it. One at or below what was sent already goes as it is (the computer refuses a replay).
 */
export async function relayInput(app: FastifyInstance, record: TakeoverRecord, message: ChannelMessage): Promise<void> {
  const current = await stillGood(app, record);
  if (current.state !== "live") throw new TakeoverError(current.state === "ended" ? "This takeover has ended." : "This takeover has not started.", 410, current.reason);
  let relay = relays.get(current.id);
  if (!relay) {
    relay = { next: 1, early: new Map(), timer: null };
    relays.set(current.id, relay);
  }
  if (message.seq < relay.next) return send(current.id, current.deviceId, message);
  relay.early.set(message.seq, { deviceId: current.deviceId, message });
  if (relay.early.size > EARLY_MAX) return flush(current.id, relay, true);
  flush(current.id, relay, false);
}

/**
 * The owner wants more time: its end moves 15 minutes later, at most an hour after it started; the
 * computer is told (`takeover.extend`, takeover 3).
 */
export async function extendTakeover(app: FastifyInstance, record: TakeoverRecord): Promise<{ takeover: ReturnType<typeof publicTakeover> }> {
  const current = await stillGood(app, record);
  if (current.state !== "live" || !current.endsAt) throw new TakeoverError(current.state === "ended" ? "This takeover has ended. Open the browser again." : "This takeover has not started.", 409, "state");
  const device = await app.prisma.device.findFirst({ where: { id: current.deviceId, revokedAt: null } });
  const caps = (device?.capabilities ?? {}) as { takeover?: unknown };
  if (!device || typeof caps.takeover !== "number" || caps.takeover < TAKEOVER_EXTEND_API) throw new TakeoverError(`Update Ensemble on ${current.computer} to keep its browser open longer.`, 409, "update");
  const started = Date.parse(current.startedAt ?? current.createdAt);
  const endsAt = Math.min(Date.parse(current.endsAt) + TAKEOVER_EXTEND_MS, started + TAKEOVER_LONGEST_MS);
  if (endsAt <= Date.parse(current.endsAt)) throw new TakeoverError("It is open for an hour at most. Open the browser again when it ends.", 409, "longest");
  const extended: TakeoverRecord = { ...current, endsAt: new Date(endsAt).toISOString() };
  await write(app, extended);
  // The tab stays this controller's until the new end.
  const lock = targetKey(current.deviceId, current.tab);
  if ((await redisOf(app).get(lock)) === current.id) await redisOf(app).set(lock, current.id, "EX", Math.ceil((endsAt - Date.now()) / 1000) + 60);
  publishDeviceFrame(current.deviceId, "takeover.extend", { takeoverId: current.id, endsAt: extended.endsAt });
  await appendLedger({ userId: current.accountId, actor: "me", action: "node.takeover_extended", payload: { takeoverId: current.id, deviceId: current.deviceId, endsAt: extended.endsAt } }).catch(() => undefined);
  return { takeover: publicTakeover(extended) };
}

/**
 * A live view's owner takes control (`on`) or goes back to watching (takeover 3, `takeover.control`):
 * control pauses the node on that tab, or makes its typing in that terminal wait. A sign-in's or a run's
 * takeover is always in control.
 */
export async function controlTakeover(app: FastifyInstance, record: TakeoverRecord, on: boolean): Promise<{ takeover: ReturnType<typeof publicTakeover> }> {
  const current = await stillGood(app, record);
  if (current.state !== "live") throw new TakeoverError(current.state === "ended" ? "This takeover has ended." : "This takeover has not started.", 410, current.reason);
  if (!current.liveCardId) throw new TakeoverError("You are already in control here.", 409, "control");
  const raw = await askDeviceFor(app.redis as never, { deviceId: current.deviceId, event: "takeover.control", data: { takeoverId: current.id, on } }, 20_000).catch(() => null);
  const answer = raw ? CodeAnswer.safeParse(raw) : null;
  const body = (answer?.success && answer.data.body && typeof answer.data.body === "object" ? answer.data.body : {}) as { view?: unknown; error?: unknown };
  if (!answer?.success || answer.data.status >= 400 || (body.view !== "watch" && body.view !== "control")) {
    if (answer?.success && answer.data.status === 410) await markEnded(app, current, "ended");
    throw new TakeoverError(typeof body.error === "string" ? body.error : `${current.computer} did not answer. Check Ensemble is running there.`, answer?.success && answer.data.status === 410 ? 410 : 502);
  }
  const next: TakeoverRecord = { ...current, view: body.view };
  await write(app, next);
  await appendLedger({ userId: current.accountId, actor: "me", action: "node.takeover_control", payload: { takeoverId: current.id, deviceId: current.deviceId, on } });
  return { takeover: publicTakeover(next) };
}

/**
 * Stop, or I'm done: the computer ends it; I'm done on a sign-in checks it there, and a signed-in card
 * wakes its node (node/logins.ts).
 */
export async function finishTakeover(app: FastifyInstance, record: TakeoverRecord, done: boolean): Promise<{ takeover: ReturnType<typeof publicTakeover>; signedIn: boolean | null; message?: string; card?: NodeMessage | null }> {
  const current = await stillGood(app, record);
  if (current.state === "ended") return { takeover: publicTakeover(current), signedIn: null };
  let signedIn: boolean | null = null;
  let message: string | undefined;
  if (current.state === "live") {
    const raw = await askDeviceFor(app.redis as never, { deviceId: current.deviceId, event: "takeover.end", data: { takeoverId: current.id, done, reason: done ? "done" : "stopped" } }, 60_000).catch(() => null);
    const answer = raw ? CodeAnswer.safeParse(raw) : null;
    const body = (answer?.success && answer.data.body && typeof answer.data.body === "object" ? answer.data.body : {}) as { signedIn?: unknown; message?: unknown };
    signedIn = typeof body.signedIn === "boolean" ? body.signedIn : null;
    message = typeof body.message === "string" ? body.message.slice(0, 300) : undefined;
  }
  const ended = await markEnded(app, current, done ? "done" : "stopped");
  const card = done && current.loginCardId ? await loginTakeoverEnded(app, current.accountId, current.loginCardId, signedIn, message) : null;
  return { takeover: publicTakeover(ended), signedIn, ...(message ? { message } : {}), card };
}

/** One frame from the computer: kept, opaque, for a few seconds, and the page waiting for it woken. */
export async function storeFrame(app: FastifyInstance, device: Pick<Device, "id">, id: string, message: ChannelMessage): Promise<"stored" | "gone"> {
  const record = await read(app, id);
  if (!record || record.deviceId !== device.id || record.state !== "live") return "gone";
  if (record.endsAt && Date.parse(record.endsAt) <= Date.now()) {
    await markEnded(app, record, "expired");
    return "gone";
  }
  await redisOf(app).set(frameKey(id), JSON.stringify({ seq: message.seq, iv: message.iv, ct: message.ct }), "EX", FRAME_TTL_SECONDS);
  publishFileAnswer(wake(id));
  return "stored";
}

/** The computer ended it itself (expired, idle, the tab closed). */
export async function deviceEnded(app: FastifyInstance, device: Pick<Device, "id">, id: string, reason: string): Promise<boolean> {
  const record = await read(app, id);
  if (!record || record.deviceId !== device.id) return false;
  await markEnded(app, record, reason.slice(0, 40));
  return true;
}
