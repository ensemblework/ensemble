import { ARROW_HEAD, LINE_WIDTH, type Curve, type LayoutBox, type PortName, type ShapeId } from "./model.js";
import { closestPorts, outlineSize, shapeGeometry, type Point } from "./shapes.js";

/**
 * How a line is drawn between two ports: its path, where its label and bend handle sit, and its
 * arrowheads. The canvas and the SVG export both draw from this, so a bent or thick line looks
 * the same in both. The stroke stops under each arrowhead so a thick line never pokes past the tip.
 */
export interface RouteInput {
  from: Point;
  to: Point;
  fromPort: PortName;
  toPort: PortName;
  curve: Curve;
  bend?: number;
  width?: number | null;
  head?: number | null;
  arrows: { start: "none" | "arrow"; end: "none" | "arrow" };
}

export interface EdgeRoute {
  /** The stroke. */
  d: string;
  /** The middle of the line: where the label and the bend handle sit. */
  label: Point;
  /** Filled arrowheads, as closed paths. */
  heads: string[];
  /** An elbow from a side to a top or bottom has one corner and no middle run to move. */
  bendable: boolean;
  width: number;
  head: number;
}

const DIAGONAL = Math.SQRT1_2;
const DIRECTION: Record<PortName, Point> = {
  n: { x: 0, y: -1 },
  s: { x: 0, y: 1 },
  e: { x: 1, y: 0 },
  w: { x: -1, y: 0 },
  ne: { x: DIAGONAL, y: -DIAGONAL },
  se: { x: DIAGONAL, y: DIAGONAL },
  sw: { x: -DIAGONAL, y: DIAGONAL },
  nw: { x: -DIAGONAL, y: -DIAGONAL },
};

/** Within this many px of straight, a bend snaps back to 0. */
export const BEND_SNAP = 6;

const r2 = (value: number) => Math.round(value * 100) / 100;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
const scale = (a: Point, k: number): Point => ({ x: a.x * k, y: a.y * k });
const length = (a: Point) => Math.hypot(a.x, a.y);
const unit = (a: Point, fallback: Point = { x: 1, y: 0 }): Point => {
  const size = length(a);
  return size < 1e-6 ? fallback : { x: a.x / size, y: a.y / size };
};
const pt = (a: Point) => `${r2(a.x)} ${r2(a.y)}`;

/** Unit vector to the left of a → b; a positive bend pulls the line's middle that way. */
function normal(a: Point, b: Point): Point {
  const d = unit(sub(b, a));
  return { x: -d.y, y: d.x };
}

function quadAt(a: Point, c: Point, b: Point, t: number): Point {
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
}

function cubicAt(a: Point, c1: Point, c2: Point, b: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
    y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
  };
}

/** Which way an elbow leaves a port: sideways for e/w, up or down for n/s, the longer way for a corner. */
function horizontalAt(port: PortName, a: Point, b: Point): boolean {
  if (port === "e" || port === "w") return true;
  if (port === "n" || port === "s") return false;
  return Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
}

function elbowPoints(input: RouteInput, bend: number): { points: Point[]; label: Point; bendable: boolean } {
  const { from: a, to: b } = input;
  const fromH = horizontalAt(input.fromPort, a, b);
  const toH = horizontalAt(input.toPort, b, a);
  if (fromH && toH) {
    const mx = (a.x + b.x) / 2 + bend;
    return { points: [a, { x: mx, y: a.y }, { x: mx, y: b.y }, b], label: { x: mx, y: (a.y + b.y) / 2 }, bendable: true };
  }
  if (!fromH && !toH) {
    const my = (a.y + b.y) / 2 + bend;
    return { points: [a, { x: a.x, y: my }, { x: b.x, y: my }, b], label: { x: (a.x + b.x) / 2, y: my }, bendable: true };
  }
  const corner = fromH ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
  return { points: [a, corner, b], label: corner, bendable: false };
}

function dedupe(points: Point[]): Point[] {
  return points.filter((point, index) => index === 0 || length(sub(point, points[index - 1]!)) > 0.5);
}

/** A polyline with its corners rounded. */
function roundedPolyline(points: Point[], radius: number): string {
  if (points.length < 3) return `M ${pt(points[0]!)} L ${pt(points[points.length - 1]!)}`;
  const parts = [`M ${pt(points[0]!)}`];
  for (let index = 1; index < points.length - 1; index += 1) {
    const prev = points[index - 1]!;
    const corner = points[index]!;
    const next = points[index + 1]!;
    const r = Math.min(radius, length(sub(corner, prev)) / 2, length(sub(next, corner)) / 2);
    const enter = add(corner, scale(unit(sub(prev, corner)), r));
    const leave = add(corner, scale(unit(sub(next, corner)), r));
    parts.push(`L ${pt(enter)}`, `Q ${pt(corner)} ${pt(leave)}`);
  }
  parts.push(`L ${pt(points[points.length - 1]!)}`);
  return parts.join(" ");
}

function arrowhead(tip: Point, direction: Point, head: number, width: number): string {
  const back = add(tip, scale(direction, -head));
  const side = { x: -direction.y, y: direction.x };
  const half = head * 0.42 + width * 0.35;
  return `M ${pt(tip)} L ${pt(add(back, scale(side, half)))} L ${pt(add(back, scale(side, -half)))} Z`;
}

export function edgeRoute(input: RouteInput): EdgeRoute {
  const width = clamp(input.width ?? LINE_WIDTH.default, LINE_WIDTH.min, LINE_WIDTH.max);
  const head = clamp(input.head ?? ARROW_HEAD.default, ARROW_HEAD.min, ARROW_HEAD.max);
  const bend = input.bend ?? 0;
  const { from: a, to: b } = input;
  const pull = head * 0.8;
  const heads: string[] = [];
  const startArrow = input.arrows.start === "arrow";
  const endArrow = input.arrows.end === "arrow";

  if (input.curve === "elbow") {
    const route = elbowPoints(input, bend);
    const points = dedupe(route.points);
    if (points.length < 2) points.push(b);
    const first = unit(sub(points[1]!, points[0]!), DIRECTION[input.fromPort]);
    const last = unit(sub(points[points.length - 1]!, points[points.length - 2]!), scale(DIRECTION[input.toPort], -1));
    if (startArrow) heads.push(arrowhead(a, scale(first, -1), head, width));
    if (endArrow) heads.push(arrowhead(b, last, head, width));
    const drawn = points.map((point) => ({ ...point }));
    if (startArrow) drawn[0] = add(a, scale(first, Math.min(pull, length(sub(points[1]!, a)) - 0.5)));
    if (endArrow) drawn[drawn.length - 1] = add(b, scale(last, -Math.min(pull, length(sub(b, points[points.length - 2]!)) - 0.5)));
    return { d: roundedPolyline(drawn, 8), label: { x: r2(route.label.x), y: r2(route.label.y) }, heads, bendable: route.bendable, width, head };
  }

  const n = normal(a, b);
  if (input.curve === "curved") {
    const reach = clamp(length(sub(b, a)) * 0.42, 24, 220);
    const shift = scale(n, (bend * 4) / 3);
    const c1 = add(add(a, scale(DIRECTION[input.fromPort], reach)), shift);
    const c2 = add(add(b, scale(DIRECTION[input.toPort], reach)), shift);
    const first = unit(sub(c1, a), unit(sub(b, a)));
    const last = unit(sub(b, c2), unit(sub(b, a)));
    if (startArrow) heads.push(arrowhead(a, scale(first, -1), head, width));
    if (endArrow) heads.push(arrowhead(b, last, head, width));
    const start = startArrow ? add(a, scale(first, pull)) : a;
    const end = endArrow ? add(b, scale(last, -pull)) : b;
    const mid = cubicAt(a, c1, c2, b, 0.5);
    return { d: `M ${pt(start)} C ${pt(c1)} ${pt(c2)} ${pt(end)}`, label: { x: r2(mid.x), y: r2(mid.y) }, heads, bendable: true, width, head };
  }

  if (Math.abs(bend) < 0.5) {
    const along = unit(sub(b, a));
    if (startArrow) heads.push(arrowhead(a, scale(along, -1), head, width));
    if (endArrow) heads.push(arrowhead(b, along, head, width));
    const span = length(sub(b, a));
    const start = startArrow ? add(a, scale(along, Math.min(pull, span / 2))) : a;
    const end = endArrow ? add(b, scale(along, -Math.min(pull, span / 2))) : b;
    return { d: `M ${pt(start)} L ${pt(end)}`, label: { x: r2((a.x + b.x) / 2), y: r2((a.y + b.y) / 2) }, heads, bendable: true, width, head };
  }

  // A bent straight line: a quadratic through the point the middle was pulled to.
  const middle = scale(add(a, b), 0.5);
  const control = add(middle, scale(n, bend * 2));
  const first = unit(sub(control, a));
  const last = unit(sub(b, control));
  if (startArrow) heads.push(arrowhead(a, scale(first, -1), head, width));
  if (endArrow) heads.push(arrowhead(b, last, head, width));
  const start = startArrow ? add(a, scale(first, pull)) : a;
  const end = endArrow ? add(b, scale(last, -pull)) : b;
  const mid = quadAt(a, control, b, 0.5);
  return { d: `M ${pt(start)} Q ${pt(control)} ${pt(end)}`, label: { x: r2(mid.x), y: r2(mid.y) }, heads, bendable: true, width, head };
}

/** The bend that puts a line's middle at `point` (where the handle was dragged to). */
export function bendFromPoint(input: Omit<RouteInput, "bend" | "arrows" | "width" | "head">, point: Point): number {
  const { from: a, to: b } = input;
  let bend = 0;
  if (input.curve === "elbow") {
    const fromH = horizontalAt(input.fromPort, a, b);
    const toH = horizontalAt(input.toPort, b, a);
    if (fromH && toH) bend = point.x - (a.x + b.x) / 2;
    else if (!fromH && !toH) bend = point.y - (a.y + b.y) / 2;
  } else {
    const n = normal(a, b);
    const middle = scale(add(a, b), 0.5);
    bend = (point.x - middle.x) * n.x + (point.y - middle.y) * n.y;
  }
  return Math.abs(bend) < BEND_SNAP ? 0 : Math.round(bend);
}

/** Where a port sits on a placed block. A person's ports are on the figure, not the label under it. */
export function portPoint(shape: ShapeId, box: LayoutBox, port: PortName): Point {
  const drawn = outlineSize(shape, box.w, box.h);
  const at = shapeGeometry(shape, drawn.w, drawn.h).ports[port];
  return { x: box.x + at.x, y: box.y + at.y };
}

/** Both ends of a line: the ports it names, or the facing sides of the two blocks. */
export function edgeEnds(
  from: { shape: ShapeId; box: LayoutBox; port: PortName | null },
  to: { shape: ShapeId; box: LayoutBox; port: PortName | null },
): { from: Point; to: Point; fromPort: PortName; toPort: PortName } {
  const picked = closestPorts({ shape: from.shape, ...from.box }, { shape: to.shape, ...to.box });
  const fromPort = from.port ?? picked.from;
  const toPort = to.port ?? picked.to;
  return { from: portPoint(from.shape, from.box, fromPort), to: portPoint(to.shape, to.box, toPort), fromPort, toPort };
}
