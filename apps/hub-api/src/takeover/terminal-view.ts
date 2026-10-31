/**
 * A node's live terminal shown to its owner on the web (docs/35 §8.17), over the takeover's sealed
 * channel (takeover/session.ts, channel.ts): the same start box sealed in the owner's browser for this
 * computer (the session's id as its `name`), one key per direction, a frame only their browser opens.
 * Each frame is the whole screen as runs of cells (`TerminalFrameHeader` and `TerminalScreen`, secrets
 * hidden as capture/screen.ts hides them), sent when the screen changed, at most 15 a second; the relay
 * keeps only the latest. The owner types in it whether watching or in control (it is their shell);
 * control makes the node's typing wait. Input is refused unless its number is above the last one taken
 * and it opens. It ends on Stop, its time, a minute with no input or ping, the session ending, or this
 * computer no longer taking work from the web. What is typed or shown is never logged or kept here.
 */
import { z } from "zod";
import { takeOnce } from "../credentials/replay.js";
import { SealError } from "../credentials/seal.js";
import { env } from "../config.js";
import { screenRows } from "../capture/screen.js";
import { appendLedger } from "../lib/ledger.js";
import type { HostedClient } from "../remote/client.js";
import { TerminalInputEvent, type ChannelMessage, type TakeoverInput, type TakeoverStart, type TerminalFrameHeader, type TerminalScreen } from "../remote/contract.js";
import { controlSession, ownerKey, ownerType, resizeSession, terminalSession, watchSession, type SessionChange, type TerminalSession } from "../device-tools/terminal-sessions.js";
import { ChannelError, openMessage, packMessage, sealMessage, takeoverKeys, type ChannelKeys } from "./channel.js";

/** At most this many frames a second. */
export const TERMINAL_FPS = 15;
/** Nobody sent input or a ping for this long: the view ends (as a takeover does). */
const IDLE_MS = 60_000;
/** The relay takes frames once the web has the start's answer: one refused before then is sent again. */
const STARTING_MS = 10_000;

type View = {
  id: string;
  session: TerminalSession;
  keys: ChannelKeys;
  client: HostedClient;
  view: "watch" | "control";
  inSeq: number;
  outSeq: number;
  refused: number;
  applied: number;
  frames: number;
  lastInput: number;
  lastSent: number;
  lastFrame: string;
  startedAt: number;
  scheduled: NodeJS.Timeout | null;
  retry: NodeJS.Timeout | null;
  sending: boolean;
  again: boolean;
  queue: Promise<void>;
  timers: NodeJS.Timeout[];
  deadline: NodeJS.Timeout | null;
  stop: () => void;
  ended: boolean;
};

const views = new Map<string, View>();

const InputBatch = z.object({ events: z.array(z.unknown()).max(100) });

const ledger = (action: string, payload: Record<string, string | number | boolean | null>) => appendLedger({ userId: env.ENSEMBLE_DEV_USER_ID, actor: "me", action, payload }).catch(() => undefined);

/** What a terminal view did, for tests: counts only, never what was typed or shown. */
export function terminalViewStats(id: string): { inSeq: number; outSeq: number; refused: number; applied: number; frames: number; view: "watch" | "control" } | null {
  const view = views.get(id);
  return view ? { inSeq: view.inSeq, outSeq: view.outSeq, refused: view.refused, applied: view.applied, frames: view.frames, view: view.view } : null;
}

/** The screen as a frame: header and payload, secrets hidden. */
export function terminalFrame(session: TerminalSession): { header: TerminalFrameHeader; screen: TerminalScreen } {
  const buffer = session.term.buffer.active;
  const { rows } = screenRows(session.term, session.rules);
  return {
    header: { t: "frame", kind: "terminal", cols: session.term.cols, rows: session.term.rows, cursor: { x: buffer.cursorX, y: buffer.cursorY }, title: session.title.slice(0, 200) },
    screen: { rows },
  };
}

/** Sends the screen if it changed since the last frame, one at a time. */
async function sendFrame(view: View): Promise<void> {
  if (view.ended) return;
  if (view.sending) {
    view.again = true;
    return;
  }
  view.sending = true;
  try {
    do {
      view.again = false;
      const { header, screen } = terminalFrame(view.session);
      const body = JSON.stringify(screen);
      const key = `${JSON.stringify(header)}${body}`;
      if (key === view.lastFrame) continue;
      view.lastFrame = key;
      view.lastSent = Date.now();
      view.outSeq += 1;
      const message = sealMessage(view.keys.d2w, view.id, "d2w", view.outSeq, packMessage(header, Buffer.from(body, "utf8")));
      const sent = view.client.takeoverFrame ? await view.client.takeoverFrame(view.id, message).catch(() => true) : false;
      view.frames += 1;
      if (!sent && Date.now() - view.startedAt < STARTING_MS) {
        view.lastFrame = "";
        view.retry = setTimeout(() => void sendFrame(view), 250);
        return;
      }
      if (!sent) {
        await endTerminalView(view.id, { done: false, reason: "relay_gone", tell: false });
        return;
      }
    } while (view.again && !view.ended);
  } finally {
    view.sending = false;
  }
}

/** A frame soon: at most `TERMINAL_FPS` a second, only when something changed. */
function schedule(view: View): void {
  if (view.ended || view.scheduled) return;
  const wait = Math.max(0, view.lastSent + 1000 / TERMINAL_FPS - Date.now());
  view.scheduled = setTimeout(() => {
    view.scheduled = null;
    void sendFrame(view);
  }, wait);
}

/** One event of the owner's: typed text, a named key, the size they see it at; a browser's key or text events are taken too. */
async function apply(view: View, raw: unknown): Promise<void> {
  const parsed = TerminalInputEvent.safeParse(raw);
  const session = view.session;
  if (parsed.success) {
    const event = parsed.data;
    if (event.t === "tty") ownerType(session, event.text);
    else if (event.t === "tty-key") ownerKey(session, event.key);
    else if (event.t === "tty-size") await resizeSession(session, event.cols, event.rows);
    return;
  }
  // A page that sends the browser's own events: text as typed, a key going down as its name.
  const event = raw as { t?: unknown; text?: unknown; type?: unknown; key?: unknown };
  if (event?.t === "text" && typeof event.text === "string") ownerType(session, event.text.slice(0, 4000));
  else if (event?.t === "key" && event.type === "down" && typeof event.key === "string") {
    if ([...event.key].length === 1) ownerType(session, event.key);
    else ownerKey(session, event.key);
  }
}

/** Starts a live view of a terminal session for the owner's browser. */
export async function startTerminalView(client: HostedClient, frame: TakeoverStart, openBox: (frame: TakeoverStart) => { secret: Buffer; nonce: string; expiresAt: string }, maxMs: number): Promise<{ status: number; body: Record<string, unknown> }> {
  if (views.has(frame.takeoverId)) return { status: 409, body: { error: "That takeover has started already." } };
  const session = terminalSession(frame.tab);
  if (!session) return { status: 410, body: { error: "That terminal has ended." } };
  if (!frame.operation || session.operation !== frame.operation) return { status: 404, body: { error: "That terminal is not the node's." } };
  if ([...views.values()].some((view) => view.session.id === session.id && !view.ended)) return { status: 409, body: { error: "Someone already watches that terminal." } };
  let box;
  try {
    box = openBox(frame);
  } catch (error) {
    if (error instanceof SealError) return { status: error.statusCode, body: { error: error.message, code: `seal_${error.code}` } };
    throw error;
  }
  try {
    return await takeOnce({ decisionId: frame.takeoverId, nonce: box.nonce, expiresAt: box.expiresAt }, async () => {
      const keys = takeoverKeys(box.secret, frame.takeoverId);
      box.secret.fill(0);
      const view: View = {
        id: frame.takeoverId,
        session,
        keys,
        client,
        view: frame.view === "control" ? "control" : "watch",
        inSeq: 0,
        outSeq: 0,
        refused: 0,
        applied: 0,
        frames: 0,
        lastInput: Date.now(),
        lastSent: 0,
        lastFrame: "",
        startedAt: Date.now(),
        scheduled: null,
        retry: null,
        sending: false,
        again: false,
        queue: Promise.resolve(),
        timers: [],
        deadline: null,
        stop: () => undefined,
        ended: false,
      };
      views.set(view.id, view);
      watchSession(session, true);
      if (view.view === "control") controlSession(session, view.id, true);
      const onChange = (change: SessionChange) => (change === "ended" ? void endTerminalView(view.id, { done: false, reason: "ended", tell: true }) : schedule(view));
      session.events.on("change", onChange);
      session.events.on("ended", onChange);
      view.stop = () => {
        session.events.off("change", onChange);
        session.events.off("ended", onChange);
      };
      const endsAt = Math.min(Date.parse(frame.endsAt) || Infinity, Date.now() + maxMs);
      const deadline = setTimeout(() => void endTerminalView(view.id, { done: false, reason: "expired", tell: true }), Math.max(0, endsAt - Date.now()));
      const idle = setInterval(() => {
        if (Date.now() - view.lastInput > IDLE_MS) void endTerminalView(view.id, { done: false, reason: "idle", tell: true });
      }, Math.min(10_000, IDLE_MS / 2));
      deadline.unref();
      idle.unref();
      view.deadline = deadline;
      view.timers.push(idle);
      // The first frame once the web has this answer.
      view.retry = setTimeout(() => void sendFrame(view), 100);
      await ledger("takeover.started", { takeoverId: view.id, tab: session.id, kind: "terminal", view: view.view });
      return { status: 200, body: { started: true, kind: "terminal", cols: session.term.cols, rows: session.term.rows, endsAt: new Date(endsAt).toISOString(), view: view.view } };
    });
  } catch (error) {
    box.secret.fill(0);
    if (error instanceof SealError) return { status: error.statusCode, body: { error: error.message, code: `seal_${error.code}` } };
    return { status: 500, body: { error: error instanceof Error ? error.message.split("\n")[0]!.slice(0, 300) : "The live view could not start." } };
  }
}

/** Input for a terminal view; false when the takeover is not one here. */
export function terminalViewInput(input: TakeoverInput): boolean {
  const view = views.get(input.takeoverId);
  if (!view) return false;
  if (view.ended) return true;
  const message: ChannelMessage = { seq: input.seq, iv: input.iv, ct: input.ct };
  if (message.seq <= view.inSeq) {
    view.refused += 1;
    return true;
  }
  let events: unknown[];
  try {
    const plaintext = openMessage(view.keys.w2d, view.id, "w2d", message);
    events = InputBatch.parse(JSON.parse(plaintext.toString("utf8"))).events;
    plaintext.fill(0);
  } catch (error) {
    if (error instanceof ChannelError || error instanceof z.ZodError || error instanceof SyntaxError) {
      view.refused += 1;
      return true;
    }
    throw error;
  }
  view.inSeq = message.seq;
  view.lastInput = Date.now();
  view.queue = view.queue.then(async () => {
    for (const event of events) {
      if (view.ended) return;
      await apply(view, event).catch(() => undefined);
      view.applied += 1;
    }
  });
  return true;
}

/** Watching or in control; null when the takeover is not a terminal view here. */
export function controlTerminalView(id: string, on: boolean): "watch" | "control" | null {
  const view = views.get(id);
  if (!view || view.ended) return null;
  view.view = on ? "control" : "watch";
  controlSession(view.session, view.id, on);
  view.lastInput = Date.now();
  return view.view;
}

/** A terminal view's time moved (`takeover.extend`): it now ends at `endsAt`. False when there is no such view. */
export function extendTerminalView(id: string, endsAt: string): boolean {
  const view = views.get(id);
  const at = Date.parse(endsAt);
  if (!view || view.ended || !Number.isFinite(at)) return false;
  if (view.deadline) clearTimeout(view.deadline);
  view.deadline = setTimeout(() => void endTerminalView(id, { done: false, reason: "expired", tell: true }), Math.max(0, at - Date.now()));
  view.deadline.unref();
  return true;
}

/** Whether a takeover is a terminal view here. */
export function isTerminalView(id: string): boolean {
  return views.has(id);
}

/** Ends a terminal view; the session goes on. `tell`: this computer ended it, so the relay hears why. */
export async function endTerminalView(id: string, input: { done: boolean; reason: string; tell: boolean }): Promise<{ ended: boolean; signedIn: null }> {
  const view = views.get(id);
  if (!view || view.ended) return { ended: false, signedIn: null };
  view.ended = true;
  views.delete(id);
  for (const timer of view.timers) clearTimeout(timer);
  if (view.deadline) clearTimeout(view.deadline);
  if (view.scheduled) clearTimeout(view.scheduled);
  if (view.retry) clearTimeout(view.retry);
  view.stop();
  await view.queue.catch(() => undefined);
  controlSession(view.session, view.id, false);
  watchSession(view.session, false);
  await ledger("takeover.ended", { takeoverId: id, kind: "terminal", reason: input.reason, inputs: view.applied, refused: view.refused });
  if (input.tell) await view.client.takeoverState?.(id, { state: "ended", reason: input.reason }).catch(() => undefined);
  return { ended: true, signedIn: null };
}

/** Ends every terminal view (this computer stopped taking work from the web). */
export async function endAllTerminalViews(reason: string): Promise<void> {
  for (const id of [...views.keys()]) await endTerminalView(id, { done: false, reason, tell: true });
}
