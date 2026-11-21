/**
 * Desktop control on this computer (docs/25 §11): the owner's real screen, keyboard and pointer, through
 * the desktop helper (desktop-helper/linux), for one conversation at a time.
 *
 * One service per computer runs one call at a time. One controller (a node's mission, a coding run)
 * drives the desktop; others are told it is busy, with their place in line. Every screenshot the model
 * sees has a capture id bound to its screen and time (ledger.ts): coordinates are taken only on the
 * latest one, mapped into that screen's logical pixels and clamped there (mapping.ts). A look that
 * failed leaves an observation debt: nothing but waiting or opening an app runs until a look works.
 * The owner can take the desktop over at any time just by using it (lease.ts): input and screenshots
 * pause until two minutes after their last input, and a call that was going on when they did is
 * discarded. The hard floor (floor.ts) is checked before every step; sensitive apps (sensitive.ts) are
 * the caller's to ask about (`Caller.gate`). Each step answers honestly what happened and whether it ran.
 *
 * One service works on one screen (`screen`): the owner's, or the agent screen, a private headless
 * compositor of the agent's own (desktop-helper/linux/desktop_helper/agent_screen.py) where the owner's
 * lease, lock and activity do not apply. On the owner's screen a batch runs in the background unless it
 * asks for the foreground: steps aim at elements through accessibility only, never moving the pointer,
 * typing or changing the focus there, and wait while the owner uses the app they act in.
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, readdir, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { hideSecretValues } from "../../lib/redact.js";
import { elementFloor, keyboardFloor, looksSecret, pointerFloor, SECRET_REF, SECRET_TEXT_MESSAGE, type FloorHit } from "./floor.js";
import type { HelperHealth } from "./helper-process.js";
import { Controllers, LEASE_IDLE_MS, OWNER_INPUT_MARGIN_MS, TakeoverLease, type LeaseView } from "./lease.js";
import { newCaptureId, ObservationLedger, type Capture, type ScreenRef } from "./ledger.js";
import { boxToRegion, imageToLogical, MAX_LONG_EDGE, type Region } from "./mapping.js";
import { HelperError, type CaptureResult, type Fact, type FocusInfo, type HelperApp, type HelperElement, type HelperEvent, type Ran, type SessionInfo, type StatusResult, type Stream, type TreeResult } from "./protocol.js";
import { GATE_WORDS, sensitiveApp, type GateCategory } from "./sensitive.js";
import type { DesktopStep, StepAction } from "./tool-specs.js";

export type DesktopCode =
  | "busy"
  | "consent_needed"
  | "consent_denied"
  | "owner_has_control"
  | "screen_locked"
  | "stale_capture"
  | "observation_required"
  | "refused"
  | "needs_owner"
  | "not_found"
  | "not_inspectable"
  | "unavailable"
  | "unsupported"
  | "failed"
  | "timeout"
  | "bad_input"
  | "recording_active"
  | "no_recording"
  | "element_gone"
  | "no_session"
  | "capture_failed"
  | "input_failed"
  | "launch_failed"
  | "helper_crashed"
  | "cancelled"
  | "needs_screen"
  | "owner_using_app";

export class DesktopError extends Error {
  constructor(
    readonly code: DesktopCode,
    message: string,
    readonly ran: Ran = "no",
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "DesktopError";
  }
}

const FROM_HELPER: Record<string, DesktopCode> = {
  consent_needed: "consent_needed",
  consent_denied: "consent_denied",
  stopped_by_owner: "consent_needed",
  no_session: "no_session",
  capture_failed: "capture_failed",
  input_failed: "input_failed",
  element_gone: "element_gone",
  target_not_found: "not_found",
  not_inspectable: "not_inspectable",
  unsupported_here: "unsupported",
  timeout: "timeout",
  deadline: "timeout",
  cancelled: "cancelled",
  recording_active: "recording_active",
  recording_failed: "failed",
  a11y_unavailable: "unavailable",
  launch_failed: "launch_failed",
  bad_display: "bad_input",
  no_recording: "no_recording",
  invalid_params: "bad_input",
  gone: "helper_crashed",
  unavailable: "unavailable",
  needs_screen: "needs_screen",
};

function fromHelper(error: unknown): DesktopError {
  if (error instanceof DesktopError) return error;
  if (error instanceof HelperError) return new DesktopError(FROM_HELPER[error.kind] ?? "failed", error.message, error.ran, error.data);
  return new DesktopError("failed", error instanceof Error ? error.message.slice(0, 300) : "Desktop control failed.", "maybe");
}

/** What the helper process looks like to the service (a fake one in tests). */
export interface HelperLike {
  call<T>(method: string, params: Record<string, unknown>, options: { timeoutMs: number; effects?: boolean; signal?: AbortSignal }): Promise<T>;
  health(): HelperHealth;
  stop(): Promise<void>;
  on(event: "event", listener: (event: HelperEvent) => void): unknown;
  on(event: "exit", listener: (info: { expected: boolean }) => void): unknown;
}

export type ScreenName = "owner" | "agent";

export type GateApp = { id: string; name: string; category: GateCategory };

/** What a batch in the foreground of the owner's screen asks for: their pointer and keyboard, once per mission. */
export const OWNER_SCREEN_GATE: GateApp = { id: "screen:owner", name: "the pointer and keyboard", category: "screen" };

export const NEEDS_SCREEN = "Needs the screen: ask to use the owner's screen (foreground: true asks them once) or use the agent screen.";
/** The owner's answer for a sensitive app: allowed, to be asked (once per app and run), or refused with why. */
export type GateAnswer = { allow: true } | { allow: false; ask: true } | { allow: false; ask: false; reason: string };

export type Caller = {
  /** The controller: `node:<nodeId>:<mission>`, `run:<jobId>`. */
  key: string;
  /** How others in line are told who has the desktop ("@helper's conversation"). */
  label: string;
  /** What this call may take, all in. */
  budgetMs: number;
  /** Screenshots come back as base64 too (a model on Ensemble's API reads them from the answer). */
  inline?: boolean;
  /** Whether the agent may act in a sensitive app now. Absent: never (a caller without owners). */
  gate?: (app: GateApp) => Promise<GateAnswer>;
  /** A saved secret's value by name, for `$NAME` typed into a password field; `origin`: the browser page it would go to. */
  secret?: (name: string, where: { origin: string | null }) => Promise<string | null>;
};

export type DisplayView = { id: string; node: number; width: number; height: number; primary: boolean };

export type Observation = {
  screen: ScreenName;
  captureId: string;
  /** The screen in the picture; null for a look at an app's elements only. */
  display: DisplayView | null;
  image: { width: number; height: number; mime: string; path: string | null; base64?: string } | null;
  /** Screen (logical) pixels per image pixel. */
  scale: number | null;
  settled: boolean | null;
  takenAt: string;
  focus: { app: string | null; appId: string | null; window: string | null; shell: boolean; prompt: string | null; focused: { role: string; name: string; editable: boolean; text?: string } | null } | null;
  tree: { app: string; appId: string | null; window: string; truncated: boolean; elements: HelperElement[] } | null;
  displays: DisplayView[];
  /** A zoom: the observation it is part of, and the part of the screen it shows. */
  zoomOf?: string;
  region?: Region;
  notes: string[];
};

export type StepVerdict = "confirmed" | "partial" | "no_effect" | "refused" | "not_run" | "unknown";
export type StepOutcome = { index: number; action: StepAction; verdict: StepVerdict; ran: Ran; code?: string; detail?: string; rule?: string };
export type ActResult = {
  screen: ScreenName;
  /** On the owner's screen: through accessibility only, or with their pointer and keyboard. */
  mode: "background" | "foreground" | "agent_screen";
  steps: StepOutcome[];
  ran: number;
  stopped: { at: number; code: string; reason: string } | null;
  needsOwner: GateApp | null;
  observation: Observation | null;
  observeError: string | null;
};

export type AppsResult = { screen: ScreenName; installed: Array<{ id: string; name: string }>; running: Array<{ name: string; id: string | null; windows: Array<{ title: string; active: boolean }> }> };

export type OpenResult = { screen: ScreenName; app: { id: string; name: string }; stages: Record<string, boolean>; focused: boolean; via: string | null; waitedMs: number };

export type LiveFrame = { screen: ScreenName; mime: "image/jpeg"; base64: string; width: number; height: number; at: number };

export type StillRef = { path: string; mime: string; size: number; width: number; height: number };
export type SavedRecording = {
  path: string;
  kind: "video";
  mime: string;
  size: number;
  sha256: string;
  width: number;
  height: number;
  durationMs: number;
  fps: number;
  frames: number;
  codec: string;
  poster?: StillRef;
  preview?: StillRef;
  held: boolean;
  reason?: string;
  truncated?: boolean;
};

export type DesktopStatus = {
  screen: ScreenName;
  facts: Record<string, Fact>;
  session: { state: string; displays: DisplayView[] };
  lease: LeaseView;
  controller: { label: string; since: string } | null;
  recording: { id: string; startedAt: string; ended: string | null } | null;
  helper: HelperHealth;
};

export type DesktopServiceOptions = {
  helper: HelperLike;
  /** The screen this service works on (default the owner's). */
  screen?: ScreenName;
  /** How long a background step waits while the owner uses the app it acts in (default 15 s). */
  ownerWaitMs?: number;
  /** Input at the computer this recent pauses input on the owner's screen (default 5 s). */
  ownerQuietMs?: number;
  /** Where the model's screenshots are kept for a while (`<data>/desktop/captures`). */
  captureDir: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  /** The owner's saved secret values, for the floor's "this text is a secret". */
  secretValues?: () => Promise<readonly string[]>;
  env?: NodeJS.ProcessEnv;
  /** Screen control ends after this long without a call (and no recording). */
  sessionIdleMs?: number;
  /** The helper process ends after this long without a call. */
  helperIdleMs?: number;
  /** Screenshots kept in `captureDir`. */
  keepScreenshots?: number;
};

/** Why every desktop capture waits for the owner's preview: nothing can check a screen for secrets. */
export const DESKTOP_HOLD_REASON = "A picture of your screen can show anything on it, so you preview it before it is shown or sent.";

/** How long a recording that ended waits to be saved before it is dropped (and its controller let go). */
export const RECORDING_SAVE_MS = 10 * 60_000;
/** A recording the helper never said it stopped counts as stopped this long after its longest. */
const RECORDING_STOP_GRACE_MS = 30_000;
const RECORDING_PART = /^\.desktop-recording-[0-9a-f]{12}\.part$/;

/**
 * Removes recordings that were never saved from evidence folders (`<root>/<run>/` and
 * `<root>/node/<operation>/`): a stopped runtime's, unchanged for `olderThanMs`. Answers how many went.
 */
export async function sweepRecordingParts(root: string, olderThanMs: number, keep: ReadonlySet<string> = new Set(), now = Date.now()): Promise<number> {
  const folders = [root];
  for (const name of await readdir(root).catch(() => [] as string[])) {
    folders.push(join(root, name));
    if (name === "node") for (const inner of await readdir(join(root, name)).catch(() => [] as string[])) folders.push(join(root, name, inner));
  }
  let removed = 0;
  for (const folder of folders) {
    for (const name of await readdir(folder).catch(() => [] as string[])) {
      const path = join(folder, name);
      if (!RECORDING_PART.test(name) || keep.has(path)) continue;
      const info = await stat(path).catch(() => null);
      if (!info?.isFile() || now - info.mtimeMs < olderThanMs) continue;
      await rm(path, { force: true }).catch(() => undefined);
      removed += 1;
    }
  }
  return removed;
}

const POINTER_STEPS = new Set<StepAction>(["click", "double_click", "right_click", "drag"]);
/** Steps that work through accessibility alone, on an element: the owner's pointer, keyboard and focus stay theirs. */
function backgroundStep(step: DesktopStep): boolean {
  if (step.action === "wait") return true;
  if (!step.element) return false;
  if (step.action === "click") return !step.button || step.button === "left";
  return ["press", "set_text", "select", "toggle", "scroll", "type"].includes(step.action);
}
const INPUT_STEPS = new Set<StepAction>(["click", "double_click", "right_click", "move", "drag", "scroll", "type", "key"]);

type Session = { epoch: number; screens: ScreenRef[] };
const NO_SCREEN: ScreenRef = { node: -1, x: 0, y: 0, width: 0, height: 0, name: null, primary: false };
type StepContext = { secrets: readonly string[]; allowed: Set<string>; background: boolean; idleMs: number | null };
/** Why the helper stopped typing before the end: the owner's input, the window in front changing, or a secret it could not type whole. */
type TypingStop = "owner_input" | "focus_moved" | "secret_untypeable";
type RecordingState = { id: string; owner: string; node: number; temp: string; dir: string; startedAt: number; maxMs: number; mime: string; container: string; codec: string; ended: string | null; endedAt: number | null; lost: boolean; counter: number };

class Deadline {
  readonly at: number;
  /** Aborted when the work it is for ends (its controller released, the service stopping). */
  readonly abort = new AbortController();
  constructor(
    private readonly now: () => number,
    budgetMs: number,
    readonly key: string | null = null,
  ) {
    this.at = now() + budgetMs;
  }
  remaining(): number {
    return this.at - this.now();
  }
}

const clock = (iso: string) => iso.slice(11, 16);
const settledPair = (before: { settled: boolean | null } | null, after: { settled: boolean | null } | null) => Boolean(before?.settled && after?.settled);

function screensOf(streams: readonly Stream[]): ScreenRef[] {
  return streams.map((stream) => ({ node: stream.node, x: stream.x, y: stream.y, width: stream.width, height: stream.height, name: stream.name ?? null, primary: Boolean(stream.primary) }));
}

/** The origin of the page a browser window titled `window` shows in front, when the desktop says. */
function pageOrigin(focus: FocusInfo, window: string | null): string | null {
  const doc = (focus.documents ?? []).find((item) => item.url && (window ? item.window === window : item.active));
  try {
    return doc?.url ? new URL(doc.url).origin : null;
  } catch {
    return null;
  }
}

function displayId(screen: ScreenRef, index: number): string {
  return screen.name ?? `screen-${index + 1}`;
}

export class DesktopService {
  readonly lease: TakeoverLease;
  readonly controllers: Controllers;
  readonly ledger = new ObservationLedger();
  private session: Session | null = null;
  private recording: RecordingState | null = null;
  private tail: Promise<void> = Promise.resolve();
  private lastHolder: string | null = null;
  private lastScreen = new Map<string, number>();
  private idleTimer: NodeJS.Timeout | null = null;
  private lastCall: number;
  private ownerStoppedAt: number | null = null;
  private consentFailed: { at: number; reason: string } | null = null;
  private stopped = false;
  /** The call running now, to cancel when its work ends. */
  private current: Deadline | null = null;
  /** Why a controller's recording is gone, for its next save or discard. */
  private readonly dropped = new Map<string, string>();
  private recordingTimer: NodeJS.Timeout | null = null;

  readonly screenName: ScreenName;

  constructor(private readonly options: DesktopServiceOptions) {
    this.screenName = options.screen ?? "owner";
    this.lease = new TakeoverLease(this.now);
    this.controllers = new Controllers(this.now);
    this.lastCall = this.now();
    options.helper.on("event", (event: HelperEvent) => this.onEvent(event));
    options.helper.on("exit", () => this.dropSession("the desktop helper stopped"));
  }

  private readonly now = (): number => (this.options.now ?? Date.now)();

  private sleep(ms: number): Promise<void> {
    return this.options.sleep ? this.options.sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms).unref?.());
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  // ── events and the session ───────────────────────────────────────────────

  private onEvent(event: HelperEvent): void {
    if (event.kind === "session.started" && Array.isArray(event.streams)) {
      this.session = { epoch: Number(event.epoch) || 0, screens: screensOf(event.streams as Stream[]) };
      this.consentFailed = null;
      this.ledger.invalidateAll();
    } else if (event.kind === "session.closed") {
      if (event.reason === "closed_by_owner") this.ownerStoppedAt = this.now();
      this.dropSession(String(event.reason ?? "closed"));
    } else if (event.kind === "session.failed") {
      this.consentFailed = { at: this.now(), reason: String(event.reason ?? "failed") };
    } else if (event.kind === "record.stopped" && this.recording && event.id === this.recording.id) {
      this.recordingEnded(this.recording, String(event.reason ?? "stopped"));
    }
  }

  /** A recording stopped by itself (its length, the session's end, the helper's): it waits `RECORDING_SAVE_MS` to be saved. */
  private recordingEnded(recording: RecordingState, why: string): void {
    if (recording.endedAt !== null) return;
    recording.ended = why;
    recording.endedAt = this.now();
    // A recording the helper lost was never finished: nothing of it can be saved.
    if (recording.lost) void rm(recording.temp, { force: true }).catch(() => undefined);
    this.controllers.pin(recording.owner, recording.endedAt + RECORDING_SAVE_MS);
    if (this.recordingTimer) clearTimeout(this.recordingTimer);
    this.recordingTimer = setTimeout(() => void this.run(20_000, (deadline) => this.expireRecording(deadline)).catch(() => undefined), RECORDING_SAVE_MS + 1_000);
    this.recordingTimer.unref?.();
  }

  /** Drops a recording whose time to be saved has passed, and lets its controller go. */
  private async expireRecording(deadline: Deadline): Promise<void> {
    const recording = this.recording;
    if (!recording) return;
    const now = this.now();
    if (recording.endedAt === null && now > recording.startedAt + recording.maxMs + RECORDING_STOP_GRACE_MS) this.recordingEnded(recording, "max_duration");
    if (recording.endedAt === null || now < recording.endedAt + RECORDING_SAVE_MS) return;
    this.dropped.set(recording.owner, `Your recording was not saved within ${Math.round(RECORDING_SAVE_MS / 60_000)} minutes of its end, so it was dropped.`);
    this.log("desktop: an unsaved recording was dropped");
    await this.dropRecording(recording, deadline);
  }

  private dropSession(why: string): void {
    if (this.session) this.log(`desktop: screen control ended (${why})`);
    this.session = null;
    this.ledger.invalidateAll();
    if (this.recording && this.recording.endedAt === null) {
      if (why === "the desktop helper stopped") this.recording.lost = true;
      this.recordingEnded(this.recording, why);
    }
  }

  private async ensureSession(deadline: Deadline): Promise<Session> {
    if (this.session) return this.session;
    const info = await this.call<SessionInfo>("session.start", { wait_ms: 4_000 }, deadline, { maxMs: 25_000 });
    if (info.state !== "on" || !Array.isArray(info.streams)) {
      const again = this.ownerStoppedAt ? " Your owner stopped screen control earlier, so the computer asks them again." : "";
      throw new DesktopError(
        "consent_needed",
        `Screen control waits for your owner: a system dialog on the computer asks them to allow it.${again} Call desktop_handoff with reason consent (it tells them and waits), or try again later.`,
        "no",
      );
    }
    this.session = { epoch: info.epoch ?? 0, screens: screensOf(info.streams) };
    this.consentFailed = null;
    return this.session;
  }

  /** The screen a controller last looked at, while it still exists. */
  private screenOf(key: string, session: Session): number | undefined {
    const node = this.lastScreen.get(key);
    return node !== undefined && session.screens.some((screen) => screen.node === node) ? node : undefined;
  }

  private screens(session: Session): DisplayView[] {
    return session.screens.map((screen, index) => ({ id: displayId(screen, index), node: screen.node, width: screen.width, height: screen.height, primary: screen.primary }));
  }

  private pickScreen(session: Session, display: string | number | undefined): ScreenRef {
    const screens = session.screens;
    if (!screens.length) throw new DesktopError("capture_failed", "Screen control shows no screen.", "no");
    if (display === undefined || display === "") return screens.find((screen) => screen.primary) ?? screens[0]!;
    const wanted = String(display).trim().toLowerCase();
    const found = screens.find((screen, index) => displayId(screen, index).toLowerCase() === wanted || String(screen.node) === wanted || String(index + 1) === wanted);
    if (!found) throw new DesktopError("bad_input", `There is no screen ${String(display)}. Screens: ${this.screens(session).map((view) => view.id).join(", ")}.`, "no");
    return found;
  }

  // ── the queue ────────────────────────────────────────────────────────────

  /** Runs `work` when the calls before it are done; gives up (not run) if its budget passes while it waits. */
  private run<T>(budgetMs: number, work: (deadline: Deadline) => Promise<T>, key: string | null = null): Promise<T> {
    if (this.stopped) return Promise.reject(new DesktopError("unavailable", "Desktop control is stopping on this computer.", "no"));
    const deadline = new Deadline(this.now, budgetMs, key);
    const prior = this.tail;
    let finish!: () => void;
    const mine = new Promise<void>((resolve) => (finish = resolve));
    this.tail = prior.then(() => mine);
    return new Promise<T>((resolve, reject) => {
      let gaveUp = false;
      const timer = setTimeout(() => {
        gaveUp = true;
        reject(new DesktopError("timeout", "Another desktop call took the time this one had; it did not run.", "no"));
      }, Math.max(0, budgetMs));
      timer.unref?.();
      void prior.then(async () => {
        clearTimeout(timer);
        if (gaveUp) return finish();
        this.current = deadline;
        try {
          if (this.recording) await this.expireRecording(deadline).catch(() => undefined);
          resolve(await work(deadline));
        } catch (error) {
          reject(error);
        } finally {
          this.current = null;
          this.lastCall = this.now();
          this.armIdle();
          finish();
        }
      });
    });
  }

  /** Claims the desktop for `caller`, runs `work` in line, and keeps the claim fresh from its end. */
  private runAs<T>(caller: Caller, work: (deadline: Deadline) => Promise<T>): Promise<T> {
    this.claim(caller);
    return this.run(caller.budgetMs, work, caller.key).finally(() => this.controllers.touch(caller.key));
  }

  private claim(caller: Caller): void {
    const claim = this.controllers.claim(caller.key, caller.label);
    if (!claim.ok) {
      throw new DesktopError(
        "busy",
        `The desktop is in use by ${claim.holder.label} (since ${clock(claim.holder.since)}). You are number ${claim.place} in line: try again in a minute or two, or go on without it.`,
        "no",
        { place: claim.place },
      );
    }
    if (this.lastHolder !== caller.key) {
      this.ledger.invalidateAll();
      this.lastHolder = caller.key;
    }
  }

  private async call<T>(method: string, params: Record<string, unknown>, deadline: Deadline, options: { effects?: boolean; maxMs?: number } = {}): Promise<T> {
    const left = deadline.remaining() - 250;
    if (left < 1_000) throw new DesktopError("timeout", "This call ran out of time before it could go on.", "no");
    if (deadline.abort.signal.aborted) throw new DesktopError("cancelled", "The work this call was for ended, so it went no further.", "no");
    try {
      return await this.options.helper.call<T>(method, params, { timeoutMs: Math.min(options.maxMs ?? 30_000, left), effects: options.effects, signal: deadline.abort.signal });
    } catch (error) {
      const failure = fromHelper(error);
      if (failure.code === "no_session" || failure.code === "helper_crashed") this.dropSession(failure.code === "no_session" ? "the session ended" : "the desktop helper stopped");
      throw failure;
    }
  }

  /**
   * The owner's lease, their activity and the screen lock, read now; nothing on the agent screen. Throws when
   * the agent may not go on: `look` (a screenshot) and `screen` (their pointer or keyboard) pause while the
   * owner has the computer, `screen` also while they are using it this moment; `background` (accessibility
   * only) goes on. Answers the idle time for the background's own check.
   */
  private async guard(deadline: Deadline, kind: "look" | "screen" | "background" = "screen"): Promise<{ idleMs: number | null }> {
    if (this.screenName === "agent") return { idleMs: null };
    const idle = await this.call<{ locked: boolean | null; idle_ms: number | null }>("idle", {}, deadline, { maxMs: 5_000 });
    const change = this.lease.observeIdle(idle.idle_ms);
    if (change) this.ledger.invalidateAll();
    if (this.lease.holder === "owner" && kind !== "background") {
      throw new DesktopError(
        "owner_has_control",
        `Your owner is using the computer (${this.lease.reason === "handoff" ? "you handed it to them" : "they took over"} at ${clock(this.lease.view().since)}): your input and screenshots pause until two minutes after their last input. Wait, ask them in the chat, or work in the background: desktop_observe with screenshot false reads an app's elements without a picture.`,
        "no",
        { lease: this.lease.view() },
      );
    }
    if (idle.locked) throw new DesktopError("screen_locked", "The computer's screen is locked: only your owner can unlock it. Ask them, or hand it over with desktop_handoff.", "no");
    if (kind === "screen" && this.ownerActiveNow(idle.idle_ms)) {
      throw new DesktopError("owner_has_control", "Your owner is using the keyboard or mouse right now: input on their screen waits until they pause. Try again in a moment, or work in the background or on the agent screen.", "no");
    }
    return { idleMs: idle.idle_ms };
  }

  /** Input at the computer a moment ago that the agent did not send. */
  private ownerActiveNow(idleMs: number | null): boolean {
    if (idleMs === null || idleMs >= (this.options.ownerQuietMs ?? 5_000)) return false;
    const last = this.lease.lastAgentInputAt;
    return last === null || idleMs < this.now() - last - OWNER_INPUT_MARGIN_MS;
  }

  /**
   * A background step in an app whose window is in front while the owner uses the computer waits until
   * they switch away or stop for two minutes, at most `ownerWaitMs`; then it does not run.
   */
  private async waitWhileOwnerUses(app: { name: string; pid: number | null }, idleMs: number | null, deadline: Deadline): Promise<boolean> {
    if (this.screenName === "agent") return false;
    const waitMs = Math.min(this.options.ownerWaitMs ?? 15_000, Math.max(0, deadline.remaining() - 8_000));
    let idle = idleMs;
    for (let waited = 0; ; waited += 1_000) {
      if (idle === null || idle >= LEASE_IDLE_MS) return waited > 0;
      const focus = await this.call<FocusInfo>("a11y.focus", { text: false, documents: false }, deadline, { maxMs: 5_000 });
      const inFront = focus.app !== null && (focus.app.pid === app.pid || focus.app.name === app.name);
      if (!inFront) return waited > 0;
      if (waited >= waitMs) {
        throw new DesktopError("owner_using_app", `Your owner is using ${app.name} right now (its window is in front, and they used the computer ${Math.round(idle / 1000)} s ago): steps there wait until they switch away or stop for two minutes. Try again later, or use the agent screen.`, "no");
      }
      await this.sleep(1_000);
      idle = (await this.call<{ locked: boolean | null; idle_ms: number | null }>("idle", {}, deadline, { maxMs: 5_000 })).idle_ms;
    }
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const sessionIdle = this.options.sessionIdleMs ?? 5 * 60_000;
    const helperIdle = this.options.helperIdleMs ?? 10 * 60_000;
    this.idleTimer = setTimeout(() => void this.idleCheck(sessionIdle, helperIdle), Math.min(sessionIdle, helperIdle) + 1_000);
    this.idleTimer.unref?.();
  }

  private async idleCheck(sessionIdle: number, helperIdle: number): Promise<void> {
    this.idleTimer = null;
    const quiet = this.now() - this.lastCall;
    if (this.recording && !this.recording.ended) return this.armIdle();
    if (quiet >= helperIdle) {
      this.session = null;
      await this.options.helper.stop().catch(() => undefined);
      return;
    }
    if (quiet >= sessionIdle && this.session) {
      await this.run(15_000, (deadline) => this.call("session.stop", {}, deadline)).catch(() => undefined);
      this.session = null;
      this.ledger.invalidateAll();
    }
    this.armIdle();
  }

  // ── status and apps ──────────────────────────────────────────────────────

  async status(budgetMs = 20_000): Promise<DesktopStatus> {
    return this.run(budgetMs, async (deadline) => {
      let facts: Record<string, Fact>;
      let state = this.session ? "on" : "off";
      try {
        const status = await this.call<StatusResult>("status", {}, deadline, { maxMs: 15_000 });
        facts = status.facts;
        state = status.session.state;
        if (status.session.state === "on" && status.session.streams) this.session = { epoch: status.session.epoch, screens: screensOf(status.session.streams) };
        else if (status.session.state !== "on") this.session = null;
        const idle = await this.call<{ locked: boolean | null; idle_ms: number | null }>("idle", {}, deadline, { maxMs: 5_000 }).catch(() => null);
        if (idle && this.lease.observeIdle(idle.idle_ms)) this.ledger.invalidateAll();
      } catch (error) {
        const failure = fromHelper(error);
        facts = { helper: { state: "failed", detail: failure.message } };
      }
      const holder = this.controllers.current();
      return {
        screen: this.screenName,
        facts,
        session: { state, displays: this.session ? this.screens(this.session) : [] },
        lease: this.lease.view(),
        controller: holder ? { label: holder.label, since: holder.since } : null,
        recording: this.recording ? { id: this.recording.id, startedAt: new Date(this.recording.startedAt).toISOString(), ended: this.recording.ended } : null,
        helper: this.options.helper.health(),
      };
    });
  }

  async apps(input: { query?: string; running?: boolean }, budgetMs = 20_000): Promise<AppsResult> {
    return this.run(budgetMs, async (deadline) => {
      const installed = input.running ? [] : (await this.call<{ apps: Array<{ id: string; name: string }> }>("apps.catalog", { ...(input.query ? { query: input.query } : {}), limit: input.query ? 20 : 80 }, deadline)).apps;
      const listed = await this.call<{ apps: HelperApp[] }>("a11y.apps", {}, deadline).catch(() => ({ apps: [] as HelperApp[] }));
      const query = input.query?.trim().toLowerCase();
      const running = listed.apps
        .filter((app) => app.windows.length && app.name !== "gnome-shell")
        .filter((app) => !query || `${app.name} ${app.app_id ?? ""}`.toLowerCase().includes(query))
        .map((app) => ({ name: app.name, id: app.app_id, windows: app.windows.map((window) => ({ title: hideSecretValues(window.title), active: window.active })) }));
      return { screen: this.screenName, installed: installed.map((app) => ({ id: app.id, name: app.name })), running };
    });
  }

  // ── looking ──────────────────────────────────────────────────────────────

  async observe(caller: Caller, input: { display?: string | number; app?: string; elements?: boolean; maxElements?: number; screenshot?: boolean }): Promise<Observation> {
    return this.runAs(caller, async (deadline) => {
      if (input.screenshot === false) return this.treeLook(caller, input, deadline);
      await this.guard(deadline, "look");
      return this.look(caller, input, deadline);
    });
  }

  /**
   * A look at one app's elements without a screenshot: no screen control needed, and it goes on while the
   * owner has the computer, but the app they are using waits until they pause (its text may be what they type).
   */
  private async treeLook(caller: Caller, input: { app?: string | number; maxElements?: number }, deadline: Deadline): Promise<Observation> {
    const { idleMs } = await this.guard(deadline, "background");
    const focus = await this.call<FocusInfo>("a11y.focus", { text: false, documents: true }, deadline, { maxMs: 8_000 }).catch(() => null);
    const target = input.app ?? (focus?.app && !focus.shell ? (focus.app.pid ?? focus.app.name) : null);
    if (target === null || target === undefined) throw new DesktopError("bad_input", "Name the app whose elements to read (app, from desktop_apps): no app is in front.", "no");
    const read = () => this.call<TreeResult>("a11y.tree", { app: target, max_elements: input.maxElements ?? 120 }, deadline, { maxMs: 8_000 });
    let tree = await read();
    if (await this.waitWhileOwnerUses({ name: tree.app.name, pid: tree.app.pid }, idleMs, deadline)) tree = await read();
    const capture = this.ledger.record({
      id: newCaptureId(),
      controller: caller.key,
      epoch: -1,
      screen: NO_SCREEN,
      region: { x: 0, y: 0, width: 0, height: 0 },
      image: { width: 0, height: 0 },
      frame: { width: 0, height: 0 },
      takenAt: this.now(),
      hash: 0,
      parent: null,
      tree: { id: tree.tree_id, app: { name: tree.app.name, id: tree.app.app_id, pid: tree.app.pid, toolkit: tree.app.toolkit }, window: tree.window.title, elements: new Map(tree.elements.map((element) => [element.id, element])) },
      path: null,
      treeOnly: true,
    });
    const notes = ["No screenshot: aim at element ids only (coordinates need a look with a screenshot)."];
    if (tree.truncated) notes.push("Not every element is listed (the window has many): use maxElements.");
    return {
      screen: this.screenName,
      captureId: capture.id,
      display: null,
      image: null,
      scale: null,
      settled: null,
      takenAt: new Date(capture.takenAt).toISOString(),
      focus: focus ? this.focusView(focus) : null,
      tree: this.treeView(tree),
      displays: this.session ? this.screens(this.session) : [],
      notes,
    };
  }

  private async ensureCaptureDir(): Promise<void> {
    await mkdir(this.options.captureDir, { recursive: true, mode: 0o700 });
  }

  private async look(caller: Caller, input: { display?: string | number; app?: string; elements?: boolean; maxElements?: number }, deadline: Deadline): Promise<Observation> {
    const counter = this.lease.counter;
    let session: Session;
    let shot: CaptureResult;
    let screen: ScreenRef;
    const id = newCaptureId();
    const path = join(this.options.captureDir, `${id}.jpg`);
    try {
      session = await this.ensureSession(deadline);
      screen = this.pickScreen(session, input.display ?? this.screenOf(caller.key, session));
      await this.ensureCaptureDir();
      shot = await this.call<CaptureResult>(
        "frame.capture",
        { display: screen.node, settle: { min_ms: 0, timeout_ms: 1_500 }, max_long_edge: MAX_LONG_EDGE, format: "jpeg", quality: 75, save_path: path, inline: Boolean(caller.inline) },
        deadline,
        { maxMs: 15_000 },
      );
    } catch (error) {
      const failure = fromHelper(error);
      if (failure.code !== "bad_input") this.ledger.owe(caller.key, failure.message);
      throw failure;
    }
    const focus = await this.call<FocusInfo>("a11y.focus", { text: true, documents: true }, deadline, { maxMs: 8_000 }).catch(() => null);
    let tree: TreeResult | null = null;
    const notes: string[] = [];
    if (input.elements !== false) {
      const target = input.app ?? (focus?.app && !focus.shell ? (focus.app.pid ?? focus.app.name) : null);
      if (target !== null && target !== undefined) {
        try {
          tree = await this.call<TreeResult>("a11y.tree", { app: target, max_elements: input.maxElements ?? 120 }, deadline, { maxMs: 8_000 });
        } catch (error) {
          notes.push(`Its elements could not be read (${fromHelper(error).message}): aim at coordinates.`);
        }
      }
    }
    if (this.lease.counter !== counter) {
      await rm(path, { force: true }).catch(() => undefined);
      throw new DesktopError("owner_has_control", "Your owner took over while the screen was being read, so that screenshot was discarded. Wait until they are done.", "no");
    }
    this.lastScreen.set(caller.key, screen.node);
    const capture = this.ledger.record({
      id,
      controller: caller.key,
      epoch: session.epoch,
      screen,
      region: { x: shot.region[0], y: shot.region[1], width: shot.region[2], height: shot.region[3] },
      image: { width: shot.image.width, height: shot.image.height },
      frame: shot.frame,
      takenAt: shot.at,
      hash: shot.hash,
      parent: null,
      tree: tree ? { id: tree.tree_id, app: { name: tree.app.name, id: tree.app.app_id, pid: tree.app.pid, toolkit: tree.app.toolkit }, window: tree.window.title, elements: new Map(tree.elements.map((element) => [element.id, element])) } : null,
      path,
    });
    void this.pruneScreenshots();
    if (shot.settled === false) notes.push("The screen was still changing when this was taken.");
    if (focus) {
      const hit = keyboardFloor(focus, this.options.env);
      if (hit) notes.push(`${hit.message}`);
    }
    if (tree?.truncated) notes.push("Not every element is listed (the window has many): use maxElements, or coordinates.");
    return this.observation(capture, shot, focus, tree, session, notes);
  }

  private focusView(focus: FocusInfo): NonNullable<Observation["focus"]> {
    const hide = (text: string) => hideSecretValues(text);
    return {
      app: focus.app?.name ?? null,
      appId: focus.app?.app_id ?? null,
      window: focus.window ? hide(focus.window.title) : null,
      shell: focus.shell,
      prompt: focus.prompt?.title ?? null,
      focused: focus.focused ? { role: focus.focused.role, name: hide(focus.focused.name), editable: focus.focused.editable, ...(typeof focus.focused.text === "string" ? { text: hide(focus.focused.text) } : {}) } : null,
    };
  }

  private treeView(tree: TreeResult): NonNullable<Observation["tree"]> {
    const hide = (text: string) => hideSecretValues(text);
    return {
      app: tree.app.name,
      appId: tree.app.app_id,
      window: hide(tree.window.title),
      truncated: tree.truncated,
      elements: tree.elements.map((element) => ({ ...element, name: hide(element.name), ...(typeof element.value === "string" ? { value: hide(element.value) } : {}) })),
    };
  }

  private observation(capture: Capture, shot: CaptureResult, focus: FocusInfo | null, tree: TreeResult | null, session: Session, notes: string[]): Observation {
    const index = session.screens.findIndex((screen) => screen.node === capture.screen.node);
    const display = this.screens(session)[Math.max(0, index)]!;
    return {
      screen: this.screenName,
      captureId: capture.id,
      display,
      image: { width: shot.image.width, height: shot.image.height, mime: shot.image.mime, path: shot.image.path ?? null, ...(shot.image.base64 ? { base64: shot.image.base64 } : {}) },
      scale: Math.round((capture.region.width / shot.image.width) * 1000) / 1000,
      settled: shot.settled,
      takenAt: new Date(shot.at).toISOString(),
      focus: focus ? this.focusView(focus) : null,
      tree: tree ? this.treeView(tree) : null,
      displays: this.screens(session),
      notes,
    };
  }

  private async pruneScreenshots(): Promise<void> {
    const keep = this.options.keepScreenshots ?? 40;
    const names = (await readdir(this.options.captureDir).catch(() => [] as string[])).filter((name) => /^cap_[0-9a-f]{12}\.(?:jpg|png)$/.test(name));
    if (names.length <= keep) return;
    const dated = await Promise.all(names.map(async (name) => ({ name, at: (await stat(join(this.options.captureDir, name)).catch(() => null))?.mtimeMs ?? 0 })));
    dated.sort((a, b) => a.at - b.at);
    for (const old of dated.slice(0, dated.length - keep)) await rm(join(this.options.captureDir, old.name), { force: true }).catch(() => undefined);
  }

  async zoom(caller: Caller, input: { captureId: string; box: readonly [number, number, number, number] }): Promise<Observation> {
    return this.runAs(caller, async (deadline) => {
      await this.guard(deadline, "look");
      const session = await this.ensureSession(deadline);
      const checked = this.ledger.check(caller.key, input.captureId, session.screens, session.epoch);
      if (!checked.ok) throw new DesktopError(checked.code, checked.message, "no");
      const base = checked.capture;
      const screen = session.screens.find((item) => item.node === base.screen.node)!;
      const region = boxToRegion(input.box, base.image, base.region, { width: screen.width, height: screen.height });
      const id = newCaptureId();
      const path = join(this.options.captureDir, `${id}.png`);
      await this.ensureCaptureDir();
      const counter = this.lease.counter;
      const shot = await this.call<CaptureResult>("frame.capture", { display: screen.node, crop: [region.x, region.y, region.width, region.height], max_long_edge: MAX_LONG_EDGE, format: "png", save_path: path, inline: Boolean(caller.inline) }, deadline, { maxMs: 15_000 });
      if (this.lease.counter !== counter) {
        await rm(path, { force: true }).catch(() => undefined);
        throw new DesktopError("owner_has_control", "Your owner took over while the screen was being read, so that picture was discarded.", "no");
      }
      const root = base.parent ? this.ledger.get(base.parent) : base;
      const capture = this.ledger.record({
        id,
        controller: caller.key,
        epoch: session.epoch,
        screen,
        region: { x: shot.region[0], y: shot.region[1], width: shot.region[2], height: shot.region[3] },
        image: { width: shot.image.width, height: shot.image.height },
        frame: shot.frame,
        takenAt: shot.at,
        hash: shot.hash,
        parent: root?.id ?? base.id,
        tree: root?.tree ?? null,
        path,
      });
      void this.pruneScreenshots();
      return { ...this.observation(capture, shot, null, null, session, []), zoomOf: capture.parent!, region: capture.region };
    });
  }

  // ── acting ───────────────────────────────────────────────────────────────

  async act(caller: Caller, input: { captureId?: string; steps: readonly DesktopStep[]; observe?: boolean; foreground?: boolean }): Promise<ActResult> {
    return this.runAs(caller, async (deadline) => {
      const mode: ActResult["mode"] = this.screenName === "agent" ? "agent_screen" : input.foreground ? "foreground" : "background";
      const outcomes: StepOutcome[] = input.steps.map((step, index) => ({ index, action: step.action, verdict: "not_run", ran: "no" }));
      const result: ActResult = { screen: this.screenName, mode, steps: outcomes, ran: 0, stopped: null, needsOwner: null, observation: null, observeError: null };
      const secrets = (await this.options.secretValues?.().catch(() => [] as string[])) ?? [];
      const allowed = new Set<string>();
      const base = this.ledger.current(caller.key);
      const baseApp = base?.tree?.app ?? null;
      // The owner's pointer and keyboard are theirs: the foreground asks once per mission before anything runs.
      if (mode === "foreground") await this.gate(caller, OWNER_SCREEN_GATE, allowed);
      let counter: number | null = null;
      let sentInput = false;
      const stop = (index: number, code: string, reason: string) => {
        result.stopped = { at: index, code, reason };
      };
      for (const [index, step] of input.steps.entries()) {
        const outcome = outcomes[index]!;
        let failed = false;
        try {
          const background = mode === "background";
          if (background && !backgroundStep(step)) throw new DesktopError("needs_screen", `${NEEDS_SCREEN} ${step.action === "focus" ? "Moving the focus" : step.element ? `${step.action} on an element` : step.action} uses the owner's ${step.action === "type" || step.action === "key" || step.action === "focus" ? "keyboard" : "pointer"}.`, "no");
          if (deadline.abort.signal.aborted) throw new DesktopError("cancelled", "The work these steps were for ended, so this one did not run.", "no");
          const { idleMs } = await this.guard(deadline, background ? "background" : "screen");
          counter ??= this.lease.counter;
          const debt = this.ledger.debt(caller.key);
          if (debt && step.action !== "wait" && step.action !== "open") throw new DesktopError("observation_required", `Your last look failed (${debt}): look again with desktop_observe before acting.`, "no");
          if (deadline.remaining() < 5_000) throw new DesktopError("timeout", "Not enough time was left for this step.", "no");
          const done = await this.step(caller, step, input.captureId, deadline, { secrets, allowed, background, idleMs });
          Object.assign(outcome, done);
        } catch (error) {
          failed = true;
          const failure = fromHelper(error);
          if (failure.code === "needs_owner" && result.ran === 0 && !sentInput) throw failure;
          outcome.verdict = failure.code === "needs_owner" || failure.code === "owner_using_app" ? "not_run" : failure.ran === "no" ? (["refused", "owner_has_control", "screen_locked", "stale_capture", "observation_required", "busy", "needs_screen"].includes(failure.code) ? "refused" : "not_run") : "unknown";
          outcome.ran = failure.ran;
          outcome.code = failure.code;
          outcome.detail = failure.message;
          if (typeof failure.extra.rule === "string") outcome.rule = failure.extra.rule;
          if (failure.code === "needs_owner") result.needsOwner = failure.extra.app as GateApp;
        }
        if (outcome.ran !== "no") {
          result.ran += 1;
          if (INPUT_STEPS.has(step.action)) sentInput = true;
        }
        if (counter !== null && this.lease.counter !== counter && mode !== "background") {
          stop(index, "owner_has_control", "Your owner took over during these steps: the rest did not run.");
          break;
        }
        if (failed || !(outcome.verdict === "confirmed" || (outcome.verdict === "unknown" && outcome.ran === "yes"))) {
          const why = outcome.code === "needs_owner" ? `${outcome.detail ?? ""} Call desktop_act again with the steps from here: your owner is asked then.` : (outcome.detail ?? `Step ${index + 1} had ${outcome.verdict.replace("_", " ")}.`);
          stop(index, outcome.code ?? outcome.verdict, why.trim());
          break;
        }
      }
      // What was aimed at before input changed the screen is stale now.
      if (sentInput) this.ledger.invalidate(caller.key);
      const ownerTook = counter !== null && this.lease.counter !== counter;
      // The new look is like the one the batch aimed at; while the owner has the computer, elements only.
      const picture = this.lease.holder === "agent" && !ownerTook && (base ? !base.treeOnly : mode !== "background" || this.session !== null);
      const elementsOnly = !picture && (mode === "background" || Boolean(base?.treeOnly)) && baseApp !== null;
      if (input.observe !== false && (picture || elementsOnly)) {
        try {
          if (deadline.remaining() < 8_000) throw new DesktopError("timeout", "No time was left to look again.", "no");
          result.observation = picture ? await this.look(caller, {}, deadline) : await this.treeLook(caller, { app: baseApp!.pid ?? baseApp!.name }, deadline);
        } catch (error) {
          result.observeError = fromHelper(error).message;
        }
      }
      return result;
    });
  }

  private gateApp(app: { name: string; app_id: string | null }): GateApp | null {
    const category = sensitiveApp({ id: app.app_id, name: app.name });
    return category ? { id: app.app_id ?? app.name.toLowerCase(), name: app.name, category } : null;
  }

  /** The sensitive apps a click by position could land in: the one in front, and any with a window that shows. */
  private sensitiveShowing(focus: FocusInfo, apps: readonly HelperApp[]): GateApp[] {
    const found = new Map<string, GateApp>();
    const front = focus.app ? this.gateApp(focus.app) : null;
    if (front) found.set(front.id, front);
    for (const app of apps) {
      if (!app.windows.some((window) => window.showing && !window.iconified)) continue;
      const gate = this.gateApp(app);
      if (gate) found.set(gate.id, gate);
    }
    return [...found.values()];
  }

  private async allowedIn(caller: Caller, app: GateApp, allowed: Set<string>): Promise<boolean> {
    if (allowed.has(app.id)) return true;
    const answer = caller.gate ? await caller.gate(app) : ({ allow: false, ask: false, reason: "Nobody can be asked about it here." } as const);
    if (answer.allow) {
      allowed.add(app.id);
      return true;
    }
    if (!answer.ask) throw new DesktopError("refused", `${app.name} is ${GATE_WORDS[app.category]}: ${answer.reason}`, "no");
    return false;
  }

  /** Throws `needs_owner` (nothing ran) when the owner must answer for this app first. */
  private async gate(caller: Caller, app: GateApp | null, allowed: Set<string>): Promise<void> {
    if (!app) return;
    if (await this.allowedIn(caller, app, allowed)) return;
    throw new DesktopError("needs_owner", app.category === "screen" ? "Using the owner's pointer and keyboard: your owner is asked once for this work before anything runs on their screen." : `${app.name} is ${GATE_WORDS[app.category]}: your owner is asked once before you use it in this work.`, "no", { app });
  }

  private target(caller: Caller, step: DesktopStep, batchCapture: string | undefined, session: Session): { capture: Capture; screen: ScreenRef } {
    const id = step.captureId ?? batchCapture;
    if (!id) throw new DesktopError("stale_capture", "Coordinates need the captureId of the screenshot they come from (desktop_observe).", "no");
    const checked = this.ledger.check(caller.key, id, session.screens, session.epoch);
    if (!checked.ok) throw new DesktopError(checked.code, checked.message, "no");
    return { capture: checked.capture, screen: session.screens.find((screen) => screen.node === checked.capture.screen.node)! };
  }

  private point(capture: Capture, screen: ScreenRef, x: number, y: number): { x: number; y: number } {
    const mapped = imageToLogical({ x, y }, capture.image, capture.region, { width: screen.width, height: screen.height });
    return { x: mapped.x, y: mapped.y };
  }

  private element(caller: Caller, id: string): { capture: Capture; element: HelperElement; tree: NonNullable<Capture["tree"]> } {
    const capture = this.ledger.current(caller.key);
    if (!capture) throw new DesktopError("stale_capture", "Element ids come from your latest desktop_observe, and you have no current one: look again.", "no");
    const tree = capture.tree;
    if (!tree) throw new DesktopError("observation_required", "Your latest observation read no elements: look again with elements, or aim at coordinates.", "no");
    const element = tree.elements.get(id);
    if (!element) throw new DesktopError("element_gone", `There is no element ${id} in your latest observation (${capture.id}).`, "no");
    return { capture, element, tree };
  }

  private async frameState(node: number, deadline: Deadline, settleMs = 0): Promise<{ hash: number | null; settled: boolean | null }> {
    if (settleMs > 0) {
      const settled = await this.call<{ settled: boolean | null; hash: number | null }>("frame.settle", { display: node, min_ms: 120, timeout_ms: settleMs }, deadline, { maxMs: settleMs + 3_000 });
      return { hash: settled.hash, settled: settled.settled };
    }
    const state = await this.call<{ hash: number }>("frame.state", { display: node }, deadline, { maxMs: 5_000 });
    return { hash: state.hash, settled: null };
  }

  /** Verdict from the screen before and after: changed and settled, unchanged and settled, or not known. */
  private screenVerdict(before: { hash: number | null; settled: boolean | null } | null, after: { hash: number | null; settled: boolean | null } | null): StepVerdict {
    if (!before || !after || before.hash === null || after.hash === null) return "unknown";
    if (before.hash !== after.hash) return after.settled ? "confirmed" : "unknown";
    return settledPair(before, after) ? "no_effect" : "unknown";
  }

  private refuse(hit: FloorHit | null): void {
    if (hit) throw new DesktopError("refused", hit.message, "no", { rule: hit.rule });
  }

  private async step(caller: Caller, step: DesktopStep, batchCapture: string | undefined, deadline: Deadline, context: StepContext): Promise<Omit<StepOutcome, "index" | "action">> {
    if (context.background && step.action !== "wait") return this.elementStep(caller, step, deadline, context);
    switch (step.action) {
      case "wait": {
        await this.sleep(Math.min(step.ms ?? 0, Math.max(0, deadline.remaining() - 6_000)));
        return { verdict: "confirmed", ran: "yes" };
      }
      case "open": {
        const opened = await this.openApp(caller, step.app!, 8_000, deadline, context.allowed);
        return { verdict: opened.stages.window ? "confirmed" : opened.stages.accepted ? "partial" : "no_effect", ran: "yes", detail: `${opened.app.name}: ${Object.entries(opened.stages).filter(([, ok]) => ok).map(([stage]) => stage).join(", ") || "not started"}` };
      }
      case "press":
      case "focus":
      case "set_text":
      case "select":
      case "toggle":
        return this.elementStep(caller, step, deadline, context);
      case "click":
      case "double_click":
      case "right_click":
        if (step.element) {
          if (step.action !== "click" || (step.button && step.button !== "left")) throw new DesktopError("bad_input", `${step.action} on an element is not possible: aim at its coordinates instead.`, "no");
          return this.elementStep(caller, { ...step, action: "press" }, deadline, context);
        }
        return this.pointerStep(caller, step, batchCapture, deadline, context);
      case "scroll":
        if (step.element) return this.elementStep(caller, step, deadline, context);
        return this.pointerStep(caller, step, batchCapture, deadline, context);
      case "move":
      case "drag":
        return this.pointerStep(caller, step, batchCapture, deadline, context);
      case "type":
      case "key":
        return this.keyboardStep(caller, step, deadline, context);
    }
  }

  private async pointerStep(caller: Caller, step: DesktopStep, batchCapture: string | undefined, deadline: Deadline, context: StepContext): Promise<Omit<StepOutcome, "index" | "action">> {
    const aimed = step.captureId ?? batchCapture;
    if (aimed && this.ledger.get(aimed)?.treeOnly) throw new DesktopError("observation_required", `${aimed} read elements only, without a screenshot: aim at its element ids, or look with a screenshot to aim at coordinates.`, "no");
    const session = await this.ensureSession(deadline);
    let node: number;
    let at: { x: number; y: number } | null = null;
    let from: { x: number; y: number } | null = null;
    let to: { x: number; y: number } | null = null;
    if (step.action === "drag") {
      const { capture, screen } = this.target(caller, step, batchCapture, session);
      node = screen.node;
      from = this.point(capture, screen, step.from![0], step.from![1]);
      to = this.point(capture, screen, step.to![0], step.to![1]);
    } else if (step.x !== undefined && step.y !== undefined) {
      const { capture, screen } = this.target(caller, step, batchCapture, session);
      node = screen.node;
      at = this.point(capture, screen, step.x, step.y);
    } else {
      node = (session.screens.find((screen) => screen.primary) ?? session.screens[0]!).node;
    }
    if (POINTER_STEPS.has(step.action) || step.action === "scroll") {
      const [focus, apps] = await Promise.all([
        this.call<FocusInfo>("a11y.focus", { text: false, documents: true }, deadline, { maxMs: 8_000 }),
        this.call<{ apps: HelperApp[] }>("a11y.apps", {}, deadline, { maxMs: 8_000 }),
      ]).catch((error: unknown) => {
        throw new DesktopError("refused", `What is on the screen could not be checked (${fromHelper(error).message}), so the ${step.action === "scroll" ? "scroll" : "click"} was not sent.`, "no");
      });
      if (POINTER_STEPS.has(step.action)) this.refuse(pointerFloor(focus, apps.apps, this.options.env));
      // The desktop does not say which window a point is in: every sensitive app that shows may be where it lands.
      for (const app of this.sensitiveShowing(focus, apps.apps)) await this.gate(caller, app, context.allowed);
    }
    if (step.action === "move") {
      await this.call("input.pointer", { display: node, x: at!.x, y: at!.y, action: "move" }, deadline, { effects: true, maxMs: 5_000 });
      this.lease.agentInput();
      return { verdict: "confirmed", ran: "yes" };
    }
    // The pointer goes there first, so the cursor and any hover are in the picture before the click.
    if (at && step.action !== "scroll") {
      await this.call("input.pointer", { display: node, x: at.x, y: at.y, action: "move" }, deadline, { effects: true, maxMs: 5_000 });
      this.lease.agentInput();
    }
    const before = await this.frameState(node, deadline, 600).catch(() => null);
    try {
      if (step.action === "drag") await this.call("input.drag", { display: node, from: [from!.x, from!.y], to: [to!.x, to!.y], button: step.button ?? "left" }, deadline, { effects: true, maxMs: 15_000 });
      else if (step.action === "scroll") await this.call("input.scroll", { display: node, direction: step.direction, amount: step.amount ?? 3, ...(at ? { x: at.x, y: at.y } : {}) }, deadline, { effects: true, maxMs: 10_000 });
      else await this.call("input.pointer", { display: node, x: at!.x, y: at!.y, action: "click", button: step.action === "right_click" ? "right" : (step.button ?? "left"), count: step.action === "double_click" ? 2 : 1 }, deadline, { effects: true, maxMs: 8_000 });
    } finally {
      this.lease.agentInput();
    }
    const after = await this.frameState(node, deadline, 1_500).catch(() => null);
    const verdict = this.screenVerdict(before, after);
    return { verdict, ran: "yes", ...(verdict === "unknown" ? { detail: "Sent; the screen kept changing, so its effect was not seen." } : verdict === "no_effect" ? { detail: "Sent, and nothing on the screen changed." } : {}) };
  }

  private async keyboardStep(caller: Caller, step: DesktopStep, deadline: Deadline, context: StepContext): Promise<Omit<StepOutcome, "index" | "action">> {
    const session = await this.ensureSession(deadline);
    const node = (session.screens.find((screen) => screen.primary) ?? session.screens[0]!).node;
    let text: string | null = null;
    let secretName: string | null = null;
    if (step.element) {
      // Typing into an element: it takes the focus first, and the keyboard goes only where it went.
      const { element, tree } = this.element(caller, step.element);
      const focusNow = await this.call<FocusInfo>("a11y.focus", { text: false, documents: true }, deadline, { maxMs: 8_000 });
      this.refuse(elementFloor({ name: tree.app.name, app_id: tree.app.id, toolkit: tree.app.toolkit }, tree.window, focusNow, this.options.env));
      await this.call("a11y.do", { tree_id: tree.id, element: element.id, action: "focus" }, deadline, { effects: true, maxMs: 5_000 });
    }
    const focus = await this.call<FocusInfo>("a11y.focus", { text: true, documents: true }, deadline, { maxMs: 8_000 });
    this.refuse(keyboardFloor(focus, this.options.env));
    if (step.element) {
      const { element, tree } = this.element(caller, step.element);
      const same = focus.app && (focus.app.pid === tree.app.pid || focus.app.name === tree.app.name);
      if (!same || !focus.focused || (focus.focused.role !== element.role && focus.focused.name !== element.name)) {
        throw new DesktopError("refused", `${step.element} did not take the keyboard (its window may not be in front), so nothing was typed. Click it first, or use set_text.`, "no");
      }
    }
    await this.gate(caller, focus.app ? this.gateApp(focus.app) : null, context.allowed);
    if (step.action === "type") {
      const ref = SECRET_REF.exec(step.text!.trim());
      if (ref) {
        if (focus.focused?.role !== "password text") throw new DesktopError("refused", `A saved secret goes only into a password field, and the field with the keyboard is a ${focus.focused?.role ?? "nothing"}.`, "no", { rule: "secret_field" });
        const value = caller.secret ? await caller.secret(ref[1]!, { origin: pageOrigin(focus, focus.window?.title ?? null) }) : null;
        if (!value) throw new DesktopError("refused", `There is no saved secret named ${ref[1]} that may go here (a secret limited to some websites goes only to their pages).`, "no", { rule: "secret_field" });
        text = value;
        secretName = ref[1]!;
      } else {
        if (looksSecret(step.text!, context.secrets)) throw new DesktopError("refused", SECRET_TEXT_MESSAGE, "no", { rule: "secret_text" });
        if (focus.focused?.role === "password text") throw new DesktopError("refused", "Password fields take a saved secret by its name ($NAME), never typed text. Hand it to your owner with desktop_handoff if no secret is saved for it.", "no", { rule: "secret_field" });
        text = step.text!;
      }
    }
    const beforeText = focus.focused?.text;
    const before = await this.frameState(node, deadline, 400).catch(() => null);
    let typed: { keysym: number; atspi: number; clipboard: number; untyped: number } | null = null;
    let stopped: TypingStop | null = null;
    try {
      if (step.action === "key") await this.call("input.keys", { keys: step.keys, repeat: step.repeat ?? 1 }, deadline, { effects: true, maxMs: 10_000 });
      else {
        const answer = await this.call<{ typed: { keysym: number; atspi: number; clipboard: number; untyped: number }; stopped?: TypingStop | null }>("input.text", { text, ...(secretName ? { secret: true } : {}) }, deadline, { effects: true, maxMs: Math.min(60_000, 5_000 + text!.length * 60) });
        typed = answer.typed;
        stopped = answer.stopped ?? null;
      }
    } catch (error) {
      const failure = fromHelper(error);
      // A secret's value never comes back, even in an error.
      if (secretName) throw new DesktopError(failure.code, `Typing ${secretName} did not finish.`, failure.ran);
      throw failure;
    } finally {
      this.lease.agentInput();
    }
    if (stopped === "secret_untypeable") {
      throw new DesktopError("refused", `${secretName} has characters this keyboard layout cannot type, and the password field does not take text through accessibility, so nothing of it was typed (a secret never goes through the clipboard). Hand the field to your owner with desktop_handoff.`, "no", { rule: "secret_field" });
    }
    if (stopped) {
      const done = typed ? typed.keysym + typed.atspi + typed.clipboard : 0;
      const what = secretName ? `Typing ${secretName} stopped part way` : `Typing stopped after ${done} of ${text!.length} characters`;
      if (stopped === "owner_input") {
        this.lease.take("owner_input");
        this.ledger.invalidateAll();
        return { verdict: "partial", ran: "yes", detail: `${what}: your owner used the keyboard or mouse, so the computer is theirs until two minutes after their last input.` };
      }
      return { verdict: "partial", ran: "yes", detail: `${what}: the window in front changed, so the rest was not typed.` };
    }
    const after = await this.frameState(node, deadline, 1_000).catch(() => null);
    if (typed && typed.untyped > 0) return { verdict: "partial", ran: "yes", detail: `${typed.untyped} characters could not be typed on this keyboard layout.` };
    if (step.action === "type" && !secretName && typeof beforeText === "string") {
      const now = await this.call<FocusInfo>("a11y.focus", { text: true, documents: false }, deadline, { maxMs: 5_000 }).catch(() => null);
      const textNow = now?.focused?.text;
      if (typeof textNow === "string") {
        if (textNow.includes(text!)) return { verdict: "confirmed", ran: "yes" };
        if (textNow === beforeText) return { verdict: "no_effect", ran: "yes", detail: "Typed, and the field's text did not change." };
        return { verdict: "partial", ran: "yes", detail: "The field's text changed, but it does not hold all of what was typed." };
      }
    }
    const verdict = this.screenVerdict(before, after);
    return { verdict, ran: "yes", ...(verdict === "no_effect" ? { detail: "Sent, and nothing on the screen changed." } : verdict === "unknown" ? { detail: "Sent; its effect was not seen." } : {}) };
  }

  private async elementStep(caller: Caller, step: DesktopStep, deadline: Deadline, context: StepContext): Promise<Omit<StepOutcome, "index" | "action">> {
    const { capture, element, tree } = this.element(caller, step.element!);
    // A look at elements only works without screen control: nothing on the screen is compared then.
    const screen = !capture.treeOnly;
    if (screen) await this.ensureSession(deadline);
    const focus = await this.call<FocusInfo>("a11y.focus", { text: false, documents: true }, deadline, { maxMs: 8_000 });
    this.refuse(elementFloor({ name: tree.app.name, app_id: tree.app.id, toolkit: tree.app.toolkit }, tree.window, focus, this.options.env));
    await this.gate(caller, this.gateApp({ name: tree.app.name, app_id: tree.app.id }), context.allowed);
    if (context.background) await this.waitWhileOwnerUses({ name: tree.app.name, pid: tree.app.pid }, context.idleMs, deadline);
    let text: string | null = null;
    let secret = false;
    // Typing into an element in the background goes in through accessibility at its caret, never the keyboard.
    const typing = step.action === "type";
    if (step.action === "set_text" || typing) {
      const ref = SECRET_REF.exec((step.text ?? "").trim());
      if (ref) {
        if (element.role !== "password text") throw new DesktopError("refused", `A saved secret goes only into a password field, and ${element.id} is a ${element.role}.`, "no", { rule: "secret_field" });
        const value = caller.secret ? await caller.secret(ref[1]!, { origin: pageOrigin(focus, tree.window) }) : null;
        if (!value) throw new DesktopError("refused", `There is no saved secret named ${ref[1]} that may go here (a secret limited to some websites goes only to their pages).`, "no", { rule: "secret_field" });
        text = value;
        secret = true;
      } else {
        if (looksSecret(step.text ?? "", context.secrets)) throw new DesktopError("refused", SECRET_TEXT_MESSAGE, "no", { rule: "secret_text" });
        if (element.role === "password text") throw new DesktopError("refused", "Password fields take a saved secret by its name ($NAME), never typed text.", "no", { rule: "secret_field" });
        text = step.text ?? "";
      }
    }
    const node = capture.screen.node;
    const before = screen ? await this.frameState(node, deadline, 400).catch(() => null) : null;
    const action = step.action === "set_text" || (typing && secret) ? "set_text" : typing ? "insert_text" : step.action === "focus" ? "focus" : step.action === "select" ? "select" : step.action === "toggle" ? "toggle" : step.action === "scroll" ? "scroll_to" : "press";
    let done: { done: boolean; via: string; verified?: boolean | null; states_before?: string[]; states_after?: string[] };
    try {
      done = await this.call("a11y.do", { tree_id: tree.id, element: element.id, action, ...(step.name ? { name: step.name } : {}), ...(text !== null ? { text } : {}), ...(context.background ? { background: true } : {}) }, deadline, { effects: true, maxMs: 8_000 });
    } catch (error) {
      const failure = fromHelper(error);
      if (failure.code === "element_gone") this.ledger.invalidate(caller.key);
      if (secret) throw new DesktopError(failure.code, "Filling the password field did not finish.", failure.ran);
      throw failure;
    }
    if (!done.done) return { verdict: "no_effect", ran: "yes", detail: `The app did not take the ${action.replace("_", " ")}.` };
    if (action === "set_text" || action === "insert_text") {
      if (done.verified === true) return { verdict: "confirmed", ran: "yes" };
      if (done.verified === false) return { verdict: "partial", ran: "yes", detail: "The field's text is not exactly what was set." };
    }
    if (action === "focus" && done.states_after?.includes("focused")) return { verdict: "confirmed", ran: "yes" };
    const statesChanged = JSON.stringify(done.states_before ?? []) !== JSON.stringify(done.states_after ?? []);
    if (statesChanged) return { verdict: "confirmed", ran: "yes" };
    if (!screen) return { verdict: "unknown", ran: "yes", detail: "The app took it; look at its elements again to see what changed." };
    const after = await this.frameState(node, deadline, 1_200).catch(() => null);
    const verdict = this.screenVerdict(before, after);
    return { verdict: verdict === "no_effect" ? "unknown" : verdict, ran: "yes", ...(verdict !== "confirmed" ? { detail: "The app took it; no change was seen on the screen." } : {}) };
  }

  // ── apps ─────────────────────────────────────────────────────────────────

  async open(caller: Caller, input: { app: string; waitSec?: number }): Promise<OpenResult> {
    return this.runAs(caller, async (deadline) => {
      const allowed = new Set<string>();
      // An app opened on the owner's screen takes its front: that is the foreground, asked once per mission.
      if (this.screenName === "owner") await this.gate(caller, OWNER_SCREEN_GATE, allowed);
      await this.guard(deadline);
      const opened = await this.openApp(caller, input.app, (input.waitSec ?? 8) * 1000, deadline, allowed);
      this.ledger.invalidate(caller.key);
      return opened;
    });
  }

  private async openApp(caller: Caller, ref: string, waitMs: number, deadline: Deadline, allowed: Set<string>): Promise<OpenResult> {
    await this.ensureSession(deadline);
    const found = await this.call<{ apps: Array<{ id: string; name: string }> }>("apps.catalog", { query: ref, limit: 5 }, deadline);
    const exact = found.apps.find((app) => app.id.toLowerCase() === ref.toLowerCase() || app.name.toLowerCase() === ref.toLowerCase()) ?? found.apps[0];
    if (!exact) throw new DesktopError("not_found", `No installed app is called ${ref}. desktop_apps lists them.`, "no");
    await this.gate(caller, this.gateApp({ name: exact.name, app_id: exact.id }), allowed);
    const launched = await this.call<{ app: { id: string; name: string; running: HelperApp | null }; stages: Record<string, boolean>; waited_ms: number }>(
      "apps.launch",
      { id: exact.id, wait_ms: Math.min(20_000, waitMs) },
      deadline,
      { effects: true, maxMs: Math.min(30_000, waitMs + 10_000) },
    );
    let focused = Boolean(launched.stages.focused);
    let via: string | null = focused ? "launch" : null;
    if (!focused && launched.app.running && this.lease.holder === "agent") {
      const moved = await this.call<{ focused: boolean; via: string | null }>("apps.focus", { app: launched.app.running.pid ?? launched.app.name, allow_input: true, search: launched.app.name }, deadline, { effects: true, maxMs: 10_000 }).catch(() => null);
      if (moved?.via === "search") this.lease.agentInput();
      focused = Boolean(moved?.focused);
      via = moved?.via ?? null;
    }
    return { screen: this.screenName, app: { id: launched.app.id, name: launched.app.name }, stages: { ...launched.stages, focused }, focused, via, waitedMs: launched.waited_ms };
  }

  // ── recording ────────────────────────────────────────────────────────────

  async recordStart(caller: Caller, input: { display?: string | number; maxSec?: number; evidenceDir: string }): Promise<{ screen: ScreenName; id: string; display: string; container: string; maxSec: number }> {
    return this.runAs(caller, async (deadline) => {
      await this.guard(deadline, "look");
      const prior = this.recording;
      if (prior && prior.endedAt === null) {
        throw new DesktopError("recording_active", prior.owner === caller.key ? "Your recording is already running: save or discard it first." : "Another conversation is recording the screen.", "no");
      }
      // Another conversation's finished recording waits its time to be saved before a new one replaces it.
      if (prior && prior.owner !== caller.key && !prior.lost && this.now() < prior.endedAt! + RECORDING_SAVE_MS) {
        throw new DesktopError("recording_active", "Another conversation's recording waits to be saved; try again in a few minutes.", "no");
      }
      if (prior) await this.dropRecording(prior, deadline);
      const session = await this.ensureSession(deadline);
      const screen = this.pickScreen(session, input.display);
      await mkdir(input.evidenceDir, { recursive: true, mode: 0o700 });
      const temp = join(input.evidenceDir, `.desktop-recording-${randomBytes(6).toString("hex")}.part`);
      const maxSec = Math.min(600, Math.max(1, input.maxSec ?? 120));
      const started = await this.call<{ id: string; container: string; codec: string; mime: string }>("record.start", { display: screen.node, path: temp, max_ms: maxSec * 1000, fps: 30 }, deadline, { maxMs: 15_000 });
      const startedAt = this.now();
      this.recording = { id: started.id, owner: caller.key, node: screen.node, temp, dir: input.evidenceDir, startedAt, maxMs: maxSec * 1000, mime: started.mime, container: started.container, codec: started.codec, ended: null, endedAt: null, lost: false, counter: this.lease.counter };
      this.dropped.delete(caller.key);
      this.controllers.pin(caller.key, startedAt + maxSec * 1000 + RECORDING_STOP_GRACE_MS + RECORDING_SAVE_MS);
      const index = session.screens.indexOf(screen);
      return { screen: this.screenName, id: started.id, display: displayId(screen, index), container: started.container, maxSec };
    });
  }

  async recordSave(caller: Caller, input: { name?: string }): Promise<SavedRecording> {
    // A recording that was dropped needs no screen to say so.
    if (this.dropped.has(caller.key) && this.recording?.owner !== caller.key) throw this.noRecording(caller.key, "");
    return this.runAs(caller, async (deadline) => {
      const recording = this.recording;
      if (!recording || recording.owner !== caller.key) throw this.noRecording(caller.key, "You have no recording to save: start one first.");
      if (recording.lost) {
        this.recording = null;
        this.controllers.pin(caller.key, null);
        await rm(recording.temp, { force: true }).catch(() => undefined);
        throw new DesktopError("failed", "The recording was lost when the desktop helper stopped.", "no");
      }
      let stopped: { reason: string };
      try {
        stopped = await this.call<{ reason: string }>("record.stop", { id: recording.id }, deadline, { maxMs: 30_000 });
      } catch (error) {
        this.recording = null;
        this.controllers.pin(caller.key, null);
        await rm(recording.temp, { force: true }).catch(() => undefined);
        throw fromHelper(error);
      }
      this.recording = null;
      this.controllers.pin(caller.key, null);
      return this.finishRecording(recording, input.name, stopped.reason, deadline);
    });
  }

  async recordDiscard(caller: Caller): Promise<{ discarded: boolean }> {
    if (this.dropped.has(caller.key) && this.recording?.owner !== caller.key) throw this.noRecording(caller.key, "");
    return this.runAs(caller, async (deadline) => {
      const recording = this.recording;
      if (!recording || recording.owner !== caller.key) throw this.noRecording(caller.key, "You have no recording to discard.");
      await this.dropRecording(recording, deadline);
      return { discarded: true };
    });
  }

  /** `no_recording`, saying why when the controller's recording was dropped. */
  private noRecording(key: string, otherwise: string): DesktopError {
    const why = this.dropped.get(key);
    this.dropped.delete(key);
    return new DesktopError("no_recording", why ?? otherwise, "no");
  }

  private async dropRecording(recording: RecordingState, deadline: Deadline): Promise<void> {
    if (!recording.lost) await this.call("record.discard", { id: recording.id }, deadline, { maxMs: 15_000 }).catch(() => undefined);
    await rm(recording.temp, { force: true }).catch(() => undefined);
    if (this.recording === recording) this.recording = null;
    this.controllers.pin(recording.owner, null);
  }

  /** Checks the stopped recording by decoding it, then gives it its name without ever replacing a file. */
  private async finishRecording(recording: RecordingState, name: string | undefined, reason: string, deadline: Deadline): Promise<SavedRecording> {
    const extension = recording.container === "mp4" ? "mp4" : "webm";
    const base = (name ?? "desktop-recording").normalize("NFKD").replace(/[^\w\s-]/g, "").trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/-+/g, "-").slice(0, 60).replace(/^-|-$/g, "") || "desktop-recording";
    let stem = "";
    for (let n = 1; n < 1000 && !stem; n += 1) {
      const candidate = join(recording.dir, `${base}${n === 1 ? "" : `-${n}`}`);
      const taken = await Promise.all([`${candidate}.${extension}`, `${candidate}.poster.jpg`, `${candidate}.preview.jpg`].map((path) => stat(path).then(() => true, () => false)));
      if (!taken.some(Boolean)) stem = candidate;
    }
    if (!stem) throw new DesktopError("failed", "Too many recordings with that name.", "no");
    const final = `${stem}.${extension}`;
    let checked: { frames: number; duration_ms: number; width: number; height: number; codec: string | null; size: number; poster?: { path: string; width: number; height: number }; preview?: { path: string; width: number; height: number } };
    try {
      checked = await this.call("media.check", { path: recording.temp, poster_path: `${stem}.poster.jpg`, preview_path: `${stem}.preview.jpg` }, deadline, { maxMs: 60_000 });
    } catch (error) {
      await Promise.all([recording.temp, `${stem}.poster.jpg`, `${stem}.preview.jpg`].map((path) => rm(path, { force: true }).catch(() => undefined)));
      throw fromHelper(error);
    }
    try {
      await link(recording.temp, final);
    } catch (error) {
      await Promise.all([recording.temp, `${stem}.poster.jpg`, `${stem}.preview.jpg`].map((path) => rm(path, { force: true }).catch(() => undefined)));
      throw new DesktopError("failed", `The recording could not be saved (${(error as NodeJS.ErrnoException).code ?? "error"}).`, "no");
    }
    await unlink(recording.temp).catch(() => undefined);
    const still = async (item: { path: string; width: number; height: number } | undefined): Promise<StillRef | undefined> => {
      if (!item) return undefined;
      const info = await stat(item.path).catch(() => null);
      return info ? { path: item.path, mime: "image/jpeg", size: info.size, width: item.width, height: item.height } : undefined;
    };
    const sha256 = await new Promise<string>((resolve, reject) => {
      const hash = createHash("sha256");
      createReadStream(final)
        .on("data", (chunk) => hash.update(chunk))
        .on("end", () => resolve(hash.digest("hex")))
        .on("error", reject);
    });
    const size = (await stat(final)).size;
    const durationMs = Math.max(0, Math.round(checked.duration_ms));
    const takenOver = this.lease.counter !== recording.counter;
    return {
      path: final,
      kind: "video",
      mime: recording.container === "mp4" ? "video/mp4" : "video/webm",
      size,
      sha256,
      width: checked.width,
      height: checked.height,
      durationMs,
      fps: durationMs > 0 ? Math.round((checked.frames * 1000) / durationMs) : 0,
      frames: checked.frames,
      codec: recording.codec,
      poster: await still(checked.poster),
      preview: await still(checked.preview),
      held: true,
      reason: takenOver ? `${DESKTOP_HOLD_REASON} You also used the computer while it recorded.` : DESKTOP_HOLD_REASON,
      ...(reason === "max_duration" ? { truncated: true } : {}),
    };
  }

  // ── evidence for the capture tools (capture_screenshot and capture_video with target desktop) ──

  /** One screenshot of a whole screen at full size into `evidenceDir`, held for the owner's preview. */
  async evidenceScreenshot(input: { evidenceDir: string; name?: string; display?: string | number; budgetMs?: number }): Promise<StillRef & { held: true; reason: string }> {
    return this.run(input.budgetMs ?? 45_000, async (deadline) => {
      await this.guard(deadline, "look");
      const session = await this.ensureSession(deadline);
      const screen = this.pickScreen(session, input.display);
      await mkdir(input.evidenceDir, { recursive: true, mode: 0o700 });
      const base = (input.name ?? "screen").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "screen";
      for (let n = 1; n < 1000; n += 1) {
        const path = join(input.evidenceDir, `${base}${n === 1 ? "" : `-${n}`}.png`);
        if (await stat(path).then(() => true, () => false)) continue;
        const shot = await this.call<CaptureResult>("frame.capture", { display: screen.node, settle: { min_ms: 0, timeout_ms: 1_000 }, max_long_edge: 0, format: "png", save_path: path, inline: false }, deadline, { maxMs: 20_000 });
        return { path, mime: "image/png", size: shot.image.bytes, width: shot.image.width, height: shot.image.height, held: true, reason: DESKTOP_HOLD_REASON };
      }
      throw new DesktopError("failed", "Too many screenshots with that name.", "no");
    });
  }

  /** A recording of `seconds` for capture_video: the same single recording, never alongside another. */
  async evidenceVideo(input: { evidenceDir: string; seconds: number; name?: string; display?: string | number }): Promise<SavedRecording> {
    const caller: Caller = { key: `capture:${randomBytes(4).toString("hex")}`, label: "a capture", budgetMs: 30_000 };
    const started = await this.run(30_000, async (deadline) => {
      await this.guard(deadline, "look");
      if (this.recording && this.recording.endedAt === null) throw new DesktopError("recording_active", "The screen is being recorded already.", "no");
      const session = await this.ensureSession(deadline);
      const screen = this.pickScreen(session, input.display);
      await mkdir(input.evidenceDir, { recursive: true, mode: 0o700 });
      const temp = join(input.evidenceDir, `.desktop-recording-${randomBytes(6).toString("hex")}.part`);
      const maxMs = Math.ceil(input.seconds * 1000) + 5_000;
      const begun = await this.call<{ id: string; container: string; codec: string; mime: string }>("record.start", { display: screen.node, path: temp, max_ms: maxMs, fps: 30 }, deadline, { maxMs: 15_000 });
      const state: RecordingState = { id: begun.id, owner: caller.key, node: screen.node, temp, dir: input.evidenceDir, startedAt: this.now(), maxMs, mime: begun.mime, container: begun.container, codec: begun.codec, ended: null, endedAt: null, lost: false, counter: this.lease.counter };
      this.recording = state;
      return state;
    });
    await this.sleep(Math.max(0, input.seconds * 1000));
    return this.run(120_000, async (deadline) => {
      if (this.recording !== started) throw new DesktopError("failed", "The recording ended early (screen control stopped).", "maybe");
      this.recording = null;
      if (started.lost) throw new DesktopError("failed", "The recording was lost when the desktop helper stopped.", "no");
      const stopped = await this.call<{ reason: string }>("record.stop", { id: started.id }, deadline, { maxMs: 30_000 });
      return this.finishRecording(started, input.name ?? "desktop-video", stopped.reason, deadline);
    });
  }

  // ── handing over ─────────────────────────────────────────────────────────

  async handoff(caller: Caller, input: { action?: "ask" | "release" | "status"; reason?: string; message?: string; waitSec?: number }): Promise<{ holder: "agent" | "owner"; returned: boolean; session: string; detail: string }> {
    const action = input.action ?? "ask";
    if (this.screenName === "agent") throw new DesktopError("unsupported", "The agent screen is the agent's own: there is nothing to hand to the owner there. Hand over on the owner's screen.", "no");
    if (action !== "status") {
      this.claim(caller);
      this.controllers.touch(caller.key);
    }
    const sessionState = () => (this.session ? "on" : this.consentFailed ? this.consentFailed.reason : "off");
    if (action === "status") {
      return this.run(caller.budgetMs, async (deadline) => {
        const idle = await this.call<{ locked: boolean | null; idle_ms: number | null }>("idle", {}, deadline, { maxMs: 5_000 }).catch(() => null);
        if (idle && this.lease.observeIdle(idle.idle_ms)) this.ledger.invalidateAll();
        return { holder: this.lease.holder, returned: this.lease.holder === "agent", session: sessionState(), detail: this.lease.holder === "owner" ? `Your owner has the computer since ${clock(this.lease.view().since)}.` : "You may use the computer." };
      });
    }
    if (action === "release") {
      return this.run(caller.budgetMs, async (deadline) => {
        const idle = await this.call<{ locked: boolean | null; idle_ms: number | null }>("idle", {}, deadline, { maxMs: 5_000 });
        if (this.lease.holder === "agent") return { holder: "agent" as const, returned: true, session: sessionState(), detail: "You have the computer already." };
        if (idle.idle_ms !== null && idle.idle_ms < 15_000) {
          return { holder: "owner" as const, returned: false, session: sessionState(), detail: `Your owner used the computer ${Math.round(idle.idle_ms / 1000)} seconds ago: it stays theirs until they stop for a while.` };
        }
        this.lease.release("released");
        this.ledger.invalidateAll();
        return { holder: "agent" as const, returned: true, session: sessionState(), detail: "You have the computer again: look before acting." };
      });
    }
    const reason = input.reason ?? "other";
    if (reason === "consent" && this.session) return { holder: this.lease.holder, returned: this.lease.holder === "agent", session: "on", detail: "Screen control is allowed already: look with desktop_observe." };
    const waitMs = Math.min(240, Math.max(0, input.waitSec ?? 60)) * 1000;
    await this.run(15_000, async (deadline) => {
      this.lease.take("handoff");
      this.ledger.invalidateAll();
      const body = input.message?.trim() || (reason === "consent" ? "Allow screen control in the dialog on this computer, if you want Ensemble's agent to use it." : "Ensemble's agent needs you here for a moment. It continues when you are done.");
      await this.call("notify", { title: "Ensemble's agent handed you control", body }, deadline, { maxMs: 5_000 }).catch(() => undefined);
      // The consent dialog belongs to the start of screen control: start it, so it shows while the owner is asked.
      if (reason === "consent" && !this.session) await this.call<SessionInfo>("session.start", { wait_ms: 1_000 }, deadline, { maxMs: 10_000 }).then((info) => {
        if (info.state === "on" && info.streams) this.session = { epoch: info.epoch ?? 0, screens: screensOf(info.streams) };
      }).catch(() => undefined);
    });
    const until = this.now() + waitMs;
    while (this.now() < until && !this.stopped) {
      if (reason === "consent" && (this.session || this.consentFailed)) break;
      await this.sleep(Math.min(2_000, Math.max(0, until - this.now())));
      const idle = await this.run(10_000, (deadline) => this.call<{ locked: boolean | null; idle_ms: number | null }>("idle", {}, deadline, { maxMs: 5_000 })).catch(() => null);
      if (idle && this.lease.observeIdle(idle.idle_ms) === "released") break;
    }
    if (reason === "consent" && this.session) this.lease.release("consent given");
    if (reason === "consent" && this.consentFailed && !this.session) this.lease.release("consent refused");
    const returned = this.lease.holder === "agent";
    const detail =
      reason === "consent"
        ? this.session
          ? "Your owner allowed screen control: look with desktop_observe."
          : this.consentFailed
            ? "Your owner did not allow screen control. Go on without the screen, or ask them in the chat."
            : "Your owner has not answered the dialog yet. Tell them in your reply and end your turn; try again when they say so."
        : returned
          ? "Your owner is done (no input for two minutes): look before acting."
          : "Your owner still has the computer. Tell them in your reply what you need and end your turn; when they say they are done, call desktop_handoff with action release.";
    return { holder: this.lease.holder, returned, session: sessionState(), detail };
  }

  // ── live view ────────────────────────────────────────────────────────────

  /** One small frame of the screen for a live view (not an observation: no capture id, nothing kept). */
  async liveFrame(input: { maxWidth?: number; display?: string | number } = {}, budgetMs = 10_000): Promise<LiveFrame> {
    return this.run(budgetMs, async (deadline) => {
      await this.guard(deadline, "look");
      const session = await this.ensureSession(deadline);
      const screen = this.pickScreen(session, input.display);
      const shot = await this.call<CaptureResult>("frame.capture", { display: screen.node, max_long_edge: Math.min(1920, Math.max(160, Math.round(input.maxWidth ?? 1024))), format: "jpeg", quality: 60, inline: true }, deadline, { maxMs: 8_000 });
      return { screen: this.screenName, mime: "image/jpeg", base64: shot.image.base64 ?? "", width: shot.image.width, height: shot.image.height, at: shot.at };
    });
  }

  /** Frames for a live view, one at a time and at most `fps` a second, until the returned stop is called. */
  liveFrames(options: { fps?: number; maxWidth?: number }, onFrame: (frame: LiveFrame) => void, onError?: (error: DesktopError) => void): () => void {
    let stopped = false;
    const gap = 1000 / Math.min(10, Math.max(0.2, options.fps ?? 2));
    const next = async () => {
      while (!stopped) {
        const started = this.now();
        try {
          onFrame(await this.liveFrame({ maxWidth: options.maxWidth }));
        } catch (error) {
          onError?.(fromHelper(error));
        }
        await this.sleep(Math.max(50, gap - (this.now() - started)));
      }
    };
    void next();
    return () => {
      stopped = true;
    };
  }

  /** Whether the helper runs now (for the agent screen: whether the screen is up). Asking never starts it. */
  get helperReady(): boolean {
    return this.options.helper.health().state === "ready";
  }

  /** Whether `key` has a recording here (running, or ended and not saved yet). */
  hasRecording(key: string): boolean {
    return this.recording?.owner === key;
  }

  /** The end of a controller's work (a run ended): a call of its going on is cancelled, and its claim, line place and recording go. */
  async release(key: string): Promise<void> {
    if (this.current?.key === key) this.current.abort.abort();
    this.dropped.delete(key);
    this.controllers.release(key);
    this.ledger.forget(key);
    const recording = this.recording;
    if (recording && recording.owner === key) await this.run(20_000, (deadline) => this.dropRecording(recording, deadline)).catch(() => undefined);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.current?.abort.abort();
    if (this.recordingTimer) clearTimeout(this.recordingTimer);
    const recording = this.recording;
    if (recording) await this.run(20_000, (deadline) => this.dropRecording(recording, deadline)).catch(() => undefined);
    this.stopped = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.session = null;
    await this.options.helper.stop().catch(() => undefined);
  }
}
