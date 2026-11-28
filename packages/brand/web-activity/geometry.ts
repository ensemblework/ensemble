import data from "../motion-data.json";

export type AgentShape = "infinity" | "weave" | "exchange";
export const OPEN_GAP = 0.28;
export const markSizes = { micro: [20, 18], inline: [38, 23], pill: [24, 24], launcher: [32, 32] } as const;
export type MarkSize = keyof typeof markSizes;
type Point = readonly [number, number];
const TAU = Math.PI * 2;
const mix = (a: number, b: number, q: number) => a + (b - a) * q;
const wrap = (u: number) => u - Math.floor(u);
function smooth(t: number) { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); }
const coord = (p: Point) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
const path = (points: readonly Point[]) => `M${points.map(coord).join("L")}`;

function geometry(size: MarkSize) {
  const [w, h] = markSizes[size];
  const stroke = w <= 20 ? 1.95 : w <= 24 ? 2.16 : w <= 32 ? 2.35 : 2.55;
  const rx = (w - stroke - 1.6) / 2, ry = Math.min(h * .385, rx * .63);
  const dense: Point[] = [], distance = [0];
  // Match the resting strands' direction and phase, then sample uniform distances, not uniform angles.
  for (let i = 0; i <= 1024; i++) {
    const a = TAU * (173 / 256 - i / 1024);
    dense.push([w / 2 + rx * Math.sin(a), h / 2 + ry * Math.sin(2 * a)]);
    if (i) distance[i] = distance[i - 1] + Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]);
  }
  const length = distance[1024], n = data.N - 1;
  let k = 1;
  const loop: Point[] = Array.from({ length: n + 1 }, (_, i) => {
    const target = length * i / n;
    while (k < 1024 && distance[k] < target) k++;
    const u = (target - distance[k - 1]) / (distance[k] - distance[k - 1]);
    return [mix(dense[k - 1][0], dense[k][0], u), mix(dense[k - 1][1], dense[k][1], u)];
  });
  const base = data.pair.map(strand => strand.map(([x, y]): Point => [w / 2 + (x - 160) * h / 280, h / 2 + (y - 160) * h / 280]));
  return { w, h, stroke, length, loop, base };
}
const cache = new Map<MarkSize, ReturnType<typeof geometry>>();
function sample(points: Point[], u: number): Point {
  const z = wrap(u) * (points.length - 1), i = Math.floor(z), t = z - i;
  return [mix(points[i][0], points[i + 1][0], t), mix(points[i][1], points[i + 1][1], t)];
}
function cutPath(points: Point[], phase: number, gap: number) {
  if (!gap) return path(points) + "Z";
  const n = points.length - 1, start = wrap(phase + gap / 2), end = start + 1 - gap;
  const visible = [sample(points, start)];
  for (let i = Math.floor(start * n) + 1; i < end * n; i++) visible.push(points[i % n]);
  visible.push(sample(points, end));
  return path(visible);
}

export function agentFrame(kind: AgentShape, size: MarkSize, q: number, phase: number) {
  const g = cache.get(size) ?? geometry(size);
  cache.set(size, g);
  const { w, h, base } = g;
  const startStroke = Math.max(1.05, h * .04);
  if (kind === "infinity") {
    const width = mix(startStroke, g.stroke, smooth(q));
    // Both round caps extend into the cut. Leave 28% visibly empty, even in a 20 px gutter.
    const gap = (OPEN_GAP + width / g.length) * smooth((q - .18) / .77);
    const strandPath = (i: number) => cutPath(q === 1 ? g.loop : base[i].map(([x, y], j): Point => [mix(x, g.loop[j][0], q), mix(y, g.loop[j][1], q)]), phase, gap);
    const second = 1 - smooth(q / .83);
    return { a: strandPath(1), b: second ? strandPath(0) : "", second, width };
  }
  const a = phase * TAU;
  const paths = base.map((strand, s) => {
    const sign = s ? -1 : 1;
    const tilt = -.34 + sign * .22 * Math.sin(a);
    const pts = strand.map(([bx, by], j): Point => {
      let x: number, y: number;
      if (kind === "weave") {
        const u = j / (strand.length - 1), t = TAU * (u * 1.04 - phase), pad = w <= 20 ? 1.2 : 1.8;
        x = pad + (w - 2 * pad) * u;
        y = h / 2 + h * .345 * (.88 * Math.sin(t - sign * .82) + .12 * Math.sin(2 * t + sign * .55)) - sign * h * .052;
      } else {
        const t = TAU * ((74 + s) / 128 - j / strand.length);
        const ex = Math.cos(t) * Math.min(w * .201, h * .30), ey = Math.sin(t) * (.83 - .23 * Math.cos(t)) * h * (.19 + .11 * Math.abs(Math.cos(a)));
        x = w / 2 + sign * w * .225 * Math.cos(a) + ex * Math.cos(tilt) - ey * Math.sin(tilt);
        y = h / 2 + sign * h * .237 * Math.sin(a) + ex * Math.sin(tilt) + ey * Math.cos(tilt);
      }
      return [mix(bx, x, q), mix(by, y, q)];
    });
    return path(pts) + (kind === "exchange" ? "Z" : "");
  });
  return { a: paths[0], b: paths[1], second: 1, width: mix(startStroke, w <= 20 ? 1.65 : 2, q) };
}

export interface Pose { q: number; velocity: number; phase: number; kind: AgentShape }
export function stepPose(pose: Pose, wanted: AgentShape | null, seconds: number) {
  const dt = Math.min(seconds, .075);
  if (pose.q === 0 && wanted) pose.kind = wanted;
  const target = Number(wanted === pose.kind), rate = target ? 9.8 : 12;
  const e = pose.q - target, b = pose.velocity + rate * e, decay = Math.exp(-rate * dt);
  pose.q = Math.min(1, Math.max(0, target + (e + b * dt) * decay));
  pose.velocity = (pose.velocity - rate * b * dt) * decay;
  if (Math.abs(pose.q - target) < .0008 && Math.abs(pose.velocity) < .012) { pose.q = target; pose.velocity = 0; }
  pose.phase = wrap(pose.phase + dt * smooth(pose.q / .9) / ({ infinity: 1.925, weave: 2.95, exchange: 2.4 }[pose.kind]));
}
