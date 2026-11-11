/**
 * Builds the background doodles in public/doodles/ (Settings → Appearance → Doodle). Each is a
 * seamless 480 × 480 tile of faint white marks: the canvas draws it with `background-blend-mode:
 * difference` over the theme's own background, so one file lightens a dark theme and darkens a light
 * one by the same small amount. Deterministic: the same file every run.
 *
 *   node --import tsx apps/hub-web/scripts/doodles.ts          write the files
 *   node --import tsx apps/hub-web/scripts/doodles.ts --check  fail when they are out of date
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const W = 480;
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "doodles");
const f = (value: number) => Number(value.toFixed(1));

function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** The same mark at every offset where part of it crosses an edge, so the tile has no seam. */
function wrap(x: number, y: number, reach: number, mark: (x: number, y: number) => string): string {
  const parts: string[] = [];
  for (const dx of [-W, 0, W]) {
    for (const dy of [-W, 0, W]) {
      const cx = x + dx;
      const cy = y + dy;
      if (cx + reach < 0 || cx - reach > W || cy + reach < 0 || cy - reach > W) continue;
      parts.push(mark(cx, cy));
    }
  }
  return parts.join("");
}

const dot = (x: number, y: number, r: number, o: number) => `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill-opacity="${o}"/>`;
const sparkle = (x: number, y: number, s: number) => `<path d="M${f(x - s)} ${f(y)}h${f(2 * s)}M${f(x)} ${f(y - s)}v${f(2 * s)}" stroke-width=".8"/>`;

function svg(body: string, stroke = ".06"): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" viewBox="0 0 ${W} ${W}" fill="white" stroke="white" stroke-opacity="${stroke}" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">${body}</svg>\n`;
}

const DOODLES: Record<string, () => string> = {
  constellation() {
    const random = rng(11);
    const groups = [
      [[60, 70], [118, 52], [170, 96], [150, 160], [92, 148]],
      [[300, 250], [352, 214], [410, 236], [438, 300], [380, 330]],
      [[96, 330], [150, 372], [210, 356], [252, 408]],
    ];
    let body = "";
    for (const group of groups) {
      body += `<path fill="none" d="${group.map(([x, y], index) => `${index ? "L" : "M"}${x} ${y}`).join("")}"/>`;
      for (const [x, y] of group) body += dot(x!, y!, 1.7, 0.16);
    }
    for (let index = 0; index < 34; index += 1) {
      const x = random() * W;
      const y = random() * W;
      body += wrap(x, y, 3, (cx, cy) => dot(cx, cy, 0.6 + random() * 0.7, 0.1));
    }
    body += sparkle(170, 96, 5) + sparkle(410, 236, 5) + sparkle(252, 408, 4);
    return svg(body, ".07");
  },
  orbits() {
    let body = "";
    const system = (x: number, y: number, radii: number[], tilt: number, planets: number[]) => {
      body += dot(x, y, 2.2, 0.14);
      radii.forEach((r, index) => {
        body += `<ellipse cx="${x}" cy="${y}" rx="${r}" ry="${f(r * 0.42)}" fill="none" transform="rotate(${tilt} ${x} ${y})"/>`;
        const angle = planets[index]!;
        const px = x + r * Math.cos(angle) * Math.cos((tilt * Math.PI) / 180) - r * 0.42 * Math.sin(angle) * Math.sin((tilt * Math.PI) / 180);
        const py = y + r * Math.cos(angle) * Math.sin((tilt * Math.PI) / 180) + r * 0.42 * Math.sin(angle) * Math.cos((tilt * Math.PI) / 180);
        body += dot(px, py, 2 + index * 0.4, 0.13);
      });
    };
    system(170, 170, [44, 82, 124], -18, [0.6, 2.4, 4.1]);
    system(380, 380, [30, 58], 24, [1.2, 3.6]);
    const random = rng(5);
    for (let index = 0; index < 20; index += 1) body += dot(random() * W, random() * W, 0.7, 0.09);
    return svg(body, ".06");
  },
  galaxy() {
    let body = "";
    const random = rng(23);
    const cx = 240;
    const cy = 240;
    for (const arm of [0, Math.PI]) {
      for (let step = 0; step < 90; step += 1) {
        const t = step / 90;
        const angle = arm + t * 3.2 * Math.PI;
        const radius = 8 + t * 190;
        const spread = 4 + t * 16;
        const x = cx + radius * Math.cos(angle) + (random() - 0.5) * spread;
        const y = cy + radius * Math.sin(angle) * 0.62 + (random() - 0.5) * spread;
        body += dot(x, y, 1.5 - t, f(0.16 - t * 0.1));
      }
    }
    body += dot(cx, cy, 3, 0.12);
    for (let index = 0; index < 28; index += 1) {
      const x = random() * W;
      const y = random() * W;
      body += wrap(x, y, 2, (px, py) => dot(px, py, 0.6, 0.08));
    }
    return svg(body);
  },
  stardust() {
    let body = "";
    const random = rng(41);
    for (let index = 0; index < 90; index += 1) {
      const x = random() * W;
      const y = random() * W;
      const r = 0.5 + random() * 1.1;
      body += wrap(x, y, 2, (px, py) => dot(px, py, r, f(0.06 + random() * 0.08)));
    }
    for (let index = 0; index < 7; index += 1) {
      const x = random() * W;
      const y = random() * W;
      body += wrap(x, y, 6, (px, py) => sparkle(px, py, 3 + random() * 3));
    }
    return svg(body, ".1");
  },
  ripples() {
    let body = "";
    for (const [x, y, rings] of [[110, 130, 4], [360, 300, 5], [210, 410, 3]] as const) {
      for (let ring = 1; ring <= rings; ring += 1) {
        const r = ring * 18 + ring * ring * 2;
        body += wrap(x, y, r, (px, py) => `<circle cx="${px}" cy="${py}" r="${r}" fill="none" stroke-opacity="${f(0.08 - ring * 0.012)}"/>`);
      }
      body += dot(x, y, 1.6, 0.12);
    }
    return svg(body, ".06");
  },
  network() {
    const random = rng(7);
    const nodes: Array<[number, number]> = [];
    while (nodes.length < 18) {
      const candidate: [number, number] = [random() * W, random() * W];
      // Toroidal distance, so nodes near opposite edges keep apart too.
      if (nodes.every(([x, y]) => Math.hypot(Math.min(Math.abs(x - candidate[0]), W - Math.abs(x - candidate[0])), Math.min(Math.abs(y - candidate[1]), W - Math.abs(y - candidate[1]))) > 70)) nodes.push(candidate);
    }
    let body = "";
    const seen = new Set<string>();
    nodes.forEach(([x, y], index) => {
      const near = nodes
        .map(([ox, oy], other) => {
          const dx = ((ox - x + W * 1.5) % W) - W / 2;
          const dy = ((oy - y + W * 1.5) % W) - W / 2;
          return { other, dx, dy, d: Math.hypot(dx, dy) };
        })
        .filter((row) => row.other !== index)
        .sort((a, b) => a.d - b.d)
        .slice(0, 2);
      for (const link of near) {
        const key = [index, link.other].sort().join("-");
        if (seen.has(key)) continue;
        seen.add(key);
        body += wrap(x, y, link.d, (px, py) => `<path d="M${f(px)} ${f(py)}l${f(link.dx)} ${f(link.dy)}"/>`);
      }
    });
    nodes.forEach(([x, y], index) => {
      body += wrap(x, y, 5, (px, py) => (index % 3 === 0 ? `<circle cx="${f(px)}" cy="${f(py)}" r="3.6" fill="none" stroke-opacity=".11"/>` : dot(px, py, 1.8, 0.14)));
    });
    return svg(body, ".055");
  },
  contours() {
    // A field that repeats every tile, traced at a few heights with marching squares.
    const field = (x: number, y: number) => {
      const u = (x / W) * 2 * Math.PI;
      const v = (y / W) * 2 * Math.PI;
      return Math.sin(u) * Math.cos(v) + 0.6 * Math.sin(2 * u + 1.3) * Math.sin(v + 0.4) + 0.35 * Math.cos(3 * v - u + 0.8);
    };
    const step = 8;
    const n = W / step;
    let body = "";
    for (const level of [-1.1, -0.65, -0.2, 0.25, 0.7, 1.15]) {
      let d = "";
      for (let i = 0; i < n; i += 1) {
        for (let j = 0; j < n; j += 1) {
          const x = i * step;
          const y = j * step;
          const corners = [field(x, y), field(x + step, y), field(x + step, y + step), field(x, y + step)];
          const at = (a: number, b: number) => (level - a) / (b - a);
          const edges: Array<[number, number]> = [];
          const pairs: Array<[number, number, number, number, number, number]> = [
            [0, 1, x, y, step, 0],
            [1, 2, x + step, y, 0, step],
            [3, 2, x, y + step, step, 0],
            [0, 3, x, y, 0, step],
          ];
          for (const [a, b, sx, sy, dx, dy] of pairs) {
            if ((corners[a]! > level) !== (corners[b]! > level)) {
              const t = at(corners[a]!, corners[b]!);
              edges.push([sx + dx * t, sy + dy * t]);
            }
          }
          if (edges.length >= 2) d += `M${f(edges[0]![0])} ${f(edges[0]![1])}L${f(edges[1]![0])} ${f(edges[1]![1])}`;
          if (edges.length === 4) d += `M${f(edges[2]![0])} ${f(edges[2]![1])}L${f(edges[3]![0])} ${f(edges[3]![1])}`;
        }
      }
      body += `<path fill="none" d="${d}"/>`;
    }
    return svg(body, ".055");
  },
  waves() {
    let body = "";
    for (let line = 0; line < 8; line += 1) {
      const base = line * (W / 8) + 30;
      const phase = line * 0.9;
      const amp = 9 + (line % 3) * 4;
      const k = 1 + (line % 2);
      let d = "";
      for (let x = 0; x <= W; x += 6) {
        const y = base + amp * Math.sin((x / W) * 2 * Math.PI * k + phase);
        d += `${x ? "L" : "M"}${x} ${f(y)}`;
      }
      body += `<path fill="none" d="${d}" stroke-opacity="${line % 2 ? ".05" : ".075"}"/>`;
    }
    return svg(body);
  },
  weave() {
    // Interlocking rings on a grid, like the loops in Ensemble's mark.
    let body = "";
    const step = 60;
    for (let x = 0; x < W; x += step) {
      for (let y = 0; y < W; y += step) {
        const offset = (y / step) % 2 ? step / 2 : 0;
        const cx = (x + offset) % W;
        body += wrap(cx, y, 40, (px, py) => `<circle cx="${px}" cy="${py}" r="38" fill="none"/>`);
      }
    }
    return svg(body, ".035");
  },
  dots() {
    let body = `<defs><pattern id="d" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="12" cy="12" r=".8" fill-opacity=".08" stroke="none"/></pattern></defs><rect width="${W}" height="${W}" fill="url(#d)" stroke="none"/>`;
    for (let x = 12; x < W; x += 96) for (let y = 12; y < W; y += 96) body += dot(x, y, 1.4, 0.13);
    return svg(body);
  },
  circuits() {
    const random = rng(19);
    let body = "";
    const g = 24;
    for (let trace = 0; trace < 14; trace += 1) {
      let x = Math.floor(random() * 20) * g;
      let y = Math.floor(random() * 20) * g;
      const start: [number, number] = [x, y];
      const moves: string[] = [];
      let heading = Math.floor(random() * 4);
      for (let step = 0; step < 4 + Math.floor(random() * 4); step += 1) {
        const length = g * (1 + Math.floor(random() * 3));
        const turn = random();
        if (turn < 0.3) heading = (heading + 1) % 4;
        else if (turn < 0.5) heading = (heading + 3) % 4;
        const dx = [length, 0, -length, 0][heading]!;
        const dy = [0, length, 0, -length][heading]!;
        moves.push(`l${dx} ${dy}`);
        x += dx;
        y += dy;
      }
      const [sx, sy] = start;
      const end: [number, number] = [x - sx, y - sy];
      body += wrap(sx, sy, 200, (px, py) => `<path fill="none" d="M${px} ${py}${moves.join("")}"/><circle cx="${px}" cy="${py}" r="2.6" fill="none" stroke-opacity=".1"/>${dot(px + end[0], py + end[1], 2, 0.12)}`);
    }
    return svg(body, ".06");
  },
  graph() {
    let body = "";
    let minor = "";
    let major = "";
    for (let v = 0; v <= W; v += 24) {
      const line = `M${v} 0V${W}M0 ${v}H${W}`;
      if (v % 96 === 0) major += line;
      else minor += line;
    }
    body += `<path d="${minor}" stroke-opacity=".028"/><path d="${major}" stroke-opacity=".055"/>`;
    body += `<circle cx="336" cy="144" r="44" fill="none" stroke-opacity=".06"/><path d="M336 92v104M284 144h104" stroke-opacity=".05"/>`;
    body += `<path d="M48 360c60-70 120-70 168-10s96 60 168-20" fill="none" stroke-opacity=".07"/>`;
    return svg(body);
  },
};

mkdirSync(out, { recursive: true });
const check = process.argv.includes("--check");
const stale: string[] = [];
for (const [id, build] of Object.entries(DOODLES)) {
  const path = join(out, `${id}.svg`);
  const next = build();
  if (check) {
    let current = "";
    try {
      current = readFileSync(path, "utf8");
    } catch {
      // missing
    }
    if (current !== next) stale.push(id);
  } else writeFileSync(path, next);
}
if (stale.length) {
  console.error(`Out of date: ${stale.join(", ")}. Run node --import tsx apps/hub-web/scripts/doodles.ts`);
  process.exit(1);
}
console.log(check ? "Doodles are current." : `Wrote ${Object.keys(DOODLES).length} doodles to ${out}`);
