"use client";

/**
 * The Hub's interaction log (docs/07 §1.3), sent to POST /api/telemetry for the operator's analysis
 * of how Ensemble is used. It records which screen is open and how long it is actively used (the tab
 * visible and some input in the last minute), and named actions. Never content: the server keeps a
 * route's shape only (ids become :id), and actions carry short named values, not text.
 */
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { clientPlatform } from "@/lib/platform";

export const IDLE_MS = 60_000;
const TICK_MS = 5_000;
const FLUSH_MS = 30_000;
const MAX_QUEUE = 200;
const MIN_VIEW_MS = 1_000;

type Event = { kind: "view" | "action" | "session"; path: string; at: number; action?: string; durationMs?: number; props?: Record<string, string | number | boolean> };

/** The clock and the browser, swappable in tests. */
export type TrackerEnv = {
  now: () => number;
  visible: () => boolean;
  send: (body: string, beacon: boolean) => Promise<boolean>;
};

const browserEnv: TrackerEnv = {
  now: () => Date.now(),
  visible: () => typeof document === "undefined" || document.visibilityState === "visible",
  async send(body, beacon) {
    if (beacon && typeof navigator !== "undefined" && navigator.sendBeacon) {
      return navigator.sendBeacon("/api/telemetry", new Blob([body], { type: "application/json" }));
    }
    const response = await fetch("/api/telemetry", { method: "POST", body, headers: { "Content-Type": "application/json" }, credentials: "include", keepalive: true });
    return response.ok || response.status === 400;
  },
};

function randomKey(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class Tracker {
  readonly sessionKey: string;
  private queue: Event[] = [];
  private path: string | null = null;
  private viewStart = 0;
  private active = 0;
  private lastTick = 0;
  private lastInput = 0;
  private stopped = false;

  constructor(private readonly env: TrackerEnv = browserEnv, sessionKey = randomKey(), private readonly client: "web" | "desktop" = "web", private readonly viewport?: string) {
    this.sessionKey = sessionKey;
    this.lastInput = env.now();
  }

  /** Input of any kind: the person is here. */
  input(): void {
    this.lastInput = this.env.now();
  }

  /** Adds active time since the last tick: only while the tab is visible and someone used it within IDLE_MS. */
  tick(): void {
    const now = this.env.now();
    if (this.path && this.env.visible() && now - this.lastInput <= IDLE_MS) this.active += Math.max(0, now - this.lastTick);
    this.lastTick = now;
  }

  /** A new screen: the last one is recorded with its active time. */
  navigate(path: string): void {
    if (path === this.path) return;
    this.endView();
    if (this.path === null) this.push({ kind: "session", path, at: this.env.now() });
    this.path = path;
    this.viewStart = this.env.now();
    this.lastTick = this.viewStart;
    this.active = 0;
  }

  action(name: string, props?: Record<string, string | number | boolean>): void {
    this.input();
    this.push({ kind: "action", path: this.path ?? "/", action: name, at: this.env.now(), ...(props ? { props } : {}) });
  }

  /** Records the current screen's active time so far and starts counting again (tab hidden, page closing). */
  endView(): void {
    if (!this.path) return;
    this.tick();
    if (this.active >= MIN_VIEW_MS) this.push({ kind: "view", path: this.path, at: this.viewStart, durationMs: Math.round(this.active) });
    this.viewStart = this.env.now();
    this.active = 0;
  }

  pending(): readonly Event[] {
    return this.queue;
  }

  async flush(beacon = false): Promise<void> {
    if (this.stopped || !this.queue.length) return;
    const events = this.queue.splice(0, 50);
    const body = JSON.stringify({ sessionKey: this.sessionKey, client: this.client, ...(this.viewport ? { viewport: this.viewport } : {}), events });
    const ok = await this.env.send(body, beacon).catch(() => false);
    if (!ok) this.queue.unshift(...events.slice(0, MAX_QUEUE - this.queue.length));
    else if (this.queue.length) await this.flush(beacon);
  }

  stop(): void {
    this.stopped = true;
    this.queue = [];
  }

  private push(event: Event): void {
    if (this.stopped) return;
    this.queue.push(event);
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
  }
}

let current: Tracker | null = null;

/** Records a named action, e.g. track("palette.open"). A no-op outside the signed-in Hub. */
export function track(name: string, props?: Record<string, string | number | boolean>): void {
  current?.action(name, props);
}

/** Records `name` each time `open` turns true: a panel, dialog or dock opening. */
export function useTrackOpen(name: string, open: boolean): void {
  const was = useRef(open);
  useEffect(() => {
    if (open && !was.current) track(name);
    was.current = open;
  }, [name, open]);
}

/** Mounted once inside the signed-in Hub. */
export function InteractionTracker(): null {
  const pathname = usePathname();
  useEffect(() => {
    const platform = clientPlatform();
    const tracker = new Tracker(browserEnv, sessionKey(), platform.native ? "desktop" : "web", `${window.innerWidth}x${window.innerHeight}`);
    current = tracker;
    tracker.navigate(window.location.pathname);
    const onInput = () => tracker.input();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        tracker.endView();
        void tracker.flush(true);
      } else {
        tracker.input();
        tracker.tick();
      }
    };
    const onHide = () => {
      tracker.endView();
      void tracker.flush(true);
    };
    const events = ["pointerdown", "keydown", "wheel", "touchstart", "mousemove"] as const;
    for (const name of events) window.addEventListener(name, onInput, { passive: true, capture: true });
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onHide);
    const ticker = window.setInterval(() => tracker.tick(), TICK_MS);
    const flusher = window.setInterval(() => void tracker.flush(), FLUSH_MS);
    return () => {
      for (const name of events) window.removeEventListener(name, onInput, { capture: true });
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onHide);
      window.clearInterval(ticker);
      window.clearInterval(flusher);
      tracker.endView();
      void tracker.flush(true);
      if (current === tracker) current = null;
    };
  }, []);
  useEffect(() => {
    current?.navigate(pathname);
  }, [pathname]);
  return null;
}

/** One key per browser tab, kept across reloads of that tab. */
function sessionKey(): string {
  try {
    const saved = sessionStorage.getItem("ensemble.telemetry.session");
    if (saved && /^[a-f0-9]{24}$/.test(saved)) return saved;
    const key = randomKey();
    sessionStorage.setItem("ensemble.telemetry.session", key);
    return key;
  } catch {
    return randomKey();
  }
}
