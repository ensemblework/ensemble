import type { DiagramEdge, DiagramModel, DiagramNode, DiagramText, PortName, TextStyle } from "./model.js";

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function num(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

function arrowToken(edge: DiagramEdge): string {
  const both = edge.arrow.start === "arrow" && edge.arrow.end === "arrow";
  const start = edge.arrow.start === "arrow" && edge.arrow.end === "none";
  const end = edge.arrow.end === "arrow" && edge.arrow.start === "none";
  if (both) return edge.line === "dashed" ? "<-->" : "<>";
  if (start) return edge.line === "dashed" ? "<--" : "<";
  if (end) return edge.line === "dashed" ? "-->" : ">";
  return edge.line === "dashed" ? ".." : "--";
}

function endpoint(id: string, port: PortName | null): string {
  return port ? `${id}.${port}` : id;
}

/** ` font 16 bold italic underline`, or nothing for plain text. */
function fontWords(font: TextStyle | undefined): string {
  if (!font) return "";
  const words: string[] = [];
  if (font.size != null) words.push(`font ${num(font.size)}`);
  if (font.bold) words.push("bold");
  if (font.italic) words.push("italic");
  if (font.underline) words.push("underline");
  return words.length ? ` ${words.join(" ")}` : "";
}

function printNode(id: string, node: DiagramNode, pad: string): string {
  const parts = [`${pad}node ${id} ${quote(node.label)} shape ${node.shape}`];
  if (node.color) parts.push(`color ${node.color}`);
  if (node.locked) parts.push("locked");
  return parts.join(" ") + fontWords(node.font);
}

function printText(id: string, text: DiagramText, pad: string): string {
  return `${pad}text ${id} ${quote(text.text)}${text.locked ? " locked" : ""}${fontWords(text.font)}`;
}

/** ` width 2 head 14 bend -30` for a line that is not drawn the default way. */
function lookWords(edge: DiagramEdge): string {
  const words: string[] = [];
  if (edge.width != null) words.push(`width ${num(edge.width)}`);
  if (edge.head != null) words.push(`head ${num(edge.head)}`);
  if (edge.bend) words.push(`bend ${num(edge.bend)}`);
  return words.length ? ` ${words.join(" ")}` : "";
}

function printGroup(model: DiagramModel, id: string, depth: number): string[] {
  const group = model.groups[id];
  if (!group) return [];
  const pad = "  ".repeat(depth);
  const lines = [`${pad}group ${id} ${quote(group.label)}${group.locked ? " locked" : ""} {`];
  for (const [nodeId, node] of Object.entries(model.nodes)) {
    if (node.group === id) lines.push(printNode(nodeId, node, `${pad}  `));
  }
  for (const [textId, text] of Object.entries(model.texts)) {
    if (text.group === id) lines.push(printText(textId, text, `${pad}  `));
  }
  for (const [childId, child] of Object.entries(model.groups)) {
    if (child.parent === id) lines.push(...printGroup(model, childId, depth + 1));
  }
  lines.push(`${pad}}`);
  return lines;
}

function edgeRank(id: string): number {
  const match = /^e(\d+)$/.exec(id);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

/** Canonical text. Canvas edits go through this so the source stays the thing people and agents edit. */
export function printDiagram(model: DiagramModel): string {
  const lines: string[] = [];
  if (model.meta.title.trim()) lines.push(`title ${model.meta.title.trim()}`);
  lines.push(`direction ${model.meta.direction}`);
  if (model.meta.curve !== "straight") lines.push(`curve ${model.meta.curve}`);
  lines.push("");
  for (const [id, node] of Object.entries(model.nodes)) {
    if (!node.group) lines.push(printNode(id, node, ""));
  }
  for (const [id, text] of Object.entries(model.texts)) {
    if (!text.group) lines.push(printText(id, text, ""));
  }
  for (const [id, group] of Object.entries(model.groups)) {
    if (!group.parent) lines.push(...printGroup(model, id, 0));
  }
  const edges = Object.entries(model.edges).sort(([a], [b]) => edgeRank(a) - edgeRank(b) || a.localeCompare(b));
  if (edges.length) {
    lines.push("");
    for (const [, edge] of edges) {
      const label = edge.label ? ` : ${quote(edge.label)}` : "";
      const curve = edge.curve !== model.meta.curve ? ` curve ${edge.curve}` : "";
      lines.push(`edge ${endpoint(edge.from.node, edge.from.port)} ${arrowToken(edge)} ${endpoint(edge.to.node, edge.to.port)}${label}${curve}${lookWords(edge)}${fontWords(edge.font)}`);
    }
  }
  const layoutIds = Object.keys(model.layout)
    .filter((id) => model.nodes[id] || model.texts[id] || model.groups[id])
    .sort((a, b) => a.localeCompare(b));
  if (layoutIds.length) {
    lines.push("");
    lines.push("layout");
    for (const id of layoutIds) {
      const box = model.layout[id]!;
      const owner = model.nodes[id] ?? model.texts[id] ?? model.groups[id];
      const locked = owner && "locked" in owner && owner.locked ? " locked" : "";
      lines.push(`  ${id} ${num(box.x)} ${num(box.y)} ${num(box.w)} ${num(box.h)}${locked}`);
    }
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}
