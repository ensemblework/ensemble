/**
 * The owner controls a tab of this computer's browser from the web (design B21, docs/35 §8.16.2). On
 * `takeover.start` this computer opens the channel's secret from a box sealed in the owner's browser
 * for its key (purpose `takeover`, bound to the takeover and the tab, from a site it trusts, taken
 * once), derives one key per direction, marks the tab sensitive (no agent, model, capture, trace or live
 * view sees it) and streams it with Chromium's screencast: each frame encrypted for the owner's browser
 * and posted to the relay, which keeps only the latest for seconds. Input comes back encrypted, each
 * message with a sequence number: one not above the last accepted is refused, as is one that does not
 * open. A takeover ends on I'm done (which checks a sign-in and gives the tab back), Stop, its time
 * running out, nobody watching for a minute, the tab closing, or this computer no longer taking work
 * from the web. Typed keys and frames are never logged or kept here.
 */
import type { CDPSession, Page } from "playwright-core";
import { z } from "zod";
import { browserBroker } from "../browser/index.js";
import { trustedOrigins } from "../credentials/origins.js";
import { takeOnce } from "../credentials/replay.js";
import { checkAad, openSealed, SealError } from "../credentials/seal.js";
import { loadSealKey } from "../credentials/seal-key.js";
import { appendLedger } from "../lib/ledger.js";
import { env } from "../config.js";
import { remoteApiBase, type HostedClient } from "../remote/client.js";
import { TakeoverEnd, TakeoverInput, TakeoverStart, type ChannelMessage } from "../remote/contract.js";
import { loadSettings } from "../remote/store.js";
import { resolveLogin, waitingLogin } from "../logins/requests.js";
import { ChannelError, openMessage, packMessage, sealMessage, takeoverKeys, type ChannelKeys } from "./channel.js";

/** Nobody sent input or a ping for this long: the takeover ends. */
export const TAKEOVER_IDLE_MS = 60_000;

/** The longest a takeover lasts (`ENSEMBLE_TAKEOVER_SECONDS`, default 15 minutes). */
export function takeoverMaxMs(source: NodeJS.ProcessEnv = process.env): number {
  const seconds = Number(source.ENSEMBLE_TAKEOVER_SECONDS ?? 900);
  return Math.min(Math.max(Number.isFinite(seconds) ? seconds : 900, 2), 3600) * 1000;
}

const Point = { x: z.number().min(0).max(1), y: z.number().min(0).max(1) };
const InputEvent = z.discriminatedUnion("t", [
  z.object({ t: z.literal("mouse"), type: z.enum(["move", "down", "up"]), ...Point, button: z.enum(["left", "right", "middle"]).default("left"), clicks: z.number().int().min(1).max(3).default(1) }),
  z.object({ t: z.literal("wheel"), ...Point, dx: z.number().min(-5000).max(5000), dy: z.number().min(-5000).max(5000) }),
  z.object({ t: z.literal("key"), type: z.enum(["down", "up"]), key: z.string().min(1).max(40) }),
  z.object({ t: z.literal("text"), text: z.string().min(1).max(2000) }),
  z.object({ t: z.literal("ping") }),
]);
const InputBatch = z.object({ events: z.array(InputEvent).max(100) });
type InputEvent = z.infer<typeof InputEvent>;

const Payload = z.object({ k: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();

type Session = {
  id: string;
  tab: string;
  loginId: string | null;
  keys: ChannelKeys;
  client: HostedClient;
  page: Page;
  cdp: CDPSession;
  /** The tab was not sensitive before: it is given back when the takeover ends. */
  marked: boolean;
  inSeq: number;
  outSeq: number;
  refused: number;
  applied: number;
  frames: number;
  lastInput: number;
  viewport: { width: number; height: number };
  pending: { jpeg: Buffer; width: number; height: number } | null;
  sending: boolean;
  queue: Promise<void>;
  timers: NodeJS.Timeout[];
  ended: boolean;
};

const sessions = new Map<string, Session>();

const ledger = (action: string, payload: Record<string, string | number | boolean | null>) => appendLedger({ userId: env.ENSEMBLE_DEV_USER_ID, actor: "me", action, payload }).catch(() => undefined);

/** What a takeover did, for tests and the computer's own checks: counts only, never what was typed or shown. */
export function takeoverStats(id: string): { inSeq: number; outSeq: number; refused: number; applied: number; frames: number } | null {
  const session = sessions.get(id);
  return session ? { inSeq: session.inSeq, outSeq: session.outSeq, refused: session.refused, applied: session.applied, frames: session.frames } : null;
}

/** The secret in a start box, checked: for this computer, its key, this takeover and tab, a site it trusts, unexpired. */
function openStartBox(frame: TakeoverStart, now = Date.now()): { secret: Buffer; nonce: string; expiresAt: string } {
  const key = loadSealKey();
  if (!key) throw new SealError("key", "This computer has no key for the takeover. Update Ensemble here, or pair it again.");
  const settings = loadSettings();
  const deviceId = settings.deviceId ?? key.deviceId;
  if (!deviceId) throw new SealError("device", "This computer does not know its own id. Pair it again.");
  const { aad, plaintext } = openSealed(frame.sealed, { kid: key.info.kid, privateKey: key.privateKey });
  try {
    checkAad(aad, { deviceId, kid: key.info.kid, decisionId: frame.takeoverId, purpose: "takeover", name: frame.tab, origins: trustedOrigins(remoteApiBase() ?? settings.apiBase), now });
    let payload: z.infer<typeof Payload>;
    try {
      payload = Payload.parse(JSON.parse(plaintext.toString("utf8")));
    } catch {
      throw new SealError("shape", "The takeover's key could not be read.");
    }
    return { secret: Buffer.from(payload.k, "base64url"), nonce: aad.nonce, expiresAt: aad.expiresAt };
  } finally {
    plaintext.fill(0);
  }
}

/** Sends the latest frame, one at a time: a frame that waits is replaced by a newer one. */
async function pump(session: Session): Promise<void> {
  if (session.sending) return;
  session.sending = true;
  try {
    while (session.pending && !session.ended) {
      const next = session.pending;
      session.pending = null;
      session.outSeq += 1;
      const url = session.page.isClosed() ? "" : session.page.url();
      const message = sealMessage(session.keys.d2w, session.id, "d2w", session.outSeq, packMessage({ t: "frame", w: next.width, h: next.height, url: url.split(/[?#]/)[0]!.slice(0, 500) }, next.jpeg));
      const sent = session.client.takeoverFrame ? await session.client.takeoverFrame(session.id, message).catch(() => true) : false;
      session.frames += 1;
      if (!sent) {
        await endTakeover(session.id, { done: false, reason: "relay_gone", tell: false });
        return;
      }
    }
  } finally {
    session.sending = false;
  }
}

/** A key as Playwright names it, held or let go; a printable character without a modifier is typed as text. */
async function applyKey(session: Session, event: Extract<InputEvent, { t: "key" }>, held: Set<string>): Promise<void> {
  const keyboard = session.page.keyboard;
  const modifier = ["Control", "Meta", "Alt"].some((name) => held.has(name));
  if (event.key.length === 1 && !modifier) {
    if (event.type === "down") await keyboard.insertText(event.key);
    return;
  }
  if (event.type === "down") {
    held.add(event.key);
    await keyboard.down(event.key);
  } else {
    held.delete(event.key);
    await keyboard.up(event.key);
  }
}

const heldKeys = new WeakMap<Session, Set<string>>();

async function apply(session: Session, event: InputEvent): Promise<void> {
  const page = session.page;
  const { width, height } = session.viewport;
  if (event.t === "ping") return;
  if (event.t === "text") return page.keyboard.insertText(event.text);
  if (event.t === "key") {
    const held = heldKeys.get(session) ?? new Set<string>();
    heldKeys.set(session, held);
    return applyKey(session, event, held);
  }
  const x = Math.round(event.x * width);
  const y = Math.round(event.y * height);
  if (event.t === "wheel") {
    await page.mouse.move(x, y);
    return page.mouse.wheel(event.dx, event.dy);
  }
  await page.mouse.move(x, y);
  if (event.type === "down") await page.mouse.down({ button: event.button, clickCount: event.clicks });
  if (event.type === "up") await page.mouse.up({ button: event.button, clickCount: event.clicks });
}

/**
 * Starts a takeover of a tab: a sign-in's (`loginId`, its tab) or a run's (`operation`, the run's local
 * job, which owns the tab). Returns the answer for the web.
 */
export async function startTakeover(client: HostedClient, frame: TakeoverStart, runOperation: (hostedJobId: string) => string | null): Promise<{ status: number; body: Record<string, unknown> }> {
  if (sessions.has(frame.takeoverId)) return { status: 409, body: { error: "That takeover has started already." } };
  if ([...sessions.values()].some((session) => session.tab === frame.tab)) return { status: 409, body: { error: "Someone already controls that tab." } };
  const broker = browserBroker();
  let tab;
  try {
    tab = broker.ownerTab(frame.tab);
  } catch {
    return { status: 410, body: { error: "That tab is closed." } };
  }
  if (frame.loginId) {
    const login = waitingLogin(frame.loginId);
    if (!login || login.tab !== frame.tab) return { status: 410, body: { error: "That sign-in is no longer waiting on this computer." } };
  } else if (frame.jobId) {
    const operation = runOperation(frame.jobId);
    if (!operation || tab.operation !== operation) return { status: 404, body: { error: "That tab is not this run's." } };
  } else {
    return { status: 400, body: { error: "Name the sign-in or the run whose tab to open." } };
  }
  let box;
  try {
    box = openStartBox(frame);
  } catch (error) {
    if (error instanceof SealError) return { status: error.statusCode, body: { error: error.message, code: `seal_${error.code}` } };
    throw error;
  }
  try {
    return await takeOnce({ decisionId: frame.takeoverId, nonce: box.nonce, expiresAt: box.expiresAt }, async () => {
      const keys = takeoverKeys(box.secret, frame.takeoverId);
      box.secret.fill(0);
      const marked = !tab.sensitive;
      if (marked) await broker.markSensitive(frame.tab, true);
      const cdp = await tab.context.newCDPSession(tab.page);
      const size = tab.page.viewportSize() ?? { width: 1280, height: 800 };
      const session: Session = {
        id: frame.takeoverId,
        tab: frame.tab,
        loginId: frame.loginId ?? null,
        keys,
        client,
        page: tab.page,
        cdp,
        marked,
        inSeq: 0,
        outSeq: 0,
        refused: 0,
        applied: 0,
        frames: 0,
        lastInput: Date.now(),
        viewport: size,
        pending: null,
        sending: false,
        queue: Promise.resolve(),
        timers: [],
        ended: false,
      };
      sessions.set(session.id, session);
      cdp.on("Page.screencastFrame", (event: { data: string; sessionId: number; metadata: { deviceWidth?: number; deviceHeight?: number } }) => {
        void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => undefined);
        if (session.ended) return;
        const width = Math.round(event.metadata.deviceWidth ?? session.viewport.width);
        const height = Math.round(event.metadata.deviceHeight ?? session.viewport.height);
        session.viewport = { width, height };
        session.pending = { jpeg: Buffer.from(event.data, "base64"), width, height };
        void pump(session);
      });
      tab.page.once("close", () => void endTakeover(session.id, { done: false, reason: "tab_closed", tell: true }));
      const endsAt = Math.min(Date.parse(frame.endsAt) || Infinity, Date.now() + takeoverMaxMs());
      const deadline = setTimeout(() => void endTakeover(session.id, { done: false, reason: "expired", tell: true }), Math.max(0, endsAt - Date.now()));
      const idle = setInterval(() => {
        if (Date.now() - session.lastInput > TAKEOVER_IDLE_MS) void endTakeover(session.id, { done: false, reason: "idle", tell: true });
        else broker.keepTab(session.tab, TAKEOVER_IDLE_MS * 5);
      }, Math.min(10_000, TAKEOVER_IDLE_MS / 2));
      deadline.unref();
      idle.unref();
      session.timers.push(deadline, idle);
      broker.keepTab(session.tab, TAKEOVER_IDLE_MS * 5);
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 1280, everyNthFrame: 1 });
      await ledger("takeover.started", { takeoverId: session.id, tab: session.tab, login: Boolean(session.loginId) });
      return { status: 200, body: { started: true, width: size.width, height: size.height, endsAt: new Date(endsAt).toISOString() } };
    });
  } catch (error) {
    box.secret.fill(0);
    if (error instanceof SealError) return { status: error.statusCode, body: { error: error.message, code: `seal_${error.code}` } };
    return { status: 500, body: { error: error instanceof Error ? error.message.split("\n")[0]!.slice(0, 300) : "The takeover could not start." } };
  }
}

/** Input from the owner's browser: applied in order, once; anything replayed, out of order or changed is refused. */
export function takeoverInput(data: unknown): void {
  const parsed = TakeoverInput.safeParse(data);
  if (!parsed.success) return;
  const session = sessions.get(parsed.data.takeoverId);
  if (!session || session.ended) return;
  const message: ChannelMessage = { seq: parsed.data.seq, iv: parsed.data.iv, ct: parsed.data.ct };
  if (message.seq <= session.inSeq) {
    session.refused += 1;
    return;
  }
  let events: InputEvent[];
  try {
    const plaintext = openMessage(session.keys.w2d, session.id, "w2d", message);
    events = InputBatch.parse(JSON.parse(plaintext.toString("utf8"))).events;
    plaintext.fill(0);
  } catch (error) {
    if (error instanceof ChannelError || error instanceof z.ZodError || error instanceof SyntaxError) {
      session.refused += 1;
      return;
    }
    throw error;
  }
  session.inSeq = message.seq;
  session.lastInput = Date.now();
  session.queue = session.queue.then(async () => {
    for (const event of events) {
      if (session.ended) return;
      await apply(session, event).catch(() => undefined);
      session.applied += 1;
    }
  });
}

/**
 * Ends a takeover. `done`: the owner pressed I'm done; a sign-in's tab is checked (logins/requests.ts)
 * and given back when it is signed in. Otherwise a tab this takeover made sensitive is given back as it
 * is. `tell`: this computer ended it itself, so the relay hears why.
 */
export async function endTakeover(id: string, input: { done: boolean; reason: string; tell: boolean }): Promise<{ ended: boolean; signedIn: boolean | null; message?: string }> {
  const session = sessions.get(id);
  if (!session || session.ended) return { ended: false, signedIn: null };
  session.ended = true;
  sessions.delete(id);
  for (const timer of session.timers) clearTimeout(timer);
  await session.queue.catch(() => undefined);
  for (const key of heldKeys.get(session) ?? []) await session.page.keyboard.up(key).catch(() => undefined);
  await session.cdp.send("Page.stopScreencast").catch(() => undefined);
  await session.cdp.detach().catch(() => undefined);
  let signedIn: boolean | null = null;
  let message: string | undefined;
  if (session.loginId && input.done) {
    const result = await resolveLogin(session.loginId, "done");
    signedIn = result.status === "signed_in";
    message = result.message;
  } else if (session.marked) {
    await browserBroker().markSensitive(session.tab, false).catch(() => undefined);
  }
  await ledger("takeover.ended", { takeoverId: id, reason: input.reason, inputs: session.applied, refused: session.refused, signedIn });
  if (input.tell) await session.client.takeoverState?.(id, { state: "ended", reason: input.reason }).catch(() => undefined);
  return { ended: true, signedIn, ...(message ? { message } : {}) };
}

/** Ends every takeover: this computer stopped taking work from the web. */
export async function endAllTakeovers(reason: string): Promise<void> {
  for (const id of [...sessions.keys()]) await endTakeover(id, { done: false, reason, tell: true });
}

/** `takeover.start` from the event stream: answered once. */
export async function answerTakeoverStart(client: HostedClient, data: unknown, runOperation: (hostedJobId: string) => string | null): Promise<void> {
  const id = (data as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || !id) return;
  const parsed = TakeoverStart.safeParse(data);
  await client.answerCode(id, parsed.success ? await startTakeover(client, parsed.data, runOperation) : { status: 400, body: { error: "That takeover could not be read. Update Ensemble on this computer." } });
}

/** `takeover.end` from the event stream; answered when the relay waits for it (I'm done). */
export async function answerTakeoverEnd(client: HostedClient, data: unknown): Promise<void> {
  const parsed = TakeoverEnd.safeParse(data);
  if (!parsed.success) return;
  const ended = await endTakeover(parsed.data.takeoverId, { done: parsed.data.done, reason: parsed.data.reason ?? (parsed.data.done ? "done" : "stopped"), tell: false });
  if (parsed.data.id) await client.answerCode(parsed.data.id, { status: 200, body: ended });
}
