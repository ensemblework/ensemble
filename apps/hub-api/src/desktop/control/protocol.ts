/**
 * The desktop helper's protocol (desktop-helper/linux/ensemble_desktop.py): JSON-RPC 2.0 over the
 * helper's stdin and stdout, one JSON object per line, one request at a time. Every request may carry
 * `deadline_ms`, the time the helper may take; the caller gives it less time than it waits itself, so a
 * request the caller gave up on never acts later. Errors carry a stable `data.kind` and `data.ran`.
 */

export const HELPER_PROTOCOL = 1;

/** Whether what a request asked for may have happened on the desktop. */
export type Ran = "no" | "maybe" | "yes";

export const HELPER_ERROR_KINDS = [
  "parse_error",
  "invalid_request",
  "method_not_found",
  "invalid_params",
  "internal",
  "consent_needed",
  "consent_denied",
  "stopped_by_owner",
  "no_session",
  "capture_failed",
  "input_failed",
  "element_gone",
  "target_not_found",
  "not_inspectable",
  "unsupported_here",
  "timeout",
  "cancelled",
  "recording_active",
  "recording_failed",
  "a11y_unavailable",
  "launch_failed",
  "bad_display",
  "no_recording",
  "needs_screen",
] as const;
export type HelperErrorKind = (typeof HELPER_ERROR_KINDS)[number];

/** A typed failure: the helper's own error, or the process not answering (`gone`, `deadline`). */
export class HelperError extends Error {
  constructor(
    readonly kind: HelperErrorKind | "gone" | "deadline" | "unavailable",
    message: string,
    readonly ran: Ran,
    readonly retryable = false,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "HelperError";
  }
}

export function helperErrorOf(error: { code?: unknown; message?: unknown; data?: unknown } | null | undefined, fallbackRan: Ran): HelperError {
  const data = (error?.data && typeof error.data === "object" ? error.data : {}) as Record<string, unknown>;
  const kind = HELPER_ERROR_KINDS.includes(data.kind as HelperErrorKind) ? (data.kind as HelperErrorKind) : "internal";
  const ran = data.ran === "no" || data.ran === "maybe" || data.ran === "yes" ? data.ran : fallbackRan;
  const message = typeof error?.message === "string" ? error.message.slice(0, 2000) : "The desktop helper failed.";
  return new HelperError(kind, message, ran, data.retryable === true, data);
}

export type Stream = {
  node: number;
  x: number;
  y: number;
  width: number;
  height: number;
  frame_width: number;
  frame_height: number;
  name: string | null;
  primary: boolean;
  scale?: number | null;
  mapping_id?: string | null;
};

export type SessionInfo = { state: "on" | "waiting_owner_at_computer" | string; epoch?: number; streams?: Stream[]; clipboard?: boolean; silent?: boolean };

export type CaptureResult = {
  display: number;
  epoch: number;
  image: { width: number; height: number; mime: string; bytes: number; path?: string; base64?: string };
  frame: { width: number; height: number };
  region: [number, number, number, number];
  hash: number;
  seq: number;
  settled: boolean | null;
  waited_ms: number;
  at: number;
};

/**
 * A running app and its windows. `box` (screen pixels, the streams' space) and `z` (higher is further in front)
 * come only from a desktop that says where windows are (macOS); then a click by position is judged by the
 * window it lands in.
 */
export type HelperApp = {
  name: string;
  toolkit: string;
  pid: number | null;
  app_id: string | null;
  windows: Array<{ index: number; title: string; role: string; active: boolean; showing: boolean; iconified: boolean; box?: [number, number, number, number] | null; z?: number | null }>;
};

export type FocusInfo = {
  app: { name: string; toolkit: string; pid: number | null; app_id: string | null } | null;
  window: { index: number | null; title: string; role: string } | null;
  shell: boolean;
  prompt: { title: string } | null;
  focused: { role: string; name: string; editable: boolean; text?: string; caret?: number } | null;
  documents?: Array<{ app: string; url: string | null; window: string; active: boolean }>;
};

export type HelperElement = { id: string; role: string; name: string; states: string[]; actions: string[]; value?: string | number; box?: [number, number, number, number] };

export type TreeResult = {
  tree_id: string;
  app: HelperApp;
  window: { index: number; title: string; role: string; active: boolean; extents: [number, number, number, number] | null };
  elements: HelperElement[];
  truncated: boolean;
  visited: number;
};

export type Fact = { state: string; detail?: string; fix?: string; [key: string]: unknown };

export type StatusResult = {
  /** Linux: session, portal, consent, capture, input, a11y, recorder, screen. macOS: driver, accessibility, screen_recording, capture, input, recorder, screen. */
  facts: Record<string, Fact>;
  session: { state: string; epoch: number; streams?: Stream[] };
  registered: boolean;
  recordings: Array<{ id: string; active: boolean; wall_ms: number }>;
};

export type HelloResult = {
  protocol: number;
  version: string;
  platform: string;
  desktop?: string | null;
  session?: string;
  methods: string[];
  unavailable?: string;
  /** Which screen this helper works on: the owner's, or the agent screen it started (`--agent-screen`). */
  screen?: "owner" | "agent";
  agent?: { display: string; size: [number, number]; version: string | null };
};

export type HelperEvent = { kind: "session.started" | "session.closed" | "session.failed" | "consent.waiting" | "record.stopped" | string; [key: string]: unknown };
