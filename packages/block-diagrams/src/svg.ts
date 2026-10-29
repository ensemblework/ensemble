import { textStyle, type DiagramModel, type LayoutBox, type ShapeId, type TextStyle } from "./model.js";
import { DIAGRAM_DOT, DIAGRAM_LINE, DIAGRAM_PAPER, PALETTE, paintFor, type DiagramTheme } from "./palette.js";
import { refitGroups } from "./layout.js";
import { edgeEnds, edgeRoute } from "./route.js";
import { LABEL_SIZE, labelMetrics, nodeSize, outlineSize, shapeGeometry, textFrame, textSize, wrapLabel } from "./shapes.js";

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function boxesFor(model: DiagramModel): Record<string, LayoutBox> {
  const layout: Record<string, LayoutBox> = {};
  let y = 0;
  const take = (id: string, size: { w: number; h: number }) => {
    const existing = model.layout[id];
    if (existing) {
      layout[id] = existing;
      return;
    }
    layout[id] = { x: 0, y, w: size.w, h: size.h };
    y += size.h + 36;
  };
  for (const [id, node] of Object.entries(model.nodes)) take(id, nodeSize(node.shape, node.label, node.font));
  for (const [id, text] of Object.entries(model.texts)) take(id, textSize(text.text, text.font));
  // Frames go around their members, the same way the canvas draws them.
  const frames = refitGroups({ ...model, layout: { ...model.layout, ...layout } }).layout;
  for (const id of Object.keys(model.groups)) {
    if (frames[id]) layout[id] = frames[id]!;
  }
  return layout;
}

/** font-size, weight, italic and underline attributes for a label. */
function fontAttrs(font: TextStyle | undefined, base: number, weight: number): string {
  const style = textStyle(font);
  const parts = [`font-size="${n(style.size ?? base)}"`, `font-weight="${style.bold ? 700 : weight}"`];
  if (style.italic) parts.push('font-style="italic"');
  if (style.underline) parts.push('text-decoration="underline"');
  return parts.join(" ");
}

function labelBlock(label: string, shape: ShapeId, box: LayoutBox, fill: string, font: TextStyle | undefined): string {
  const frame = textFrame(shape, box.w, box.h);
  const metrics = labelMetrics(font);
  const lines = wrapLabel(label, Math.max(20, frame.w), Math.max(2, Math.floor(frame.h / metrics.line)), font);
  const lineHeight = metrics.line;
  const x = box.x + frame.x + frame.w / 2;
  const start = box.y + frame.y + frame.h / 2 - ((lines.length - 1) * lineHeight) / 2;
  return lines
    .map(
      (line, index) =>
        `<text x="${n(x)}" y="${n(start + index * lineHeight)}" text-anchor="middle" dominant-baseline="middle" ${fontAttrs(font, LABEL_SIZE.block, 560)} fill="${fill}">${escapeXml(line)}</text>`,
    )
    .join("");
}

function n(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface SvgOptions {
  theme?: DiagramTheme;
}

/** Headless SVG. The interactive canvas is a separate renderer; a native app can draw this path data too. */
export function renderDiagramSvg(model: DiagramModel, options: SvgOptions = {}): string {
  const theme = options.theme ?? "light";
  const paper = DIAGRAM_PAPER[theme];
  const ink = DIAGRAM_LINE[theme];
  const muted = PALETTE[theme].slate.stroke;
  const layout = boxesFor(model);
  const values = Object.values(layout);
  const minX = (values.length ? Math.min(...values.map((box) => box.x)) : 0) - 36;
  const minY = (values.length ? Math.min(...values.map((box) => box.y)) : 0) - 36;
  const maxX = (values.length ? Math.max(...values.map((box) => box.x + box.w)) : 320) + 36;
  const maxY = (values.length ? Math.max(...values.map((box) => box.y + box.h)) : 180) + 36;
  const width = Math.max(240, maxX - minX);
  const height = Math.max(160, maxY - minY);
  const parts: string[] = [];
  parts.push(`<defs>`);
  parts.push(`<pattern id="udl-dots" width="18" height="18" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="0.7" fill="${DIAGRAM_DOT[theme]}" /></pattern>`);
  parts.push(`<filter id="udl-shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="1" stdDeviation="1.1" flood-color="${theme === "dark" ? "#000000" : "#1c1915"}" flood-opacity="${theme === "dark" ? "0.35" : "0.12"}" /></filter>`);
  parts.push(`</defs>`);
  parts.push(`<rect x="${minX}" y="${minY}" width="${width}" height="${height}" fill="${paper}" />`);
  parts.push(`<rect x="${minX}" y="${minY}" width="${width}" height="${height}" fill="url(#udl-dots)" />`);
  if (model.meta.title) {
    parts.push(`<text x="${minX + 16}" y="${minY + 20}" font-size="13" font-weight="640" fill="${ink}">${escapeXml(model.meta.title)}</text>`);
  }
  const groupFill = theme === "dark" ? "#221e2e" : "#efeafc";
  for (const [id, group] of Object.entries(model.groups)) {
    const box = layout[id];
    if (!box) continue;
    parts.push(`<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="14" fill="${groupFill}" stroke="${muted}" stroke-width="1" stroke-dasharray="4 3" />`);
    const chip = Math.max(44, group.label.length * 6.6 + 18);
    parts.push(`<rect x="${box.x + 10}" y="${box.y + 8}" width="${chip}" height="18" rx="9" fill="${paper}" stroke="${muted}" stroke-width="1" />`);
    parts.push(`<text x="${box.x + 10 + chip / 2}" y="${box.y + 17.5}" text-anchor="middle" dominant-baseline="middle" font-size="11" font-weight="650" fill="${muted}">${escapeXml(group.label)}</text>`);
  }
  for (const edge of Object.values(model.edges)) {
    const fromBox = layout[edge.from.node];
    const toBox = layout[edge.to.node];
    const fromNode = model.nodes[edge.from.node];
    const toNode = model.nodes[edge.to.node];
    if (!fromBox || !toBox || !fromNode || !toNode) continue;
    const ends = edgeEnds({ shape: fromNode.shape, box: fromBox, port: edge.from.port }, { shape: toNode.shape, box: toBox, port: edge.to.port });
    const route = edgeRoute({ ...ends, curve: edge.curve, bend: edge.bend, width: edge.width, head: edge.head, arrows: edge.arrow });
    const dash = edge.line === "dashed" ? ` stroke-dasharray="${n(route.width * 3.5)} ${n(route.width * 2.2)}"` : "";
    parts.push(`<path d="${route.d}" fill="none" stroke="${ink}" stroke-width="${n(route.width)}" stroke-linecap="round" stroke-linejoin="round"${dash} />`);
    for (const head of route.heads) parts.push(`<path d="${head}" fill="${ink}" stroke="${ink}" stroke-width="1" stroke-linejoin="round" />`);
    if (edge.label) {
      const metrics = labelMetrics(edge.font, LABEL_SIZE.edge);
      const midX = route.label.x;
      const midY = route.label.y;
      const pillW = Math.max(28, edge.label.length * metrics.char + 14);
      const pillH = Math.round(metrics.line + 4);
      parts.push(`<rect x="${n(midX - pillW / 2)}" y="${n(midY - pillH / 2)}" width="${n(pillW)}" height="${pillH}" rx="${n(pillH / 2)}" fill="${paper}" stroke="${DIAGRAM_DOT[theme]}" stroke-width="1" />`);
      parts.push(`<text x="${midX}" y="${midY}" text-anchor="middle" dominant-baseline="middle" ${fontAttrs(edge.font, LABEL_SIZE.edge, 600)} fill="${ink}">${escapeXml(edge.label)}</text>`);
    }
  }
  for (const [id, node] of Object.entries(model.nodes)) {
    const box = layout[id];
    if (!box) continue;
    const drawn = outlineSize(node.shape, box.w, box.h);
    const geometry = shapeGeometry(node.shape, drawn.w, drawn.h);
    const tone = paintFor(node.shape, node.color, theme);
    const fill = geometry.filled ? tone.fill : "none";
    parts.push(`<g transform="translate(${box.x} ${box.y})" filter="url(#udl-shadow)">`);
    parts.push(`<path d="${geometry.outline}" fill="${fill}" stroke="${tone.stroke}" stroke-width="1.35" stroke-linejoin="round" stroke-linecap="round" />`);
    if (geometry.details) parts.push(`<path d="${geometry.details}" fill="none" stroke="${tone.stroke}" stroke-width="1.15" stroke-linecap="round" />`);
    parts.push(`</g>`);
    parts.push(labelBlock(node.label, node.shape, box, tone.text, node.font));
    if (node.locked) {
      parts.push(`<rect x="${box.x + box.w - 46}" y="${box.y - 8}" width="44" height="14" rx="7" fill="${paper}" stroke="${muted}" stroke-width="1" />`);
      parts.push(`<text x="${box.x + box.w - 24}" y="${box.y - 1}" text-anchor="middle" dominant-baseline="middle" font-size="8" font-weight="700" fill="${muted}">LOCKED</text>`);
    }
  }
  for (const [id, text] of Object.entries(model.texts)) {
    const box = layout[id];
    if (!box) continue;
    const metrics = labelMetrics(text.font, LABEL_SIZE.text);
    const rows = text.text.split("\n").flatMap((row) => wrapLabel(row || " ", Math.max(20, box.w - 16), 99, text.font));
    const lines = rows.map((row, index) => `<tspan x="${n(box.x + 8)}" dy="${index === 0 ? 0 : n(metrics.line * 1.25)}">${escapeXml(row)}</tspan>`).join("");
    parts.push(`<text x="${n(box.x + 8)}" y="${n(box.y + 6 + metrics.size)}" ${fontAttrs(text.font, LABEL_SIZE.text, 560)} fill="${ink}">${lines}</text>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${minX} ${minY} ${width} ${height}" font-family="ui-sans-serif, system-ui, sans-serif">${parts.join("")}</svg>\n`;
}
