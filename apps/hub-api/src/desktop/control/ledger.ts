/**
 * The observation ledger: every screenshot the model is shown gets a capture id bound to the screen it
 * came from (its logical geometry and the portal session it belongs to) and the time it was taken.
 * Coordinates are taken only for a controller's latest observation (or a zoom of it); anything older, or
 * from a screen that changed since, is refused with "look again". A look at an app's elements without a
 * screenshot (`treeOnly`) gives element ids but no coordinates. A look that failed leaves an observation
 * debt: actions wait until a look works.
 */
import { randomBytes } from "node:crypto";
import type { Region, Size } from "./mapping.js";
import type { HelperElement } from "./protocol.js";

export type ScreenRef = { node: number; x: number; y: number; width: number; height: number; name: string | null; primary: boolean };

export type Capture = {
  id: string;
  controller: string;
  /** The portal session the screen belongs to; a new session means new screens. */
  epoch: number;
  screen: ScreenRef;
  region: Region;
  image: Size;
  frame: Size;
  takenAt: number;
  hash: number;
  /** A zoom's parent: the observation it shows part of. */
  parent: string | null;
  /** The accessibility tree this observation read (its element ids), when it read one. */
  tree: { id: string; app: { name: string; id: string | null; pid: number | null; toolkit: string }; window: string; elements: Map<string, HelperElement> } | null;
  path: string | null;
  /** Elements only, no screenshot: its element ids may be aimed at, never coordinates. */
  treeOnly?: boolean;
};

/** A new capture id, which also names the screenshot's file. */
export function newCaptureId(): string {
  return `cap_${randomBytes(6).toString("hex")}`;
}

export type Verdict = { ok: true; capture: Capture } | { ok: false; code: "stale_capture" | "observation_required"; message: string };

const sameScreen = (a: ScreenRef, b: ScreenRef) => a.node === b.node && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

export class ObservationLedger {
  private readonly captures = new Map<string, Capture>();
  private readonly latest = new Map<string, string>();
  private readonly debts = new Map<string, string>();

  constructor(private readonly keep = 64) {}

  record(capture: Capture): Capture {
    this.captures.set(capture.id, capture);
    if (!capture.parent) {
      this.latest.set(capture.controller, capture.id);
      this.debts.delete(capture.controller);
    }
    while (this.captures.size > this.keep) {
      const oldest = this.captures.keys().next().value as string;
      this.captures.delete(oldest);
    }
    return capture;
  }

  get(id: string): Capture | null {
    return this.captures.get(id) ?? null;
  }

  current(controller: string): Capture | null {
    const id = this.latest.get(controller);
    return id ? (this.captures.get(id) ?? null) : null;
  }

  /** Whether `captureId` may be aimed at now by `controller`, on the screens that exist now. */
  check(controller: string, captureId: string, screens: readonly ScreenRef[], epoch: number): Verdict {
    const capture = this.captures.get(captureId);
    const latest = this.latest.get(controller);
    if (!capture || capture.controller !== controller) return { ok: false, code: "stale_capture", message: `${captureId} is not one of your current observations. Look again with desktop_observe and use its captureId.` };
    const current = capture.parent ?? capture.id;
    if (current !== latest) return { ok: false, code: "stale_capture", message: `${captureId} is older than your latest observation (${latest ?? "none"}). Aim at the latest one, or look again.` };
    if (capture.treeOnly) return { ok: false, code: "observation_required", message: `${captureId} read elements only, without a screenshot: aim at its element ids, or look with a screenshot to aim at coordinates.` };
    if (capture.epoch !== epoch) return { ok: false, code: "stale_capture", message: "The screens changed since that observation (screen control started again). Look again." };
    const screen = screens.find((item) => item.node === capture.screen.node);
    if (!screen || !sameScreen(screen, capture.screen)) return { ok: false, code: "stale_capture", message: "That screen moved, changed size or is gone since the observation. Look again." };
    return { ok: true, capture };
  }

  debt(controller: string): string | null {
    return this.debts.get(controller) ?? null;
  }

  owe(controller: string, why: string): void {
    this.debts.set(controller, why);
    this.latest.delete(controller);
  }

  forget(controller: string): void {
    this.latest.delete(controller);
    this.debts.delete(controller);
    for (const [id, capture] of this.captures) if (capture.controller === controller) this.captures.delete(id);
  }

  /** Every observation of every controller is stale (a new portal session, a takeover, another controller). */
  invalidateAll(): void {
    this.latest.clear();
  }

  /** This controller's observations are stale (its input changed the screen and it did not look again). */
  invalidate(controller: string): void {
    this.latest.delete(controller);
  }
}
