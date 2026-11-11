/** The tour's simulated pointer: authored stops in a scene, natural moves between them, clicks, drags, and handoffs that never jump. */

export type Point = { x: number; y: number };
export type Box = { x: number; y: number; width: number; height: number };
export type Waypoint = {
  /** When the pointer is in place. For a click, when the press lands and the scene reacts. */
  at: number;
  /** A `data-film-target` in the scene (`a|b`: the first one measured). `x`/`y` (percent of the scene) are used until one is. */
  target?: string;
  /** Where on the target, as a fraction of its box. */
  ax?: number;
  ay?: number;
  x: number;
  y: number;
  click?: boolean;
  /** Carry the scene's `data-film-drag` element from the previous stop to this one on the scene's own beat. */
  drag?: boolean;
};
export type Pose = Point & { press: number; ripple: (Point & { t: number }) | null; drag: { offset: Point; lift: number; tilt: number } | null };

/** Arrive a moment before the click so the press reads as deliberate. */
export const PRESS_LEAD = 170;
const RELEASE = 150;
const RIPPLE = 560;

/** Pointer travel time grows with distance, as aimed hand movements do (Fitts). */
export function moveDuration(distance: number) {
  return Math.max(260, Math.min(760, 120 + 105 * Math.log2(1 + distance / 16)));
}

/** A short, smooth start and a long settle: how a hand homes in on a target. */
export function glide(t: number) {
  const s = Math.pow(Math.max(0, Math.min(1, t)), 0.8);
  return s * s * s * (10 + s * (-15 + 6 * s));
}

const smooth = (t: number) => { const c = Math.max(0, Math.min(1, t)); return c * c * (3 - 2 * c); };

/** The side a wrist-driven move bows towards: away from a hand resting below and to the right. */
function bowNormal(dx: number, dy: number): Point {
  const length = Math.hypot(dx, dy) || 1;
  let n = { x: dy / length, y: -dx / length };
  if (n.y > 0 || (n.y === 0 && n.x > 0)) n = { x: -n.x, y: -n.y };
  return n;
}

export type Targets = Record<string, Box>;
export function resolveStop(stop: Waypoint, targets: Targets, scene: Box): Point {
  const box = stop.target?.split("|").map((name) => targets[name]).find(Boolean);
  if (box) return { x: box.x + box.width * (stop.ax ?? .5), y: box.y + box.height * (stop.ay ?? .5) };
  return { x: scene.x + stop.x / 100 * scene.width, y: scene.y + stop.y / 100 * scene.height };
}

type Segment = { from: Point; to: Point; depart: number; arrive: number; drag: boolean };
export function cursorSegments(path: Waypoint[], targets: Targets, scene: Box): Segment[] {
  const stops = path.map((stop) => resolveStop(stop, targets, scene));
  const segments: Segment[] = [];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const from = stops[i - 1]!;
    const to = stops[i]!;
    if (b.drag) { segments.push({ from, to, depart: a.at, arrive: b.at, drag: true }); continue; }
    const arrive = b.click ? b.at - PRESS_LEAD : b.at;
    const ready = a.click || a.drag ? a.at + RELEASE : a.at;
    const span = Math.max(0, arrive - ready);
    const duration = Math.min(span, moveDuration(Math.hypot(to.x - from.x, to.y - from.y)));
    segments.push({ from, to, depart: arrive - duration, arrive, drag: false });
  }
  return segments;
}

/** Where the pointer is at a moment of the scene, in the same units as `targets` and `scene`. */
export function cursorPose(path: Waypoint[], ms: number, targets: Targets = {}, scene: Box = { x: 0, y: 0, width: 100, height: 100 }): Pose {
  const segments = cursorSegments(path, targets, scene);
  let point = resolveStop(path[0]!, targets, scene);
  let drag: Pose["drag"] = null;
  for (const segment of segments) {
    if (ms < segment.depart) break;
    const { from, to } = segment;
    const t = segment.arrive === segment.depart ? 1 : (ms - segment.depart) / (segment.arrive - segment.depart);
    if (segment.drag) {
      const e = smooth(t);
      const n = bowNormal(to.x - from.x, to.y - from.y);
      const bow = Math.min(Math.hypot(to.x - from.x, to.y - from.y) * .06, 16) * 4 * e * (1 - e);
      point = { x: from.x + (to.x - from.x) * e + n.x * bow, y: from.y + (to.y - from.y) * e + n.y * bow };
      const span = segment.arrive - segment.depart;
      const lift = Math.min(smooth((ms - segment.depart) / 140), 1 - smooth((ms - segment.arrive + 140) / 140));
      drag = { offset: { x: point.x - from.x, y: point.y - from.y }, lift: span > 0 ? Math.max(0, lift) : 0, tilt: Math.sign(to.x - from.x) * 2.5 };
      continue;
    }
    if (ms >= segment.arrive) { point = to; continue; }
    const e = glide(t);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const n = bowNormal(dx, dy);
    const bow = Math.min(Math.hypot(dx, dy) * 0.09, 26) * 4 * e * (1 - e);
    point = { x: from.x + dx * e + n.x * bow, y: from.y + dy * e + n.y * bow };
  }
  let press = 0;
  let ripple: Pose["ripple"] = null;
  path.forEach((stop, i) => {
    const next = path[i + 1];
    if (stop.click) {
      const release = next?.drag ? next.at : stop.at;
      press = Math.max(press, Math.min(smooth((ms - stop.at + 120) / 90), 1 - smooth((ms - release) / RELEASE)));
      if (ms >= stop.at && ms < stop.at + RIPPLE) ripple = { ...resolveStop(stop, targets, scene), t: (ms - stop.at) / RIPPLE };
    }
  });
  return { ...point, press, ripple, drag };
}

/**
 * Keeps what is on screen continuous. When the pose jumps (a new chapter, a restart, a layout
 * change), the pointer eases from where it was drawn onto the new pose instead of teleporting.
 */
export function createHandoff() {
  let offset: Point = { x: 0, y: 0 };
  let start = 0;
  let duration = 1;
  const apply = (now: number, pose: Point): Point => {
    const t = Math.max(0, Math.min(1, (now - start) / duration));
    if (t >= 1) return { x: pose.x, y: pose.y };
    const e = glide(t);
    const n = bowNormal(-offset.x, -offset.y);
    const bow = Math.min(Math.hypot(offset.x, offset.y) * 0.09, 22) * 4 * e * (1 - e);
    return { x: pose.x + offset.x * (1 - e) + n.x * bow, y: pose.y + offset.y * (1 - e) + n.y * bow };
  };
  return {
    apply,
    /** `shown` is where the pointer is drawn now; `pose` is where the scene now wants it. */
    rebase(now: number, shown: Point, pose: Point, ms: number) {
      offset = { x: shown.x - pose.x, y: shown.y - pose.y };
      start = now;
      duration = Math.max(1, ms);
    },
    settled: (now: number) => now - start >= duration,
  };
}

/** Scene stops, authored against each scene's real elements. Clicks line up with the scene's own events. */
export const CURSOR_PATHS: Record<string, Waypoint[]> = {
  today: [
    { at: 0, x: 72, y: 82 },
    { at: 1150, target: "desk", ax: .2, ay: .32, x: 22, y: 40 },
    { at: 3000, target: "desk", ax: .62, ay: .3, x: 60, y: 40 },
    { at: 4600, target: "desk", ax: .81, ay: .58, x: 84, y: 50 },
  ],
  arrange: [
    { at: 0, x: 62, y: 46 },
    { at: 650, target: "add-tile", x: 92, y: 10, click: true },
    { at: 2050, target: "pick-tile", ax: .55, x: 22, y: 42, click: true },
    { at: 3250, target: "place-tile", x: 88, y: 80, click: true },
    { at: 4300, target: "place-tile", ax: .2, ay: 2.1, x: 80, y: 90 },
  ],
  board: [
    { at: 0, x: 78, y: 16 },
    { at: 1350, target: "drag-card", ax: .38, ay: .42, x: 18, y: 72, click: true },
    { at: 1950, target: "drop-slot", ax: .38, ay: .42, x: 52, y: 52, drag: true },
    { at: 3000, target: "drop-slot", ax: .82, ay: 1.5, x: 62, y: 70 },
  ],
  pages: [
    { at: 0, x: 74, y: 22 },
    { at: 1200, target: "person-choice", ax: .4, x: 20, y: 46, click: true },
    { at: 2300, target: "doc-note", ax: .12, ay: 2.4, x: 20, y: 66 },
    { at: 4050, target: "add-board", x: 88, y: 84, click: true },
    { at: 4850, target: "due", ax: .7, x: 40, y: 26, click: true },
    { at: 5600, target: "tomorrow", ax: .45, x: 42, y: 36, click: true },
    { at: 6500, target: "tomorrow", ax: 1.4, ay: 3.2, x: 50, y: 52 },
  ],
  context: [
    { at: 0, x: 78, y: 20 },
    { at: 1700, target: "task-node", x: 50, y: 55, click: true },
    { at: 3200, target: "graph-detail", ax: .22, ay: .4, x: 24, y: 86 },
    { at: 4700, target: "person-node", x: 25, y: 38 },
  ],
  code: [
    { at: 0, x: 74, y: 22 },
    { at: 1300, target: "diff-new", ax: .3, x: 40, y: 55 },
    { at: 3900, target: "review", x: 88, y: 88 },
  ],
  files: [
    { at: 0, x: 72, y: 30 },
    { at: 650, target: "file-0", ax: .3, x: 18, y: 30, click: true },
    { at: 1900, target: "highlight", ax: .3, x: 66, y: 50 },
    { at: 3500, target: "attach", x: 86, y: 86, click: true },
    { at: 4500, target: "attach", ax: .1, ay: -1.6, x: 76, y: 76 },
  ],
  meetings: [
    { at: 0, x: 62, y: 28 },
    { at: 700, target: "meeting-0|notes-title", ax: .4, x: 15, y: 35, click: true },
    { at: 1900, target: "followup", ax: .35, x: 60, y: 65 },
    { at: 3600, target: "followup", ax: .9, ay: 2.2, x: 74, y: 82 },
  ],
  approvals: [
    { at: 0, x: 82, y: 22 },
    { at: 1300, target: "request-title", ax: .08, ay: .9, x: 30, y: 46 },
    { at: 3700, target: "request-body", ax: .45, ay: .7, x: 40, y: 64 },
    { at: 6800, target: "approve", ax: .45, x: 16, y: 86 },
  ],
  connections: [
    { at: 0, x: 82, y: 30 },
    { at: 1500, target: "connector", ax: .5, ay: .62, x: 48, y: 40, click: true },
    { at: 3300, target: "source-details", ax: .3, x: 40, y: 80 },
  ],
  assistant: [
    { at: 0, x: 66, y: 58 },
    { at: 1300, target: "launcher", x: 95, y: 90, click: true },
    { at: 2650, target: "compose", ax: .3, x: 70, y: 88, click: true },
    { at: 6000, target: "compose", ax: .55, ay: -1.4, x: 78, y: 80 },
    { at: 8900, target: "proposal", ax: .8, ay: .45, x: 80, y: 60 },
  ],
};
