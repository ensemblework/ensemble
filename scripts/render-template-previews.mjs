/**
 * Static template cards. Each picture is that template's Today layout.
 * Run: node scripts/render-template-previews.mjs
 */
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync as readSync } from "node:fs";
import path from "node:path";

const LABELS = {
  orbit: "Orbit",
  focus: "Focus",
  proposals: "Proposals",
  calendar: "Calendar",
  deliverables: "Deliverables",
  reminders: "Reminders",
  "needs-me": "Needs me",
  "meeting-cues": "Meetings",
  "stale-nudges": "Still relevant",
  "morning-brief": "Morning brief",
  "week-recap": "Week recap",
  people: "People",
  meetings: "Meetings",
  repos: "Repos",
  artifacts: "Artifacts",
  graph: "Graph",
  "recent-links": "Recent",
};

const SPAN = { s: [3, 2], m: [6, 2], l: [6, 4], xl: [12, 4] };

/** Empty meeting cues and stale nudges hide. Starter data never fills them, so a day-one preview omits them. */
const HIDDEN_UNTIL_POPULATED = new Set(["meeting-cues", "stale-nudges"]);

/** Long words that do not fit an S tile on one line at a readable size. */
const LINE_BREAKS = {
  Deliverables: ["Deliver", "ables"],
};

function dayOne(placements) {
  return placements.filter(([type]) => !HIDDEN_UNTIL_POPULATED.has(type));
}

function pack(placements) {
  const taken = new Set();
  const cells = [];
  for (const [type, size] of placements) {
    const [w, h] = SPAN[size];
    let found = null;
    for (let y = 0; y < 40 && !found; y += 1) {
      for (let x = 0; x <= 12 - w; x += 1) {
        let clear = true;
        for (let dy = 0; dy < h && clear; dy += 1) {
          for (let dx = 0; dx < w; dx += 1) {
            if (taken.has(`${x + dx},${y + dy}`)) clear = false;
          }
        }
        if (!clear) continue;
        found = { type, size, x, y, w, h };
        for (let dy = 0; dy < h; dy += 1) {
          for (let dx = 0; dx < w; dx += 1) taken.add(`${x + dx},${y + dy}`);
        }
        break;
      }
    }
    if (found) cells.push(found);
  }
  return cells;
}

function takeArray(src, start) {
  let depth = 0;
  for (let i = start; i < src.length; i += 1) {
    if (src[i] === "[") depth += 1;
    else if (src[i] === "]") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error("unclosed layout array");
}

function templatesFromCatalog() {
  const src = readSync(path.resolve("packages/shared-types/src/templates/catalog.ts"), "utf8");
  const re = /template\(\s*"[a-z]+",\s*"([a-z0-9-]+)",\s*"([^"]+)",\s*"[^"]*",/g;
  const rows = [];
  for (const match of src.matchAll(re)) {
    const from = src.indexOf("[[", match.index + match[0].length);
    const body = takeArray(src, from);
    const placements = [...body.matchAll(/\["([a-z0-9-]+)",\s*"(s|m|l|xl)"\]/g)].map((item) => [item[1], item[2]]);
    if (!placements.length) throw new Error(`no placements for ${match[1]}`);
    rows.push({ id: match[1], name: match[2], placements });
  }
  if (rows.length !== 26) throw new Error(`expected 26 templates, parsed ${rows.length}`);
  return rows;
}

function fontFor(parts, w, h) {
  const longest = Math.max(...parts.map((part) => part.length));
  return Math.min(34, (h - 16) / (parts.length * 1.2), (w - 20) / (longest * 0.58));
}

function chooseLabel(label, w, h) {
  const single = fontFor([label], w, h);
  if (single >= 24) return { parts: [label], font: single };
  const broken = LINE_BREAKS[label] ?? (label.includes(" ") ? label.split(" ") : null);
  if (broken) {
    const font = fontFor(broken, w, h);
    if (font >= 24) return { parts: broken, font };
  }
  return { parts: [label], font: single };
}

function svg(card, light) {
  const bg = light ? "#f4f1ea" : "#16181e";
  const panel = light ? "#fffdf8" : "#23262f";
  const ink = light ? "#1c1915" : "#f2efe8";
  const cells = pack(dayOne(card.placements));
  const rows = Math.max(1, cells.reduce((max, cell) => Math.max(max, cell.y + cell.h), 0));
  const width = 640;
  const height = 400;
  const pad = 16;
  const gap = 8;
  const gridW = width - pad * 2;
  const gridH = height - pad * 2;
  const col = (gridW - gap * 11) / 12;
  const rowH = (gridH - gap * (rows - 1)) / rows;
  const rects = cells
    .map((cell, index) => {
      const x = pad + cell.x * (col + gap);
      const y = pad + cell.y * (rowH + gap);
      const w = cell.w * col + (cell.w - 1) * gap;
      const h = cell.h * rowH + (cell.h - 1) * gap;
      const label = LABELS[cell.type] ?? cell.type;
      const { parts, font } = chooseLabel(label, w, h);
      if (font < 24) throw new Error(`${card.id} label "${label}" is ${font.toFixed(1)}px`);
      const line = font * 1.15;
      const firstY = y + h / 2 - ((parts.length - 1) * line) / 2;
      const tspans = parts
        .map((part, lineIndex) => {
          const dy = lineIndex === 0 ? 0 : line;
          return `<tspan x="${(x + 12).toFixed(1)}" dy="${dy.toFixed(1)}">${escapeXml(part)}</tspan>`;
        })
        .join("");
      return `<clipPath id="c${index}"><rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="10"/></clipPath>
  <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="10" fill="${panel}"/>
  <text x="${(x + 12).toFixed(1)}" y="${firstY.toFixed(1)}" fill="${ink}" font-family="ui-sans-serif, system-ui, sans-serif" font-size="${font.toFixed(1)}" font-weight="600" dominant-baseline="middle" clip-path="url(#c${index})"><title>${escapeXml(label)}</title>${tspans}</text>`;
    })
    .join("\n  ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <title>${escapeXml(card.name)}</title>
  <rect width="${width}" height="${height}" fill="${bg}"/>
  ${rects}
</svg>
`;
}

function escapeXml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const cards = templatesFromCatalog();
const out = path.resolve("apps/hub-web/public/templates");
await mkdir(out, { recursive: true });
for (const card of cards) {
  const cells = pack(dayOne(card.placements));
  if (!cells.length || cells.every((cell) => cell.x >= 6)) throw new Error(`${card.id} packed only on the right`);
  if (cells[0].x !== 0) throw new Error(`${card.id} does not start at the left`);
  if (cells.some((cell) => HIDDEN_UNTIL_POPULATED.has(cell.type))) throw new Error(`${card.id} still draws a hidden tile`);
  await writeFile(path.join(out, `${card.id}.svg`), svg(card, false));
  await writeFile(path.join(out, `${card.id}-light.svg`), svg(card, true));
}
console.log(`wrote ${cards.length * 2} previews`);
