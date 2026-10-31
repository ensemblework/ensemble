/**
 * The owner controls a tab of this computer's browser from the web (design B21, docs/35 §8.16.2). On
 * `takeover.start` this computer opens the channel's secret from a box sealed in the owner's browser
 * for its key (purpose `takeover`, bound to the takeover and the tab, from a site it trusts, taken
 * once), derives one key per direction, marks the tab sensitive (no agent, model, capture, trace or live
 * view sees it) and streams it with Chromium's screencast: each frame encrypted for the owner's browser
 * and posted to the relay, which keeps only the latest for seconds. A sign-in's takeover streams a
 * clean browser instead (logins/clean-signin.ts: Google and Cloudflare refuse the node's own browser),
 * opened at the tab's page, following the popups a page opens; its frames say which site they show.
 * When the clean browser cannot start here, the tab itself is streamed, and the answer says why. Input
 * comes back encrypted, each message with a sequence number: one not above the last accepted is
 * refused, as is one that does not open. A takeover ends on I'm done (which checks a sign-in and gives
 * the tab back), Stop, the sign-in seen done (its session moved into the tab), its time running out,
 * nobody watching for a minute, the tab closing, or this computer no longer taking work from the web.
 * Typed keys and frames are never logged or kept here.
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
import { TAKEOVER_LONGEST_MS, TakeoverControl, TakeoverEnd, TakeoverExtend, TakeoverInput, TakeoverStart, type ChannelMessage } from "../remote/contract.js";
import { loadSettings } from "../remote/store.js";
import type { CleanFrame, CleanSignIn } from "../logins/clean-signin.js";
import { closeCleanSignIn, loginEvents, markLoginControlled, openCleanSignIn, resolveLogin, waitingLogin, type LoginOutcome } from "../logins/requests.js";
import { ChannelError, openMessage, packMessage, sealMessage, takeoverKeys, type ChannelKeys } from "./channel.js";
import { controlTerminalView, endAllTerminalViews, endTerminalView, extendTerminalView, isTerminalView, startTerminalView, terminalViewInput } from "./terminal-view.js";

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

/** What a frame's header says beside its size: the page's address (without its query), host and title, whether it is a popup, and the mode. */
type FrameMeta = { url: string; site: string; title: string; popup: boolean };

type Session = {
  id: string;
  tab: string;
  loginId: string | null;
  keys: ChannelKeys;
  client: HostedClient;
  /** `clean`: a sign-in in the clean browser; `tab`: the tab itself. */
  mode: "clean" | "tab";
  page: Page;
  cdp: CDPSession | null;
  clean: CleanSignIn | null;
  /** The tab was not sensitive before: it is given back when the takeover ends. */
  marked: boolean;
  /** A live view of a node's tab (`capabilities.live`): `watch` shows it while the node works and ignores input; `control` pauses the node on it. */
  live: boolean;
  view: "watch" | "control";
  inSeq: number;
  outSeq: number;
  refused: number;
  applied: number;
  frames: number;
  lastInput: number;
  viewport: { width: number; height: number };
  pending: { jpeg: Buffer; width: number; height: number; meta: FrameMeta | null } | null;
  sending: boolean;
  queue: Promise<void>;
  timers: NodeJS.Timeout[];
  /** When it started, and its end (`takeover.extend` moves it, never past an hour after the start). */
  startedAt: number;
  endsAt: number;
  deadline: NodeJS.Timeout | null;
  ended: boolean;
};

const sessions = new Map<string, Session>();

const ledger = (action: string, payload: Record<string, string | number | boolean | null>) => appendLedger({ userId: env.ENSEMBLE_DEV_USER_ID, actor: "me", action, payload }).catch(() => undefined);

/** What a takeover did, for tests and the computer's own checks: counts only, never what was typed or shown. */
export function takeoverStats(id: string): { inSeq: number; outSeq: number; refused: number; applied: number; frames: number; mode: "clean" | "tab"; endsAt: string } | null {
  const session = sessions.get(id);
  return session ? { inSeq: session.inSeq, outSeq: session.outSeq, refused: session.refused, applied: session.applied, frames: session.frames, mode: session.mode, endsAt: new Date(session.endsAt).toISOString() } : null;
}

/** The clean browser a takeover shows, for tests. */
export function takeoverCleanSignIn(id: string): CleanSignIn | null {
  return sessions.get(id)?.clean ?? null;
}

// A sign-in seen done (its session moved into the tab) ends the takeover showing it; so does its clean browser closing.
loginEvents.on("finished", (outcome: LoginOutcome) => {
  for (const session of sessions.values()) {
    if (session.loginId !== outcome.loginId || session.ended) continue;
    void endTakeover(session.id, { done: false, reason: outcome.status === "signed_in" || outcome.status === "passed" ? outcome.status : "ended", tell: true });
  }
});
loginEvents.on("cleanClosed", (event: { loginId: string; reason: string }) => {
  for (const session of sessions.values()) {
    if (session.loginId !== event.loginId || session.mode !== "clean" || session.ended) continue;
    void endTakeover(session.id, { done: false, reason: event.reason === "not_carried" ? "not_carried" : "closed", tell: true });
  }
});

/** The secret in a start box, checked: for this computer, its key, this takeover and tab, a site it trusts, unexpired. */
export function openStartBox(frame: TakeoverStart, now = Date.now()): { secret: Buffer; nonce: string; expiresAt: string } {
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
      const meta = next.meta ?? tabMeta(session);
      const header = { t: "frame", w: next.width, h: next.height, url: meta.url.split(/[?#]/)[0]!.slice(0, 500), site: meta.site.slice(0, 200), title: meta.title.slice(0, 200), popup: meta.popup, mode: session.mode };
      const message = sealMessage(session.keys.d2w, session.id, "d2w", session.outSeq, packMessage(header, next.jpeg));
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

function tabMeta(session: Session): FrameMeta {
  const url = session.page.isClosed() ? "" : session.page.url();
  let site = "";
  try {
    site = /^https?:/.test(url) ? new URL(url).hostname : "";
  } catch {
    site = "";
  }
  return { url, site, title: "", popup: false };
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
  // Watching: the node keeps the tab; only control takes the owner's input.
  if (session.view === "watch") return;
  if (session.clean) return session.clean.input(event);
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
  if (frame.kind === "terminal") return startTerminalView(client, frame, openStartBox, takeoverMaxMs());
  if (sessions.has(frame.takeoverId)) return { status: 409, body: { error: "That takeover has started already." } };
  // The owner watching the tab live makes way for its sign-in: they sign in in its remote view instead.
  const watching = frame.loginId ? [...sessions.values()].find((session) => session.tab === frame.tab && session.live && session.view === "watch" && !session.ended) : undefined;
  if (watching) await endTakeover(watching.id, { done: false, reason: "sign_in", tell: true });
  if ([...sessions.values()].some((session) => session.tab === frame.tab)) return { status: 409, body: { error: "Someone already controls that tab." } };
  const broker = browserBroker();
  // A tab whose browser is restarting, or that is being opened again after its browser closed, is waited for.
  await broker.whenTab(frame.tab, 20_000);
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
  } else if (frame.operation) {
    if (tab.operation !== frame.operation) return { status: 404, body: { error: "That tab is not the node's." } };
  } else {
    return { status: 400, body: { error: "Name the sign-in or the run whose tab to open." } };
  }
  const watch = frame.view === "watch" && !frame.loginId;
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
      // A sign-in is done in the clean browser; the tab itself only when that cannot start here.
      let clean: CleanSignIn | null = null;
      let note: string | undefined;
      if (frame.loginId && cleanSignInOn()) {
        try {
          clean = await openCleanSignIn(frame.loginId, "takeover");
        } catch (error) {
          note = `Ensemble's sign-in browser could not start here (${error instanceof Error ? error.message.split("\n")[0]!.slice(0, 200) : "unknown"}), so this shows the node's own browser: some sites (Google) may refuse to sign in there.`;
        }
      }
      // Watching leaves the tab to the node; control pauses it for the node, as a sign-in does.
      const marked = !watch && !tab.sensitive;
      if (!watch) broker.markControlled(frame.tab, true);
      if (marked) await broker.markSensitive(frame.tab, true);
      const cdp = clean ? null : await tab.context.newCDPSession(tab.page);
      const session: Session = {
        id: frame.takeoverId,
        tab: frame.tab,
        loginId: frame.loginId ?? null,
        keys,
        client,
        mode: clean ? "clean" : "tab",
        page: tab.page,
        cdp,
        clean,
        marked,
        live: !frame.loginId && !frame.jobId,
        view: watch ? "watch" : "control",
        inSeq: 0,
        outSeq: 0,
        refused: 0,
        applied: 0,
        frames: 0,
        lastInput: Date.now(),
        viewport: tab.page.viewportSize() ?? { width: 1280, height: 800 },
        pending: null,
        sending: false,
        queue: Promise.resolve(),
        timers: [],
        startedAt: Date.now(),
        endsAt: 0,
        deadline: null,
        ended: false,
      };
      sessions.set(session.id, session);
      if (frame.loginId && !clean) markLoginControlled(frame.loginId, true);
      tab.page.once("close", () => void endTakeover(session.id, { done: false, reason: "tab_closed", tell: true }));
      const endsAt = Math.min(Date.parse(frame.endsAt) || Infinity, Date.now() + takeoverMaxMs());
      endAt(session, endsAt);
      const idle = setInterval(() => {
        if (Date.now() - session.lastInput > TAKEOVER_IDLE_MS) void endTakeover(session.id, { done: false, reason: "idle", tell: true });
        else broker.keepTab(session.tab, TAKEOVER_IDLE_MS * 5);
      }, Math.min(10_000, TAKEOVER_IDLE_MS / 2));
      idle.unref();
      session.timers.push(idle);
      broker.keepTab(session.tab, TAKEOVER_IDLE_MS * 5);
      try {
        if (clean) {
          clean.on("frame", (shown: CleanFrame) => {
            if (session.ended) return;
            session.viewport = { width: shown.width || session.viewport.width, height: shown.height || session.viewport.height };
            session.pending = { jpeg: shown.jpeg, width: session.viewport.width, height: session.viewport.height, meta: { url: shown.url, site: shown.site, title: shown.title, popup: shown.popup } };
            void pump(session);
          });
          session.viewport = await clean.startStreaming();
        } else {
          cdp!.on("Page.screencastFrame", (event: { data: string; sessionId: number; metadata: { deviceWidth?: number; deviceHeight?: number } }) => {
            void cdp!.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => undefined);
            if (session.ended) return;
            const width = Math.round(event.metadata.deviceWidth ?? session.viewport.width);
            const height = Math.round(event.metadata.deviceHeight ?? session.viewport.height);
            session.viewport = { width, height };
            session.pending = { jpeg: Buffer.from(event.data, "base64"), width, height, meta: null };
            void pump(session);
          });
          await cdp!.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 1280, everyNthFrame: 1 });
        }
      } catch (error) {
        await endTakeover(session.id, { done: false, reason: "failed", tell: false });
        throw error;
      }
      await ledger("takeover.started", { takeoverId: session.id, tab: session.tab, login: Boolean(session.loginId), mode: session.mode, view: session.view });
      return { status: 200, body: { started: true, width: session.viewport.width, height: session.viewport.height, endsAt: new Date(endsAt).toISOString(), mode: session.mode, view: session.view, ...(note ? { note } : {}) } };
    });
  } catch (error) {
    box.secret.fill(0);
    if (error instanceof SealError) return { status: error.statusCode, body: { error: error.message, code: `seal_${error.code}` } };
    return { status: 500, body: { error: error instanceof Error ? error.message.split("\n")[0]!.slice(0, 300) : "The takeover could not start." } };
  }
}

/** Sets when a takeover ends on its time. */
function endAt(session: Session, endsAt: number): void {
  if (session.deadline) clearTimeout(session.deadline);
  session.endsAt = endsAt;
  session.deadline = setTimeout(() => void endTakeover(session.id, { done: false, reason: "expired", tell: true }), Math.max(0, endsAt - Date.now()));
  session.deadline.unref();
}

/** `takeover.extend` (takeover 3): the owner asked for more time; never past an hour after it started. A terminal view too. */
export function takeoverExtend(data: unknown): { endsAt: string } | null {
  const parsed = TakeoverExtend.safeParse(data);
  if (!parsed.success) return null;
  if (extendTerminalView(parsed.data.takeoverId, parsed.data.endsAt)) return { endsAt: parsed.data.endsAt };
  const session = sessions.get(parsed.data.takeoverId);
  const wanted = Date.parse(parsed.data.endsAt);
  if (!session || session.ended || !Number.isFinite(wanted)) return null;
  const endsAt = Math.min(wanted, session.startedAt + TAKEOVER_LONGEST_MS);
  if (endsAt > session.endsAt) {
    endAt(session, endsAt);
    void ledger("takeover.extended", { takeoverId: session.id, endsAt: new Date(endsAt).toISOString() });
  }
  return { endsAt: new Date(session.endsAt).toISOString() };
}

/** Whether a sign-in's takeover uses the clean browser (`ENSEMBLE_CLEAN_SIGNIN=off` shows the tab itself). */
function cleanSignInOn(source: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(?:0|off|false|no)$/i.test(source.ENSEMBLE_CLEAN_SIGNIN?.trim() ?? "");
}

/** Input from the owner's browser: applied in order, once; anything replayed, out of order or changed is refused. */
export function takeoverInput(data: unknown): void {
  const parsed = TakeoverInput.safeParse(data);
  if (!parsed.success) return;
  if (terminalViewInput(parsed.data)) return;
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
  if (session.clean) {
    // The clean browser takes them at once, in order (one round trip for a burst of keys); they are counted as they land.
    const landed = session.clean.inputs(events).catch(() => undefined);
    session.queue = session.queue.then(async () => {
      await landed;
      session.applied += events.length;
    });
    return;
  }
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
  if (isTerminalView(id)) return endTerminalView(id, input);
  const session = sessions.get(id);
  if (!session || session.ended) return { ended: false, signedIn: null };
  session.ended = true;
  sessions.delete(id);
  for (const timer of session.timers) clearTimeout(timer);
  if (session.deadline) clearTimeout(session.deadline);
  await session.queue.catch(() => undefined);
  for (const key of heldKeys.get(session) ?? []) await session.page.keyboard.up(key).catch(() => undefined);
  if (session.cdp) {
    await session.cdp.send("Page.stopScreencast").catch(() => undefined);
    await session.cdp.detach().catch(() => undefined);
  }
  if (session.clean) await session.clean.stopStreaming().catch(() => undefined);
  if (session.loginId && session.mode === "tab") markLoginControlled(session.loginId, false);
  browserBroker().markControlled(session.tab, false);
  let signedIn: boolean | null = null;
  let message: string | undefined;
  if (session.loginId && input.done) {
    // I'm done: the clean browser's page (or the tab) is checked; done, its session moves into the tab.
    const result = await resolveLogin(session.loginId, "done", undefined, { via: "takeover" });
    signedIn = result.status === "signed_in" || result.status === "passed";
    message = result.message;
  } else if (session.marked && !session.loginId) {
    await browserBroker().markSensitive(session.tab, false).catch(() => undefined);
  }
  // A sign-in that still waits keeps its tab paused for its card; its clean browser closes (it stays warm for the next one).
  if (session.loginId && session.clean) await closeCleanSignIn(session.loginId, input.reason).catch(() => undefined);
  await ledger("takeover.ended", { takeoverId: id, reason: input.reason, inputs: session.applied, refused: session.refused, signedIn });
  if (input.tell) await session.client.takeoverState?.(id, { state: "ended", reason: input.reason }).catch(() => undefined);
  return { ended: true, signedIn, ...(message ? { message } : {}) };
}

/** Ends every takeover: this computer stopped taking work from the web. */
export async function endAllTakeovers(reason: string): Promise<void> {
  for (const id of [...sessions.keys()]) await endTakeover(id, { done: false, reason, tell: true });
  await endAllTerminalViews(reason);
}

/**
 * The owner of a live view takes control of the node's tab (it is paused for the node, as in a
 * sign-in's takeover, and their input is applied) or hands it back. Null when there is no such view.
 */
export async function controlTakeover(id: string, on: boolean): Promise<"watch" | "control" | null> {
  const terminal = controlTerminalView(id, on);
  if (terminal) return terminal;
  const session = sessions.get(id);
  if (!session || session.ended) return null;
  // A sign-in or a run's takeover is always in control.
  if (!session.live) return "control";
  await session.queue.catch(() => undefined);
  const broker = browserBroker();
  if (on && session.view === "watch") {
    broker.markControlled(session.tab, true);
    let sensitive = true;
    try {
      sensitive = broker.ownerTab(session.tab).sensitive;
    } catch {
      sensitive = true;
    }
    if (!sensitive) {
      await broker.markSensitive(session.tab, true);
      session.marked = true;
    }
    session.view = "control";
  } else if (!on && session.view === "control") {
    for (const key of heldKeys.get(session) ?? []) await session.page.keyboard.up(key).catch(() => undefined);
    heldKeys.delete(session);
    broker.markControlled(session.tab, false);
    if (session.marked) await broker.markSensitive(session.tab, false).catch(() => undefined);
    session.marked = false;
    session.view = "watch";
  }
  session.lastInput = Date.now();
  await ledger("takeover.control", { takeoverId: id, on });
  return session.view;
}

/** `takeover.control` from the event stream (takeover 3): answered with the view now. */
export async function answerTakeoverControl(client: HostedClient, data: unknown): Promise<void> {
  const parsed = TakeoverControl.safeParse(data);
  if (!parsed.success) {
    const id = (data as { id?: unknown } | null)?.id;
    if (typeof id === "string" && id) await client.answerCode(id, { status: 400, body: { error: "That could not be read. Update Ensemble on this computer." } });
    return;
  }
  const view = await controlTakeover(parsed.data.takeoverId, parsed.data.on);
  await client.answerCode(parsed.data.id, view ? { status: 200, body: { view } } : { status: 410, body: { error: "That live view has ended." } });
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
