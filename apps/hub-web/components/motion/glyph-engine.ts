import frames from "./glyph-keyframes.json";

type Pt = [number, number];
type Shape = [Pt[], Pt[]];

const KF = frames as unknown as Record<string, Shape>;

const LOOP: Array<[string, number, number, string?]> = [
  ["u", 450, 380],
  ["braid", 700, 1100, "weave"],
  ["rings", 700, 420],
  ["spark", 700, 700, "spin"],
  ["merge", 650, 520, "pulse"],
  ["u", 700, 380],
];
const LOOP_SUM = LOOP.reduce((sum, row) => sum + row[1] + row[2], 0);
const WIDTH: Record<string, [number, number]> = { spark: [0.55, 0.62], braid: [0.8, 0.85] };
const STATE_SHAPE: Record<string, string> = { idle: "u", wait: "u", pause: "pause", success: "check", error: "fray", working: "u" };

function reduced(): boolean {
  return document.documentElement.dataset.reduceMotion === "true";
}

function loopScale(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--m-dur-loop").trim();
  const ms = Number.parseFloat(raw);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return ms / LOOP_SUM;
}

function easeWeave(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

function lerpS(a: Pt[], b: Pt[], t: number): Pt[] {
  return a.map((p, i) => [p[0] + (b[i]![0] - p[0]) * t, p[1] + (b[i]![1] - p[1]) * t]);
}

function lerp(a: Shape, b: Shape, t: number): Shape {
  return [lerpS(a[0], b[0], t), lerpS(a[1], b[1], t)];
}

function path(points: Pt[]): string {
  let s = `M${points[0]![0].toFixed(2)} ${points[0]![1].toFixed(2)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[Math.min(points.length - 1, i + 2)]!;
    s += `C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(2)} ${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(2)} ${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(2)} ${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(2)} ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
  }
  return s;
}

function weave(shape: Shape, phase: number): Shape {
  const [a, b] = shape;
  const n = a.length;
  const amp = Math.sin(phase) * 0.9;
  const shift = (strand: Pt[], k: number): Pt[] =>
    strand.map((p, i) => {
      const q = strand[Math.min(n - 1, Math.max(0, i + 1))]!;
      const r = strand[Math.max(0, i - 1)]!;
      return [p[0] + (q[0] - r[0]) * k, p[1] + (q[1] - r[1]) * k];
    });
  return [shift(a, amp), shift(b, -amp)];
}

function widthOf(name: string): [number, number] {
  return WIDTH[name] ?? [1, 1];
}

export type GlyphHandle = { set: (state: string) => void; stop: () => void };

/** Expressive glyph. Import this module only from the expressive pack. */
export function mountGlyph(el: HTMLElement, opts: { state?: string; size?: number } = {}): GlyphHandle {
  const size = opts.size || 48;
  const small = size <= 20;
  const sw = small ? 1.3 : 1;
  el.classList.add("u-glyph");
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  el.innerHTML = `<svg viewBox="0 0 48 48" aria-hidden="true"><g class="ug-g" fill="none" stroke-linecap="round" stroke-linejoin="round"><path class="ug-agent" stroke-width="${5 * sw}"/><path class="ug-you" stroke-width="${3.8 * sw}"/></g></svg>`;
  const group = el.querySelector(".ug-g")!;
  const paths = el.querySelectorAll("path");
  const agent = paths[0]!;
  const you = paths[1]!;
  let cur: Shape = KF.u!.map((strand) => strand.map((p) => p.slice() as Pt)) as Shape;
  const baseW = [5 * sw, 3.8 * sw];
  let curW: [number, number] = [1, 1];
  let raf = 0;
  let state = "working";

  const render = (shape: Shape, rot = 0, scale = 1, youOpacity: number | null = null, w?: [number, number]) => {
    cur = shape;
    if (w) {
      curW = w;
      agent.setAttribute("stroke-width", (baseW[0]! * w[0]).toFixed(2));
      you.setAttribute("stroke-width", (baseW[1]! * w[1]).toFixed(2));
    }
    agent.setAttribute("d", path(shape[0]));
    you.setAttribute("d", path(shape[1]));
    group.setAttribute("transform", `rotate(${rot} 24 24) translate(24 24) scale(${scale}) translate(-24 -24)`);
    you.style.opacity = youOpacity == null ? "" : String(youOpacity);
  };

  const stop = () => cancelAnimationFrame(raf);

  const tween = (from: Shape, to: Shape, ms: number, fx?: (t: number) => [number, number, number | null]) => {
    const t0 = performance.now();
    const w0 = curW;
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / Math.max(ms, 1));
      const e = easeWeave(t);
      const extra = fx ? fx(e) : [1, 1, null];
      render(lerp(from, to, e), 0, extra[1]!, extra[2], [w0[0] + (1 - w0[0]) * e, w0[1] + (1 - w0[1]) * e]);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  };

  const loop = (from: Shape) => {
    const scale = loopScale();
    if (scale === 0) {
      render(KF.u!, 0, 1);
      return;
    }
    let i = 0;
    let prev = from;
    let prevW = curW;
    let phaseStart = performance.now();
    let stage: "move" | "hold" = "move";
    const step = (now: number) => {
      const [name, move, hold, fx] = LOOP[i]!;
      const target = KF[name]!;
      const elapsed = now - phaseStart;
      if (stage === "move") {
        const mv = move * scale;
        const t = mv ? Math.min(1, elapsed / mv) : 1;
        const e = easeWeave(t);
        const w1 = widthOf(name);
        render(lerp(prev, target, e), 0, 1, null, [prevW[0] + (w1[0] - prevW[0]) * e, prevW[1] + (w1[1] - prevW[1]) * e]);
        if (t >= 1) {
          stage = "hold";
          phaseStart = now;
        }
      } else {
        const h = hold ? Math.min(1, elapsed / (hold * scale)) : 1;
        let shape = target;
        let rot = 0;
        let sc = 1;
        if (fx === "weave") shape = weave(target, easeWeave(h) * Math.PI * 2);
        if (fx === "spin") rot = easeWeave(h) * 90;
        if (fx === "pulse") sc = 1 + Math.sin(h * Math.PI) * 0.28 * (Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--m-overshoot")) || 0);
        render(shape, rot, sc);
        if (h >= 1) {
          prev = target;
          prevW = widthOf(name);
          i = (i + 1) % LOOP.length;
          stage = "move";
          phaseStart = now;
          if (i === 0) i = 1;
        }
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  };

  const set = (next: string) => {
    state = next;
    el.className = `u-glyph is-${next}`;
    el.setAttribute("aria-hidden", "true");
    stop();
    const from = cur;
    if (next === "working") {
      if (reduced()) render(KF.u!, 0, 1);
      else loop(from);
      return;
    }
    const target = KF[STATE_SHAPE[next] ?? "u"] ?? KF.u!;
    if (reduced()) {
      render(target, 0, 1);
      return;
    }
    const ms = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--m-dur-ui")) || 320;
    tween(from, target, next === "success" ? ms : ms, next === "success" ? (t) => [1, 0.6 + 0.4 * t, 1 - t * 0.85] : undefined);
  };

  render(cur, 0, 1);
  set(opts.state || state);
  return { set, stop };
}
