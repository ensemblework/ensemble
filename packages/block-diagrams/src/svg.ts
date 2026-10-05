import type { Curve, DiagramModel, LayoutBox, ShapeId } from "./model.js";
import { DIAGRAM_DOT, DIAGRAM_LINE, DIAGRAM_PAPER, PALETTE, paintFor, type DiagramTheme } from "./palette.js";
import { closestPorts, nodeSize, outlineSize, shapeGeometry, textFrame, textSize, wrapLabel } from "./shapes.js";

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
  for (const [id, node] of Object.entries(model.nodes)) take(id, nodeSize(node.shape, node.label));
  for (const [id, text] of Object.entries(model.texts)) take(id, textSize(text.text));
  for (const [id, group] of Object.entries(model.groups)) {
    if (model.layout[id]) layout[id] = model.layout[id]!;
    else {
      const members = Object.entries(layout).filter(([member]) => model.nodes[member]?.group === id || model.texts[member]?.group === id);
      if (!members.length) continue;
      const minX = Math.min(...members.map(([, box]) => box.x)) - 28;
      const minY = Math.min(...members.map(([, box]) => box.y)) - 40;
      const maxX = Math.max(...members.map(([, box]) => box.x + box.w)) + 28;
      const maxY = Math.max(...members.map(([, box]) => box.y + box.h)) + 22;
      layout[id] = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    void group;
  }
  return layout;
}

function edgePath(curve: Curve, x1: number, y1: number, x2: number, y2: number): { d: string; label: { x: number; y: number } } {
  if (curve === "curved") {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const bend = Math.min(36, len * 0.22);
    const cx = (x1 + x2) / 2 + (-dy / len) * bend;
    const cy = (y1 + y2) / 2 + (dx / len) * bend;
    return {
      d: `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`,
      label: { x: 0.25 * x1 + 0.5 * cx + 0.25 * x2, y: 0.25 * y1 + 0.5 * cy + 0.25 * y2 },
    };
  }
  if (curve === "elbow") {
    if (Math.abs(x2 - x1) >= Math.abs(y2 - y1)) {
      const midX = (x1 + x2) / 2;
      return { d: `M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2} ${y2}`, label: { x: midX, y: (y1 + y2) / 2 } };
    }
    const midY = (y1 + y2) / 2;
    return { d: `M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`, label: { x: (x1 + x2) / 2, y: midY } };
  }
  return { d: `M ${x1} ${y1} L ${x2} ${y2}`, label: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 } };
}

function labelBlock(label: string, shape: ShapeId, box: LayoutBox, fill: string): string {
  const frame = textFrame(shape, box.w, box.h);
  const lines = wrapLabel(label, Math.max(20, frame.w));
  const lineHeight = 16;
  const x = box.x + frame.x + frame.w / 2;
  const start = box.y + frame.y + frame.h / 2 - ((lines.length - 1) * lineHeight) / 2;
  return lines
    .map(
      (line, index) =>
        `<text x="${n(x)}" y="${n(start + index * lineHeight)}" text-anchor="middle" dominant-baseline="middle" font-size="13" font-weight="560" fill="${fill}">${escapeXml(line)}</text>`,
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
  parts.push(`<marker id="udl-arrow" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="7" markerHeight="7" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M 1 1.6 L 10 6 L 1 10.4 Z" fill="${ink}" /></marker>`);
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
    const picked = closestPorts(
      { shape: fromNode.shape, x: fromBox.x, y: fromBox.y, w: fromBox.w, h: fromBox.h },
      { shape: toNode.shape, x: toBox.x, y: toBox.y, w: toBox.w, h: toBox.h },
    );
    const fromPort = edge.from.port ?? picked.from;
    const toPort = edge.to.port ?? picked.to;
    const a = shapeGeometry(fromNode.shape, fromBox.w, fromBox.h).ports[fromPort];
    const b = shapeGeometry(toNode.shape, toBox.w, toBox.h).ports[toPort];
    const x1 = fromBox.x + a.x;
    const y1 = fromBox.y + a.y;
    const x2 = toBox.x + b.x;
    const y2 = toBox.y + b.y;
    const markerEnd = edge.arrow.end === "arrow" ? ' marker-end="url(#udl-arrow)"' : "";
    const markerStart = edge.arrow.start === "arrow" ? ' marker-start="url(#udl-arrow)"' : "";
    const dash = edge.line === "dashed" ? ' stroke-dasharray="5 3"' : "";
    const drawn = edgePath(edge.curve, x1, y1, x2, y2);
    parts.push(`<path d="${drawn.d}" fill="none" stroke="${ink}" stroke-width="1.35"${dash}${markerStart}${markerEnd} />`);
    if (edge.label) {
      const midX = drawn.label.x;
      const midY = drawn.label.y;
      const pillW = Math.max(28, edge.label.length * 6.1 + 14);
      const pillH = 16;
      parts.push(`<rect x="${midX - pillW / 2}" y="${midY - pillH / 2}" width="${pillW}" height="${pillH}" rx="8" fill="${paper}" stroke="${DIAGRAM_DOT[theme]}" stroke-width="1" />`);
      parts.push(`<text x="${midX}" y="${midY}" text-anchor="middle" dominant-baseline="middle" font-size="10" font-weight="600" fill="${ink}">${escapeXml(edge.label)}</text>`);
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
    parts.push(labelBlock(node.label, node.shape, box, tone.text));
    if (node.locked) {
      parts.push(`<rect x="${box.x + box.w - 46}" y="${box.y - 8}" width="44" height="14" rx="7" fill="${paper}" stroke="${muted}" stroke-width="1" />`);
      parts.push(`<text x="${box.x + box.w - 24}" y="${box.y - 1}" text-anchor="middle" dominant-baseline="middle" font-size="8" font-weight="700" fill="${muted}">LOCKED</text>`);
    }
  }
  for (const [id, text] of Object.entries(model.texts)) {
    const box = layout[id];
    if (!box) continue;
    parts.push(`<text x="${box.x + 4}" y="${box.y + 16}" font-size="12" font-weight="560" fill="${ink}">${escapeXml(text.text)}</text>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${minX} ${minY} ${width} ${height}" font-family="ui-sans-serif, system-ui, sans-serif">${parts.join("")}</svg>\n`;
}
