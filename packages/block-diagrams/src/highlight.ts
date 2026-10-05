import { COLORS, SHAPE_IDS } from "./model.js";
import { resolveColor, resolveShape } from "./shapes.js";

export type DiagramTokenKind = "comment" | "keyword" | "string" | "shape" | "color" | "arrow" | "number" | "id" | "punctuation";

export interface DiagramToken {
  from: number;
  to: number;
  kind: DiagramTokenKind;
  value: string;
}

const KEYWORDS = new Set([
  "title",
  "direction",
  "dir",
  "node",
  "block",
  "edge",
  "connect",
  "link",
  "group",
  "text",
  "textbox",
  "layout",
  "locked",
  "lock",
  "pin",
  "pinned",
  "shape",
  "type",
  "color",
  "colour",
  "curve",
]);

const ARROWS = ["<-->", "<--", "-->", "~~>", "<->", "<>", "->", "=>", "→", "<-", "--", "..>", "..", ">", "<"];

const COLORS_SET = new Set<string>(COLORS);
const SHAPE_SET = new Set<string>(SHAPE_IDS);

function knownShape(value: string): boolean {
  return resolveShape(value).warning === null;
}

function knownColor(value: string): boolean {
  if (COLORS_SET.has(value.toLowerCase())) return true;
  return resolveColor(value) !== null && /^#|^[a-z]/i.test(value.trim());
}

/** Tokens on one line. Offsets are relative to that line. */
export function scanLine(line: string): DiagramToken[] {
  const tokens: DiagramToken[] = [];
  let i = 0;
  let expect: "shape" | "color" | "curve" | null = null;
  while (i < line.length) {
    const ch = line[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "#" || line.startsWith("//", i)) {
      tokens.push({ from: i, to: line.length, kind: "comment", value: line.slice(i) });
      break;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = i;
      i += 1;
      while (i < line.length && line[i] !== quote) {
        i += line[i] === "\\" ? 2 : 1;
      }
      if (i < line.length) i += 1;
      tokens.push({ from: start, to: i, kind: "string", value: line.slice(start, i) });
      expect = null;
      continue;
    }
    const arrow = ARROWS.find((candidate) => line.startsWith(candidate, i));
    if (arrow) {
      tokens.push({ from: i, to: i + arrow.length, kind: "arrow", value: arrow });
      i += arrow.length;
      expect = null;
      continue;
    }
    if ("()[]{},:.".includes(ch)) {
      tokens.push({ from: i, to: i + 1, kind: "punctuation", value: ch });
      if (ch === "(" || ch === "[") expect = "shape";
      else if (ch !== ".") expect = null;
      i += 1;
      continue;
    }
    if (/^-?\d+(?:\.\d+)?$/.test(line.slice(i).match(/^-?\d+(?:\.\d+)?/)?.[0] ?? "") && /^-?\d/.test(line.slice(i))) {
      const match = /^-?\d+(?:\.\d+)?/.exec(line.slice(i))!;
      tokens.push({ from: i, to: i + match[0].length, kind: "number", value: match[0] });
      i += match[0].length;
      expect = null;
      continue;
    }
    const start = i;
    while (i < line.length) {
      if (/\s/.test(line[i]!) || "()[]{},:.='\"#".includes(line[i]!)) break;
      if (line.startsWith("//", i)) break;
      if (i > start && ARROWS.some((candidate) => candidate.length > 1 && line.startsWith(candidate, i))) break;
      if (i > start && (line[i] === ">" || line[i] === "<")) break;
      i += 1;
    }
    const value = line.slice(start, i);
    const lower = value.toLowerCase();
    let kind: DiagramTokenKind = "id";
    if (KEYWORDS.has(lower)) kind = "keyword";
    else if (expect === "shape") kind = knownShape(value) ? "shape" : "id";
    else if (expect === "color") kind = knownColor(value) ? "color" : "id";
    else if (expect === "curve" && (lower === "straight" || lower === "curved" || lower === "elbow")) kind = "keyword";
    else if (SHAPE_SET.has(lower) && !knownColor(value)) kind = "shape";
    else if (knownColor(value)) kind = "color";
    tokens.push({ from: start, to: i, kind, value });
    if (lower === "shape" || lower === "type") expect = "shape";
    else if (lower === "color" || lower === "colour") expect = "color";
    else if (lower === "curve") expect = "curve";
    else expect = null;
  }
  return tokens;
}

export function scanDiagram(source: string): DiagramToken[] {
  const tokens: DiagramToken[] = [];
  let offset = 0;
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    for (const token of scanLine(line)) {
      tokens.push({ ...token, from: token.from + offset, to: token.to + offset });
    }
    offset += line.length + 1;
  }
  return tokens;
}
