import {
  emptyModel,
  nextEdgeId,
  type DiagramModel,
  type Diagnostic,
  type Direction,
  type ParseResult,
  type ShapeId,
} from "./model.js";

const DIRECTION: Record<string, Direction> = {
  tb: "down",
  td: "down",
  bt: "up",
  lr: "right",
  rl: "left",
};

/**
 * True when the text is a Mermaid flowchart rather than Ensemble diagram language.
 * Only the first meaningful line is checked.
 */
const MERMAID_DIR: Record<string, string> = { down: "TD", up: "BT", left: "RL", right: "LR" };

function mermaidLabel(id: string, label: string, shape: string): string {
  const text = label.replace(/"/g, "#quot;");
  if (shape === "rounded" || shape === "ellipse") return `${id}("${text}")`;
  if (shape === "diamond") return `${id}{"${text}"}`;
  if (shape === "circle") return `${id}(("${text}"))`;
  if (shape === "cylinder") return `${id}[("${text}")]`;
  if (shape === "hexagon") return `${id}{{"${text}"}}`;
  if (shape === "parallelogram") return `${id}[/"${text}"/]`;
  return `${id}["${text}"]`;
}

/** A Mermaid flowchart of the same blocks and arrows. Layout, locks, and groups are dropped. */
export function toMermaid(model: DiagramModel): string {
  const lines = [`flowchart ${MERMAID_DIR[model.meta.direction] ?? "TD"}`];
  for (const [id, node] of Object.entries(model.nodes)) lines.push(`  ${mermaidLabel(id, node.label, node.shape)}`);
  for (const edge of Object.values(model.edges)) {
    const arrow = edge.line === "dashed" ? "-.->" : "-->";
    const label = edge.label ? `|${edge.label.replace(/\|/g, "/")}|` : "";
    lines.push(`  ${edge.from.node} ${arrow}${label} ${edge.to.node}`);
  }
  return `${lines.join("\n")}\n`;
}

export function looksLikeMermaid(text: string): boolean {
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("%%") || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
    return /^(flowchart|graph)\b/i.test(trimmed);
  }
  return false;
}

interface ArrowHit {
  token: string;
  label: string;
  next: number;
}

function readArrow(input: string, index: number): ArrowHit | null {
  const rest = input.slice(index);
  const labeled = /^(-->|-.->|==>|---|===|--)\s*\|([^|]*)\|/.exec(rest);
  if (labeled) return { token: labeled[1]!, label: labeled[2]!.trim(), next: index + labeled[0].length };
  const words = /^--\s+([^<>|\n]+?)\s+(-->|---|-\.->)/.exec(rest);
  if (words) return { token: words[2]!, label: words[1]!.trim(), next: index + words[0].length };
  const plain = /^(<-->|<-\.->|-->|-\.->|==>|---|-\.-|===|->|--)/.exec(rest);
  if (plain) return { token: plain[1]!, label: "", next: index + plain[1]!.length };
  return null;
}

function arrowStyle(token: string): { line: "solid" | "dashed"; start: "none" | "arrow"; end: "none" | "arrow" } {
  if (token.includes(".-") || token.includes("-.")) return token.includes(">") || token.includes("<")
    ? { line: "dashed", start: token.includes("<") ? "arrow" : "none", end: token.includes(">") ? "arrow" : "none" }
    : { line: "dashed", start: "none", end: "none" };
  if (token === "---" || token === "--" || token === "===") return { line: "solid", start: "none", end: "none" };
  if (token.includes("<") && token.includes(">")) return { line: "solid", start: "arrow", end: "arrow" };
  if (token.includes("<")) return { line: "solid", start: "arrow", end: "none" };
  return { line: "solid", start: "none", end: "arrow" };
}

interface MermaidNode {
  id: string;
  label: string | null;
  shape: ShapeId | null;
  next: number;
}

function readShape(input: string, index: number, id: string): MermaidNode {
  const rest = input.slice(index);
  const wrapped: Array<{ open: string; close: string; shape: ShapeId }> = [
    { open: "([", close: "])", shape: "rounded" },
    { open: "[[", close: "]]", shape: "rectangle" },
    { open: "[(", close: ")]", shape: "cylinder" },
    { open: "((", close: "))", shape: "circle" },
    { open: "{{", close: "}}", shape: "hexagon" },
    { open: "[/", close: "/]", shape: "parallelogram" },
    { open: "[\\", close: "\\]", shape: "parallelogram" },
    { open: "[/", close: "\\]", shape: "trapezoid" },
    { open: "[\\", close: "/]", shape: "trapezoid" },
    { open: ">", close: "]", shape: "triangle" },
    { open: "{", close: "}", shape: "diamond" },
    { open: "(", close: ")", shape: "rounded" },
    { open: "[", close: "]", shape: "rectangle" },
  ];
  if (rest.startsWith("@{")) {
    const end = rest.indexOf("}");
    const body = end >= 0 ? rest.slice(2, end) : rest.slice(2);
    const shapeMatch = /shape\s*:\s*([A-Za-z0-9_-]+)/i.exec(body);
    const labelMatch = /label\s*:\s*"([^"]*)"/i.exec(body) ?? /label\s*:\s*([^,}]+)/i.exec(body);
    const shape = mermaidShapeName(shapeMatch?.[1] ?? "");
    return { id, label: labelMatch?.[1]?.trim() ?? null, shape, next: index + (end >= 0 ? end + 1 : rest.length) };
  }
  for (const item of wrapped) {
    if (!rest.startsWith(item.open)) continue;
    const end = rest.indexOf(item.close, item.open.length);
    if (end < 0) continue;
    return { id, label: rest.slice(item.open.length, end).trim(), shape: item.shape, next: index + end + item.close.length };
  }
  return { id, label: null, shape: null, next: index };
}

function mermaidShapeName(raw: string): ShapeId | null {
  const key = raw.toLowerCase();
  const table: Record<string, ShapeId> = {
    rect: "rectangle",
    rectangle: "rectangle",
    rounded: "rounded",
    stadium: "rounded",
    diamond: "diamond",
    diam: "diamond",
    decision: "diamond",
    circle: "circle",
    ellipse: "ellipse",
    cyl: "cylinder",
    cylinder: "cylinder",
    database: "cylinder",
    hex: "hexagon",
    hexagon: "hexagon",
    trap: "trapezoid",
    trapezoid: "trapezoid",
    doc: "document",
    document: "document",
    odd: "triangle",
    triangle: "triangle",
  };
  return table[key] ?? null;
}

function readNode(input: string, index: number): MermaidNode | null {
  const match = /^([A-Za-z_][A-Za-z0-9_-]*)/.exec(input.slice(index));
  if (!match) return null;
  return readShape(input, index + match[1]!.length, match[1]!);
}

function skipSpace(input: string, index: number): number {
  while (index < input.length && /\s/.test(input[index]!)) index += 1;
  return index;
}

interface Builder {
  model: DiagramModel;
  diagnostics: Diagnostic[];
  stack: string[];
  seen: Set<string>;
}

function groupOf(builder: Builder): string | null {
  return builder.stack.length ? builder.stack[builder.stack.length - 1]! : null;
}

function touchNode(builder: Builder, node: MermaidNode, line: number) {
  const current = builder.model.nodes[node.id];
  if (!current) {
    builder.model.nodes[node.id] = {
      label: node.label || node.id,
      shape: node.shape ?? "rectangle",
      color: null,
      group: groupOf(builder),
      locked: false,
    };
    builder.seen.add(node.id);
    return;
  }
  if (node.label) current.label = node.label;
  if (node.shape) current.shape = node.shape;
  if (!builder.seen.has(node.id) && groupOf(builder)) current.group = groupOf(builder);
  builder.seen.add(node.id);
  void line;
}

function addLink(builder: Builder, from: MermaidNode, to: MermaidNode, token: string, label: string) {
  touchNode(builder, from, 0);
  touchNode(builder, to, 0);
  const style = arrowStyle(token);
  const id = nextEdgeId(builder.model);
  builder.model.edges[id] = {
    from: { node: from.id, port: null },
    to: { node: to.id, port: null },
    label,
    line: style.line,
    arrow: { start: style.start, end: style.end },
    curve: builder.model.meta.curve,
  };
}

function parseLine(builder: Builder, raw: string, lineNo: number) {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("%%") || trimmed.startsWith("#") || trimmed.startsWith("//")) return;
  if (/^(flowchart|graph)\b/i.test(trimmed)) {
    const direction = /\b(TB|TD|BT|LR|RL)\b/i.exec(trimmed);
    if (direction) builder.model.meta.direction = DIRECTION[direction[1]!.toLowerCase()] ?? "down";
    return;
  }
  if (/^direction\b/i.test(trimmed)) {
    const direction = /\b(TB|TD|BT|LR|RL)\b/i.exec(trimmed);
    if (direction) builder.model.meta.direction = DIRECTION[direction[1]!.toLowerCase()] ?? "down";
    return;
  }
  if (/^subgraph\b/i.test(trimmed)) {
    const rest = trimmed.replace(/^subgraph\s+/i, "");
    const bracket = /^([A-Za-z_][A-Za-z0-9_-]*)\s*\[([^\]]*)\]\s*$/.exec(rest);
    const slug = rest.replace(/[[\]]/g, "").trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9_-]/g, "");
    const id = bracket?.[1] ?? (slug || "group");
    const label = (bracket?.[2]?.trim() || rest.replace(/[[\]]/g, "").trim()) || id;
    if (builder.model.groups[id] || builder.model.nodes[id]) {
      builder.diagnostics.push({ line: lineNo, severity: "error", message: `“${id}” is already used.` });
      return;
    }
    builder.model.groups[id] = { label, parent: groupOf(builder), locked: false };
    builder.stack.push(id);
    return;
  }
  if (/^end\b/i.test(trimmed)) {
    if (!builder.stack.pop()) builder.diagnostics.push({ line: lineNo, severity: "warning", message: "This end does not close a subgraph." });
    return;
  }
  if (/^(style|classDef|class|click|linkStyle)\b/i.test(trimmed)) {
    builder.diagnostics.push({ line: lineNo, severity: "warning", message: "Mermaid style and click lines are ignored." });
    return;
  }
  let index = 0;
  const nodes: MermaidNode[] = [];
  const arrows: Array<{ token: string; label: string }> = [];
  while (index < trimmed.length) {
    index = skipSpace(trimmed, index);
    if (index >= trimmed.length) break;
    const arrow = readArrow(trimmed, index);
    if (arrow && nodes.length) {
      arrows.push({ token: arrow.token, label: arrow.label });
      index = arrow.next;
      continue;
    }
    const node = readNode(trimmed, index);
    if (!node) {
      builder.diagnostics.push({ line: lineNo, severity: "error", message: "This Mermaid line could not be read, so it was skipped." });
      return;
    }
    nodes.push(node);
    index = node.next;
    index = skipSpace(trimmed, index);
    if (trimmed[index] === "&") {
      builder.diagnostics.push({ line: lineNo, severity: "warning", message: "Mermaid & chains are only partly read." });
      index += 1;
    }
  }
  if (!nodes.length) return;
  if (!arrows.length) {
    for (const node of nodes) touchNode(builder, node, lineNo);
    return;
  }
  if (nodes.length !== arrows.length + 1) {
    builder.diagnostics.push({ line: lineNo, severity: "error", message: "This Mermaid line could not be read, so it was skipped." });
    return;
  }
  for (let i = 0; i < arrows.length; i += 1) {
    addLink(builder, nodes[i]!, nodes[i + 1]!, arrows[i]!.token, arrows[i]!.label);
  }
}

/** Convert a Mermaid flowchart into the Ensemble diagram model. Other Mermaid diagram types are rejected. */
export function importMermaid(text: string): ParseResult {
  const model = emptyModel();
  const diagnostics: Diagnostic[] = [];
  if (!looksLikeMermaid(text)) {
    diagnostics.push({ line: 1, severity: "error", message: "This is not a Mermaid flowchart. Start it with flowchart or graph." });
    return { model, diagnostics };
  }
  const builder: Builder = { model, diagnostics, stack: [], seen: new Set() };
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) parseLine(builder, lines[i] ?? "", i + 1);
  if (builder.stack.length) diagnostics.push({ line: lines.length, severity: "warning", message: "A subgraph is missing end." });
  diagnostics.unshift({ line: 1, severity: "warning", message: "Read as a Mermaid flowchart. Saving it writes Ensemble diagram language." });
  return { model, diagnostics };
}
