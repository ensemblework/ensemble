import {
  ARROW_HEAD,
  FONT_LIMITS,
  LINE_WIDTH,
  edgeBetween,
  emptyModel,
  lookupId,
  mergeEdgeInto,
  nextEdgeId,
  slugId,
  uniqueId,
  type Curve,
  type DiagramModel,
  type Diagnostic,
  type DiagnosticFix,
  type Direction,
  type ParseResult,
  type PortName,
  type TextStyle,
} from "./model.js";
import { resolveColor, resolvePort, resolveShape, suggestColor } from "./shapes.js";
import { importMermaid, looksLikeMermaid } from "./mermaid.js";

const ARROWS = ["<-->", "<--", "-->", "~~>", "<->", "<>", "->", "=>", "→", "<-", "--", "..>", "..", ">", "<"];

const DIRECTION_WORDS: Record<string, Direction> = {
  down: "down",
  up: "up",
  left: "left",
  right: "right",
  tb: "down",
  td: "down",
  bt: "up",
  lr: "right",
  rl: "left",
  "top-down": "down",
  topdown: "down",
  "bottom-up": "up",
  bottomup: "up",
  "left-right": "right",
  leftright: "right",
  "right-left": "left",
  rightleft: "left",
};

interface Token {
  kind: "word" | "string" | "punct";
  value: string;
}

interface Endpoint {
  ref: string;
  port: PortName | null;
}

interface ArrowStyle {
  line: "solid" | "dashed";
  start: "none" | "arrow";
  end: "none" | "arrow";
}

function tokenize(input: string): { tokens: Token[]; unclosed: boolean } {
  const tokens: Token[] = [];
  let unclosed = false;
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      let value = "";
      while (i < input.length && input[i] !== quote) {
        if (input[i] === "\\" && i + 1 < input.length) {
          value += input[i + 1];
          i += 2;
          continue;
        }
        value += input[i];
        i += 1;
      }
      if (i >= input.length) unclosed = true;
      else i += 1;
      tokens.push({ kind: "string", value });
      continue;
    }
    if ("()[]{},:.=".includes(ch)) {
      tokens.push({ kind: "punct", value: ch });
      i += 1;
      continue;
    }
    let value = "";
    while (i < input.length && !/\s/.test(input[i]!) && !"()[]{},:.='\"\\".includes(input[i]!)) {
      value += input[i];
      i += 1;
    }
    tokens.push({ kind: "word", value });
  }
  return { tokens, unclosed };
}

function isIdent(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(value);
}

function keyword(line: string, words: string[]): string | null {
  for (const word of words) {
    const match = new RegExp(`^${word}\\b\\s*:?\\s*`, "i").exec(line);
    if (match) return line.slice(match[0].length);
  }
  return null;
}

function indentOf(line: string): number {
  const match = /^[ \t]*/.exec(line);
  return (match?.[0] ?? "").replace(/\t/g, "  ").length;
}

function arrowStyle(token: string): ArrowStyle {
  switch (token) {
    case "-->":
    case "~~>":
    case "..>":
      return { line: "dashed", start: "none", end: "arrow" };
    case "--":
      return { line: "solid", start: "none", end: "none" };
    case "..":
      return { line: "dashed", start: "none", end: "none" };
    case "<>":
    case "<->":
      return { line: "solid", start: "arrow", end: "arrow" };
    case "<-->":
      return { line: "dashed", start: "arrow", end: "arrow" };
    case "<":
    case "<-":
      return { line: "solid", start: "arrow", end: "none" };
    case "<--":
      return { line: "dashed", start: "arrow", end: "none" };
    default:
      return { line: "solid", start: "none", end: "arrow" };
  }
}

function findArrows(input: string): Array<{ index: number; token: string }> {
  const found: Array<{ index: number; token: string }> = [];
  let i = 0;
  let quote: string | null = null;
  while (i < input.length) {
    const ch = input[i]!;
    if (quote) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
      continue;
    }
    let matched = "";
    for (const arrow of ARROWS) {
      if (input.startsWith(arrow, i)) {
        matched = arrow;
        break;
      }
    }
    if (matched) {
      found.push({ index: i, token: matched });
      i += matched.length;
      continue;
    }
    i += 1;
  }
  return found;
}

function wordsOf(tokens: Token[]): string {
  return tokens
    .filter((token) => token.kind !== "punct")
    .map((token) => token.value)
    .join(" ")
    .trim();
}

/** Keeps dots and commas so `auth.e, db.w` still names ports. */
function surface(tokens: Token[]): string {
  let out = "";
  for (const token of tokens) {
    if (token.kind === "string") {
      out += ` "${token.value}"`;
      continue;
    }
    if (token.kind === "punct" && token.value === ".") {
      out += ".";
      continue;
    }
    if (token.kind === "punct" && token.value === ",") {
      out += ", ";
      continue;
    }
    if (token.kind === "punct") continue;
    out += out.endsWith(".") ? token.value : `${out ? " " : ""}${token.value}`;
  }
  return out.trim();
}

interface Props {
  shapeRaw: string | null;
  colorRaw: string | null;
  locked: boolean;
  unclosed: boolean;
  unknown: string[];
  /** `font 16`, `bold`, `italic`, `underline`. */
  font: Partial<TextStyle>;
  /** A font size outside 8–48, as written. */
  fontRaw: string | null;
}

const STYLE_WORDS = new Set(["bold", "italic", "underline"]);

/** `font 16` → 16, kept inside FONT_LIMITS. Null when it is not a number. */
function fontSize(raw: string): number | null {
  const value = Number(raw.replace(/px$/i, ""));
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.min(FONT_LIMITS.max, Math.max(FONT_LIMITS.min, Math.round(value * 2) / 2));
}

/** A number token, joining `12` `.` `5` back into 12.5. Returns how many tokens it used. */
function numberAt(tokens: Token[], at: number): { raw: string; used: number } | null {
  const first = tokens[at];
  if (!first || first.kind !== "word" || !/^-?\d+(px)?$/i.test(first.value)) return null;
  const dot = tokens[at + 1];
  const tail = tokens[at + 2];
  if (dot?.kind === "punct" && dot.value === "." && tail?.kind === "word" && /^\d+(px)?$/i.test(tail.value)) return { raw: `${first.value}.${tail.value}`, used: 3 };
  return { raw: first.value, used: 1 };
}

/** `keepFirst`: the first word is the item's id, never a shape, colour or style (`node bold "Bold"`). */
function takeProps(tokens: Token[], keepFirst = false): { props: Props; rest: Token[] } {
  const rest: Token[] = [];
  const props: Props = { shapeRaw: null, colorRaw: null, locked: false, unclosed: false, unknown: [], font: {}, fontRaw: null };
  const absorb = (list: Token[]) => {
    for (const token of list) {
      if (token.kind === "punct") continue;
      const lower = token.value.toLowerCase();
      if (lower === "locked" || lower === "pin" || lower === "pinned") {
        props.locked = true;
        continue;
      }
      if (STYLE_WORDS.has(lower)) {
        props.font[lower as "bold" | "italic" | "underline"] = true;
        continue;
      }
      if (lower === "shape" || lower === "type") continue;
      const color = resolveColor(token.value);
      if (color && !props.colorRaw) {
        props.colorRaw = token.value;
        continue;
      }
      if (!props.shapeRaw) {
        props.shapeRaw = token.value;
        continue;
      }
      props.unknown.push(token.value);
    }
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (keepFirst && i === 0 && token.kind === "word" && isIdent(token.value) && tokens.length > 1) {
      rest.push(token);
      continue;
    }
    if ((token.kind === "word" && (token.value.toLowerCase() === "shape" || token.value.toLowerCase() === "type")) || (token.kind === "punct" && token.value === "=")) {
      const next = tokens[i + 1];
      if (next && next.kind !== "punct") {
        if (!props.shapeRaw) props.shapeRaw = next.value;
        i += 1;
      }
      continue;
    }
    if (token.kind === "word" && token.value.toLowerCase() === "color") {
      const next = tokens[i + 1];
      if (next && next.kind !== "punct") {
        props.colorRaw = next.value;
        i += 1;
      }
      continue;
    }
    if (token.kind === "word" && ["locked", "pin", "pinned"].includes(token.value.toLowerCase())) {
      props.locked = true;
      continue;
    }
    if (token.kind === "word" && /^(font|fontsize|font-size)$/i.test(token.value)) {
      const number = numberAt(tokens, i + 1);
      const size = number ? fontSize(number.raw) : null;
      if (number && size != null) {
        if (Number(number.raw.replace(/px$/i, "")) !== size) props.fontRaw = number.raw;
        props.font.size = size;
        i += number.used;
        continue;
      }
    }
    if (token.kind === "word" && STYLE_WORDS.has(token.value.toLowerCase())) {
      props.font[token.value.toLowerCase() as "bold" | "italic" | "underline"] = true;
      continue;
    }
    if (token.kind === "punct" && (token.value === "(" || token.value === "[")) {
      const close = token.value === "(" ? ")" : "]";
      const inner: Token[] = [];
      let closed = false;
      i += 1;
      while (i < tokens.length) {
        if (tokens[i]!.kind === "punct" && tokens[i]!.value === close) {
          closed = true;
          break;
        }
        inner.push(tokens[i]!);
        i += 1;
      }
      if (!closed) props.unclosed = true;
      absorb(inner);
      continue;
    }
    if (token.kind === "punct" && token.value === ":") {
      const next = tokens[i + 1];
      if (next && next.kind === "word" && !props.shapeRaw) {
        props.shapeRaw = next.value;
        i += 1;
        continue;
      }
    }
    rest.push(token);
  }
  return { props, rest };
}

function readEndpoint(raw: string): Endpoint | null {
  const { tokens } = tokenize(raw.trim());
  if (!tokens.length) return null;
  let ref = "";
  let index = 0;
  if (tokens[0]!.kind === "string") {
    ref = tokens[0]!.value.trim();
    index = 1;
  } else if (tokens[0]!.kind === "word") {
    ref = tokens[0]!.value;
    index = 1;
  } else return null;
  let port: PortName | null = null;
  if (tokens[index]?.kind === "punct" && tokens[index]?.value === "." && tokens[index + 1]?.kind === "word") {
    port = resolvePort(tokens[index + 1]!.value);
    if (port) index += 2;
  }
  if (!ref) return null;
  return { ref, port };
}

interface Context {
  model: DiagramModel;
  diagnostics: Diagnostic[];
  declared: Set<string>;
  stack: Array<{ id: string; indent: number; brace: boolean; line: number }>;
  inLayout: boolean;
  layoutBrace: boolean;
  source: string;
  lineStarts: number[];
  /** Edges that did not name a curve, so they follow the diagram default once the file is fully read. */
  inheritedEdges: Set<string>;
}

function lineStartsOf(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function lineSpan(ctx: Context, line: number): { from: number; to: number } {
  const from = ctx.lineStarts[Math.max(0, line - 1)] ?? 0;
  const next = ctx.lineStarts[line] ?? ctx.source.length;
  let to = next;
  if (to > from && ctx.source[to - 1] === "\n") to -= 1;
  if (to > from && ctx.source[to - 1] === "\r") to -= 1;
  return { from, to: Math.max(from, to) };
}

function locate(ctx: Context, line: number, needle: string): { from: number; to: number } {
  const span = lineSpan(ctx, line);
  if (!needle) return span;
  const text = ctx.source.slice(span.from, span.to);
  const at = text.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return span;
  return { from: span.from + at, to: span.from + at + needle.length };
}

function report(
  ctx: Context,
  severity: Diagnostic["severity"],
  line: number,
  message: string,
  options?: { needle?: string; target?: string; fixes?: DiagnosticFix[] },
) {
  const span = options?.needle ? locate(ctx, line, options.needle) : lineSpan(ctx, line);
  const from = span.from;
  const to = span.to > span.from ? span.to : span.from + 1;
  ctx.diagnostics.push({
    line,
    severity,
    message,
    from,
    to: Math.min(to, ctx.source.length),
    ...(options?.target ? { target: options.target } : {}),
    fixes: options?.fixes ?? [],
  });
}

function warn(ctx: Context, line: number, message: string, options?: { needle?: string; target?: string; fixes?: DiagnosticFix[] }) {
  report(ctx, "warning", line, message, options);
}

function error(ctx: Context, line: number, message: string, options?: { needle?: string; target?: string; fixes?: DiagnosticFix[] }) {
  report(ctx, "error", line, message, options);
}

function replaceFix(title: string, span: { from: number; to: number }, insert: string): DiagnosticFix {
  return { title, from: span.from, to: span.to, insert };
}

function currentGroup(ctx: Context): string | null {
  return ctx.stack.length ? ctx.stack[ctx.stack.length - 1]!.id : null;
}

function closeIndent(ctx: Context, indent: number) {
  while (ctx.stack.length) {
    const top = ctx.stack[ctx.stack.length - 1]!;
    if (top.brace) break;
    if (top.indent < indent) break;
    ctx.stack.pop();
  }
}

function applyShape(ctx: Context, raw: string | null, line: number, target?: string): { shape: DiagramModel["nodes"][string]["shape"]; color: string | null } {
  if (!raw) return { shape: "rectangle", color: null };
  const resolved = resolveShape(raw);
  if (resolved.warning) {
    const span = locate(ctx, line, raw);
    const fixes = resolved.suggestion ? [replaceFix(`Use ${resolved.suggestion}`, span, resolved.suggestion)] : [];
    warn(ctx, line, resolved.warning, { needle: raw, target, fixes });
  }
  return { shape: resolved.shape, color: null };
}

function ensureNode(ctx: Context, ref: string, line: number): string | null {
  const found = lookupId(ctx.model, ref);
  if (found) {
    if (found.ambiguous) warn(ctx, line, `“${ref}” matches more than one label. I used ${found.id}.`, { needle: ref, target: found.id });
    return found.id;
  }
  const id = uniqueId([...Object.keys(ctx.model.nodes), ...Object.keys(ctx.model.groups), ...Object.keys(ctx.model.texts)], ref);
  ctx.model.nodes[id] = { label: ref, shape: "rectangle", color: null, group: currentGroup(ctx), locked: false };
  const at = lineSpan(ctx, line).from;
  const safe = ref.replace(/"/g, "");
  warn(ctx, line, `There is no block named “${ref}”. I added a rectangle so the line still draws.`, {
    needle: ref,
    target: id,
    fixes: [{ title: `Create block “${id}”`, from: at, to: at, insert: `node ${id} "${safe}" shape rectangle\n` }],
  });
  return id;
}

const CURVE_WORDS: Record<string, Curve> = {
  straight: "straight",
  curved: "curved",
  curve: "curved",
  elbow: "elbow",
  orthogonal: "elbow",
  ortho: "elbow",
};

/** Pull `curve straight|curved|elbow` off an edge line. Words inside quotes stay labels. */
function takeCurve(body: string): { body: string; curve: Curve | null; raw: string | null } {
  const masked = body.replace(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'/g, (quoted) => " ".repeat(quoted.length));
  const match = /\bcurve\s+([A-Za-z-]+)/i.exec(masked);
  if (!match || match.index === undefined) return { body, curve: null, raw: null };
  const word = match[1]!.toLowerCase();
  const curve = CURVE_WORDS[word] ?? null;
  const next = `${body.slice(0, match.index)} ${body.slice(match.index + match[0].length)}`.replace(/\s{2,}/g, " ").trim();
  return { body: next, curve, raw: curve ? null : match[1]! };
}

interface EdgeLook {
  width: number | null;
  head: number | null;
  bend: number | null;
  font: Partial<TextStyle>;
}

const LOOK_LIMITS = {
  width: { min: LINE_WIDTH.min, max: LINE_WIDTH.max, label: "Line widths" },
  head: { min: ARROW_HEAD.min, max: ARROW_HEAD.max, label: "Arrowheads" },
} as const;

/**
 * Pull `width 2`, `head 14`, `bend -30`, `font 12`, `bold`, `italic` and `underline` off an edge
 * line. They are read after the last arrow and, when the label is quoted, after it; words in an
 * unquoted label stay words.
 */
function takeLook(ctx: Context, body: string, line: number): { body: string; look: EdgeLook } {
  const look: EdgeLook = { width: null, head: null, bend: null, font: {} };
  const masked = body.replace(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'/g, (quoted) => " ".repeat(quoted.length));
  const arrows = findArrows(body);
  const last = arrows.length ? arrows[arrows.length - 1]! : null;
  let start = last ? last.index + last.token.length : 0;
  // Skip the target block (or `b, c`), so a block named “bold” stays a block.
  const target = /^\s*(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s:,]+)(?:\s*,\s*(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s:,]+))*/.exec(body.slice(start));
  if (target) start += target[0].length;
  let end = body.length;
  const colon = masked.indexOf(":", start);
  if (colon >= 0) {
    const label = body.slice(colon + 1).trimStart();
    if (label.startsWith('"') || label.startsWith("'")) {
      const quote = label[0]!;
      const open = body.indexOf(quote, colon);
      let close = open + 1;
      while (close < body.length && body[close] !== quote) close += body[close] === "\\" ? 2 : 1;
      start = close + 1;
    } else end = colon;
  }
  const cuts: Array<[number, number]> = [];
  const region = masked.slice(start, end);
  const pattern = /\b(width|head|bend|font)\s+(-?\d+(?:\.\d+)?)(px)?\b|\b(bold|italic|underline)\b/gi;
  for (const match of region.matchAll(pattern)) {
    const at = start + (match.index ?? 0);
    cuts.push([at, at + match[0].length]);
    if (match[4]) {
      look.font[match[4].toLowerCase() as "bold" | "italic" | "underline"] = true;
      continue;
    }
    const key = match[1]!.toLowerCase();
    const value = Number(match[2]);
    if (key === "bend") look.bend = Math.round(value);
    else if (key === "font") {
      const size = fontSize(match[2]!);
      if (size != null) look.font.size = size;
      if (size !== value) report(ctx, "info", line, `Text sizes go from ${FONT_LIMITS.min} to ${FONT_LIMITS.max}. I used ${size}.`, { needle: match[0] });
    } else {
      const limits = LOOK_LIMITS[key as "width" | "head"];
      const kept = Math.min(limits.max, Math.max(limits.min, value));
      if (kept !== value) report(ctx, "info", line, `${limits.label} go from ${limits.min} to ${limits.max}. I used ${kept}.`, { needle: match[0] });
      look[key as "width" | "head"] = kept;
    }
  }
  let next = body;
  for (const [from, to] of cuts.reverse()) next = `${next.slice(0, from)} ${next.slice(to)}`;
  return { body: next.replace(/\s{2,}/g, " ").trim(), look };
}

/** Adds the line, or folds it into the line already joining the same two blocks. True when folded. */
function addEdge(ctx: Context, from: Endpoint, to: Endpoint, style: ArrowStyle, label: string, line: number, curve: Curve | null, look: EdgeLook): boolean {
  const source = ensureNode(ctx, from.ref, line);
  const target = ensureNode(ctx, to.ref, line);
  if (!source || !target) return false;
  const edge = {
    from: { node: source, port: from.port },
    to: { node: target, port: to.port },
    label,
    line: style.line,
    arrow: { start: style.start, end: style.end },
    curve: curve ?? ctx.model.meta.curve,
    ...(look.width != null ? { width: look.width } : {}),
    ...(look.head != null ? { head: look.head } : {}),
    ...(look.bend ? { bend: look.bend } : {}),
    ...(Object.keys(look.font).length ? { font: { ...PLAIN_FONT, ...look.font } } : {}),
  };
  const existing = edgeBetween(ctx.model, source, target);
  if (existing) {
    mergeEdgeInto(ctx.model.edges[existing]!, edge);
    return true;
  }
  const id = nextEdgeId(ctx.model);
  ctx.model.edges[id] = edge;
  if (!curve) ctx.inheritedEdges.add(id);
  return false;
}

/** Two blocks have one line between them. A repeat is folded into the first and noted here. */
function repeatNotice(ctx: Context, line: number, pairs: Array<[string, string]>, removable: boolean) {
  if (!pairs.length) return;
  const named = pairs.map(([a, b]) => `${a} and ${b}`).join("; ");
  const span = lineSpan(ctx, line);
  const end = ctx.lineStarts[line] ?? ctx.source.length;
  report(ctx, "info", line, `${named} ${pairs.length === 1 ? "are" : "were"} already connected, and two blocks have one line between them. I merged this line into the first one.`, {
    fixes: removable ? [{ title: "Remove this line", from: span.from, to: end, insert: "" }] : [],
  });
}

function quoteFix(ctx: Context, line: number): DiagnosticFix {
  const span = lineSpan(ctx, line);
  const text = ctx.source.slice(span.from, span.to);
  const quote = text.lastIndexOf("'") > text.lastIndexOf('"') ? "'" : '"';
  return { title: "Close the quote", from: span.to, to: span.to, insert: quote };
}

function bracketFix(ctx: Context, line: number): DiagnosticFix {
  const span = lineSpan(ctx, line);
  const text = ctx.source.slice(span.from, span.to);
  const insert = text.includes("(") && !text.includes(")") ? ")" : "]";
  return { title: insert === ")" ? "Add the closing )" : "Add the closing ]", from: span.to, to: span.to, insert };
}

function defineNode(ctx: Context, body: string, line: number, explicit: boolean) {
  const { tokens, unclosed } = tokenize(body);
  if (unclosed) warn(ctx, line, "A quote is missing its closing mark. The text was still used.", { fixes: [quoteFix(ctx, line)] });
  const { props, rest } = takeProps(tokens, true);
  if (props.unclosed) warn(ctx, line, "A closing ) or ] is missing. The shape was still used.", { fixes: [bracketFix(ctx, line)] });
  for (const extra of props.unknown) warn(ctx, line, `I ignored “${extra}”. It isn’t a shape, colour, or lock.`, { needle: extra });
  fontNotice(ctx, line, props);
  let id = "";
  let label = "";
  if (explicit) {
    if (rest[0]?.kind === "word" && isIdent(rest[0].value)) {
      id = rest[0].value;
      label = wordsOf(rest.slice(1)) || id;
    } else if (rest[0]?.kind === "string") {
      label = rest[0].value;
      id = uniqueId(Object.keys(ctx.model.nodes), label);
    } else if (rest[0]?.kind === "word") {
      id = slugId(rest[0].value);
      label = wordsOf(rest) || id;
    }
  } else if (rest.some((token) => token.kind === "string")) {
    const quoted = rest.find((token) => token.kind === "string")!;
    const before = rest.slice(0, rest.indexOf(quoted));
    label = quoted.value;
    const ident = before.length === 1 && before[0]!.kind === "word" && isIdent(before[0]!.value) ? before[0]!.value : "";
    id = ident || uniqueId(Object.keys(ctx.model.nodes), label);
  } else {
    label = wordsOf(rest);
    id = uniqueId(Object.keys(ctx.model.nodes), label);
  }
  if (!id || !label) {
    error(ctx, line, "This block needs a name. Try: node start \"Start\" shape circle");
    return;
  }
  if (ctx.model.groups[id] || ctx.model.texts[id]) {
    error(ctx, line, `“${id}” is already used by a group or text box. Pick another name.`, { needle: id, target: id });
    return;
  }
  const shaped = applyShape(ctx, props.shapeRaw, line, id);
  let color: string | null = null;
  if (props.colorRaw) {
    color = resolveColor(props.colorRaw);
    if (!color) {
      const suggestion = suggestColor(props.colorRaw);
      const span = locate(ctx, line, props.colorRaw);
      warn(ctx, line, suggestion
        ? `Did you mean ${suggestion}? I don’t know the colour “${props.colorRaw}”, so the block keeps its usual colour.`
        : `I don’t know the colour “${props.colorRaw}”. The block keeps its usual colour. Try blue, green, amber, or a hex colour like #336699.`, {
        needle: props.colorRaw,
        target: id,
        fixes: suggestion ? [replaceFix(`Use ${suggestion}`, span, suggestion)] : [],
      });
    }
  }
  const existing = ctx.model.nodes[id] ?? Object.entries(ctx.model.nodes).find(([key]) => key.toLowerCase() === id.toLowerCase())?.[1];
  const existingId = ctx.model.nodes[id] ? id : Object.keys(ctx.model.nodes).find((key) => key.toLowerCase() === id.toLowerCase());
  if (existing && existingId) {
    if (ctx.declared.has(existingId)) {
      report(ctx, "info", line, `“${existingId}” was already declared. This later line replaces it.`, { needle: existingId, target: existingId });
    }
    existing.label = label || existing.label;
    if (props.shapeRaw) existing.shape = shaped.shape;
    if (color) existing.color = color;
    if (props.locked) existing.locked = true;
    if (Object.keys(props.font).length) existing.font = { ...PLAIN_FONT, ...existing.font, ...props.font };
    existing.group = currentGroup(ctx) ?? existing.group;
    ctx.declared.add(existingId);
    return;
  }
  ctx.model.nodes[id] = {
    label,
    shape: shaped.shape,
    color,
    group: currentGroup(ctx),
    locked: props.locked,
    ...(Object.keys(props.font).length ? { font: { ...PLAIN_FONT, ...props.font } } : {}),
  };
  ctx.declared.add(id);
}

const PLAIN_FONT: TextStyle = { size: null, bold: false, italic: false, underline: false };

function fontNotice(ctx: Context, line: number, props: Props) {
  if (props.fontRaw) report(ctx, "info", line, `Text sizes go from ${FONT_LIMITS.min} to ${FONT_LIMITS.max}. I used ${props.font.size}.`, { needle: props.fontRaw });
}

function defineText(ctx: Context, body: string, line: number) {
  const { tokens, unclosed } = tokenize(body);
  if (unclosed) warn(ctx, line, "A quote is missing its closing mark. The text was still used.", { fixes: [quoteFix(ctx, line)] });
  const { props, rest } = takeProps(tokens, true);
  let id = "";
  let text = "";
  if (rest[0]?.kind === "word" && isIdent(rest[0].value) && rest.length > 1) {
    id = rest[0].value;
    text = wordsOf(rest.slice(1));
  } else if (rest[0]?.kind === "string") {
    text = rest[0].value;
    id = uniqueId([...Object.keys(ctx.model.texts), ...Object.keys(ctx.model.nodes)], text);
  } else {
    text = wordsOf(rest);
    id = uniqueId([...Object.keys(ctx.model.texts), ...Object.keys(ctx.model.nodes)], text || "text");
  }
  if (!text) {
    error(ctx, line, "A text box needs words. Try: text note \"Remember the cutoff\"");
    return;
  }
  if (ctx.model.texts[id] || ctx.model.nodes[id]) {
    error(ctx, line, `“${id}” is already used. Pick another name.`, { needle: id, target: id });
    return;
  }
  fontNotice(ctx, line, props);
  ctx.model.texts[id] = { text, group: currentGroup(ctx), locked: props.locked, ...(Object.keys(props.font).length ? { font: { ...PLAIN_FONT, ...props.font } } : {}) };
}

function defineGroup(ctx: Context, body: string, line: number, indent: number) {
  const brace = /{\s*$/.test(body);
  const cleaned = body.replace(/{\s*$/, "").trim();
  const { tokens, unclosed } = tokenize(cleaned);
  if (unclosed) warn(ctx, line, "A quote is missing its closing mark. The group name was still used.", { fixes: [quoteFix(ctx, line)] });
  const { props, rest } = takeProps(tokens, true);
  let id = "";
  let label = "";
  if (rest[0]?.kind === "word" && isIdent(rest[0].value)) {
    id = rest[0].value;
    label = wordsOf(rest.slice(1)) || id;
  } else if (rest[0]?.kind === "string") {
    label = rest[0].value;
    id = uniqueId(Object.keys(ctx.model.groups), label);
  } else {
    label = wordsOf(rest);
    id = uniqueId(Object.keys(ctx.model.groups), label || "group");
  }
  if (!id) {
    error(ctx, line, "A group needs a name. Try: group backend \"Backend\" {");
    return;
  }
  if (ctx.model.groups[id] || ctx.model.nodes[id]) {
    error(ctx, line, `“${id}” is already used. Pick another name.`, { needle: id, target: id });
    return;
  }
  ctx.model.groups[id] = { label: label || id, parent: currentGroup(ctx), locked: props.locked };
  ctx.stack.push({ id, indent, brace, line });
}

function splitLabel(raw: string, line: number, ctx: Context): { endpoint: string; label: string } {
  const { tokens } = tokenize(raw);
  const colon = tokens.findIndex((token) => token.kind === "punct" && token.value === ":");
  if (colon >= 0) {
    return { endpoint: surface(tokens.slice(0, colon)), label: wordsOf(tokens.slice(colon + 1)) };
  }
  const endpointTokens: Token[] = [];
  const labelTokens: Token[] = [];
  if (tokens[0]?.kind === "string") {
    endpointTokens.push(tokens[0]);
    if (tokens[1]?.kind === "punct" && tokens[1].value === "." ) {
      endpointTokens.push(tokens[1]);
      if (tokens[2]) endpointTokens.push(tokens[2]);
      labelTokens.push(...tokens.slice(3));
    } else labelTokens.push(...tokens.slice(1));
  } else if (tokens[0]?.kind === "word") {
    endpointTokens.push(tokens[0]);
    let index = 1;
    if (tokens[1]?.kind === "punct" && tokens[1].value === "." && tokens[2]?.kind === "word") {
      endpointTokens.push(tokens[1], tokens[2]);
      index = 3;
    }
    labelTokens.push(...tokens.slice(index));
  }
  const label = wordsOf(labelTokens);
  if (label) {
    const span = locate(ctx, line, label);
    warn(ctx, line, `Add a colon before the line label “${label}”.`, {
      needle: label,
      fixes: [{ title: "Add a colon before the label", from: span.from, to: span.from, insert: ": " }],
    });
  }
  return { endpoint: surface(endpointTokens) || raw.trim(), label };
}

function parseEdge(ctx: Context, rawBody: string, line: number) {
  const taken = takeCurve(rawBody);
  if (taken.raw) {
    warn(ctx, line, `I don’t know the curve “${taken.raw}”. I used ${ctx.model.meta.curve}. Try straight, curved, or elbow.`, { needle: taken.raw });
  }
  const styled = takeLook(ctx, taken.body, line);
  const body = styled.body;
  const look = styled.look;
  const curve = taken.curve;
  const repeats: Array<[string, string]> = [];
  let added = 0;
  const connect = (from: Endpoint, to: Endpoint, style: ArrowStyle, label: string) => {
    if (addEdge(ctx, from, to, style, label, line, curve, look)) repeats.push([from.ref, to.ref]);
    else added += 1;
  };
  const arrows = findArrows(body);
  if (!arrows.length) {
    const words = body.trim().split(/\s+/).filter(Boolean);
    const fixes: DiagnosticFix[] = [];
    if (words.length >= 2 && words.every((word) => /^[\w-]+$/.test(word))) {
      const span = locate(ctx, line, words[0]!);
      fixes.push({ title: `Connect ${words[0]} to ${words[1]}`, from: span.to, to: span.to, insert: " >" });
    }
    error(ctx, line, "A line needs an arrow. Try: edge start > next", fixes.length ? { fixes } : undefined);
    return;
  }
  const parts: string[] = [];
  let cursor = 0;
  for (const arrow of arrows) {
    parts.push(body.slice(cursor, arrow.index).trim());
    cursor = arrow.index + arrow.token.length;
  }
  parts.push(body.slice(cursor).trim());
  if (parts.some((part) => !part.trim())) {
    error(ctx, line, "An arrow is missing the block it connects. Put a name on each side, like start > next.");
    return;
  }
  if (arrows.length === 1 && parts[1]!.includes(",")) {
    const { endpoint, label } = splitLabel(parts[1]!, line, ctx);
    const targets = endpoint.split(",").map((item) => item.trim()).filter(Boolean);
    const source = readEndpoint(parts[0]!);
    if (!source || !targets.length) {
      error(ctx, line, "I couldn’t read the blocks on this line. Use names like start > next.");
      return;
    }
    for (const target of targets) {
      const end = readEndpoint(target);
      if (!end) {
        error(ctx, line, `I couldn’t read “${target}”. Use a block name, like start or db.w.`, { needle: target });
        continue;
      }
      connect(source, end, arrowStyle(arrows[0]!.token), label);
    }
    repeatNotice(ctx, line, repeats, added === 0);
    return;
  }
  for (let i = 0; i < arrows.length; i += 1) {
    const left = parts[i]!;
    let right = parts[i + 1]!;
    let label = "";
    if (i === arrows.length - 1) {
      const split = splitLabel(right, line, ctx);
      right = split.endpoint;
      label = split.label;
    }
    const source = readEndpoint(left);
    const target = readEndpoint(right);
    if (!source || !target) {
      error(ctx, line, "I couldn’t read the blocks on this line. Use names like start > next.");
      return;
    }
    connect(source, target, arrowStyle(arrows[i]!.token), label);
  }
  repeatNotice(ctx, line, repeats, added === 0);
}

function parseLayoutEntry(ctx: Context, raw: string, line: number) {
  const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)(?:\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?))?(?:\s+(locked|pinned))?\s*$/i.exec(raw.trim());
  if (!match) {
    error(ctx, line, "A layout line looks like: start 40 80 160 64. That is the name, then x, y, and optionally width and height.");
    return;
  }
  const [, id, xs, ys, ws, hs, lock] = match;
  const found = lookupId(ctx.model, id!);
  if (!found) {
    const at = lineSpan(ctx, line).from;
    const safe = id!.replace(/"/g, "");
    warn(ctx, line, `There is no block named “${id}” to place.`, {
      needle: id,
      fixes: [{ title: `Create block “${safe}”`, from: at, to: at, insert: `node ${safe} "${safe}" shape rectangle\n` }],
    });
    return;
  }
  const previous = ctx.model.layout[found.id];
  const node = ctx.model.nodes[found.id];
  const text = ctx.model.texts[found.id];
  const w = ws ? Number(ws) : previous?.w ?? (node ? 160 : text ? 160 : 200);
  const h = hs ? Number(hs) : previous?.h ?? (node ? 64 : text ? 48 : 120);
  ctx.model.layout[found.id] = { x: Number(xs), y: Number(ys), w, h };
  if (lock) {
    if (node) node.locked = true;
    if (text) text.locked = true;
    const group = ctx.model.groups[found.id];
    if (group) group.locked = true;
  }
}

function looksLikeNode(body: string): boolean {
  if (/[(\[]/.test(body)) return true;
  if (/"|'/.test(body)) return true;
  if (/\bshape\b/i.test(body)) return true;
  return false;
}

function parseStatement(ctx: Context, rawLine: string, lineNo: number): "reprocess" | void {
  const indent = indentOf(rawLine);
  const trimmed = rawLine.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) return;
  if (ctx.inLayout) {
    if (trimmed === "}" && ctx.layoutBrace) {
      ctx.inLayout = false;
      ctx.layoutBrace = false;
      return;
    }
    if (/^(title|direction|dir|curve|node|block|edge|connect|link|group|text|textbox|layout)\b/i.test(trimmed)) {
      ctx.inLayout = false;
      ctx.layoutBrace = false;
      return "reprocess";
    }
    parseLayoutEntry(ctx, trimmed, lineNo);
    return;
  }
  if (trimmed === "}") {
    const top = ctx.stack[ctx.stack.length - 1];
    if (!top?.brace) {
      const span = locate(ctx, lineNo, "}");
      error(ctx, lineNo, "This } does not close a group. Remove it, or add group name \"Name\" { above it.", {
        needle: "}",
        fixes: [replaceFix("Remove this }", span, "")],
      });
      return;
    }
    ctx.stack.pop();
    return;
  }
  closeIndent(ctx, indent);
  const layoutBody = keyword(trimmed, ["layout"]);
  if (layoutBody !== null) {
    ctx.inLayout = true;
    ctx.layoutBrace = layoutBody.trim().startsWith("{");
    return;
  }
  const titleBody = keyword(trimmed, ["title"]);
  if (titleBody !== null) {
    const { tokens } = tokenize(titleBody);
    ctx.model.meta.title = (tokens.length === 1 && tokens[0]!.kind === "string" ? tokens[0]!.value : titleBody).trim();
    return;
  }
  const directionBody = keyword(trimmed, ["direction", "dir"]);
  if (directionBody !== null) {
    const word = directionBody.trim().toLowerCase().replace(/\s+/g, "-");
    const direction = DIRECTION_WORDS[word];
    if (!direction) {
      const raw = directionBody.trim();
      const options = ["down", "up", "left", "right"] as const;
      let suggestion: (typeof options)[number] | null = null;
      let best = 3;
      for (const option of options) {
        const dist = levenshtein(word, option);
        if (dist > 0 && dist < best) {
          best = dist;
          suggestion = option;
        }
      }
      const span = locate(ctx, lineNo, raw);
      warn(ctx, lineNo, suggestion
        ? `Did you mean ${suggestion}? I don’t know the direction “${raw}”, so I used down.`
        : `I don’t know the direction “${raw}”. I used down. Try down, up, left, or right.`, {
        needle: raw,
        fixes: suggestion ? [replaceFix(`Use ${suggestion}`, span, suggestion)] : [],
      });
      ctx.model.meta.direction = "down";
      return;
    }
    ctx.model.meta.direction = direction;
    return;
  }
  const curveBody = keyword(trimmed, ["curve"]);
  if (curveBody !== null) {
    const word = curveBody.trim().toLowerCase().split(/\s+/)[0] ?? "";
    const curve = CURVE_WORDS[word];
    if (!curve) {
      const raw = curveBody.trim() || "empty";
      const span = locate(ctx, lineNo, curveBody.trim() || "curve");
      warn(ctx, lineNo, `I don’t know the curve “${raw}”. I used straight. Try straight, curved, or elbow.`, {
        needle: curveBody.trim() || undefined,
        fixes: word && levenshtein(word, "curved") < 3 ? [replaceFix("Use curved", span, "curved")] : [],
      });
      ctx.model.meta.curve = "straight";
      return;
    }
    ctx.model.meta.curve = curve;
    return;
  }
  const groupBody = keyword(trimmed, ["group"]);
  if (groupBody !== null) {
    defineGroup(ctx, groupBody, lineNo, indent);
    return;
  }
  const textBody = keyword(trimmed, ["text", "textbox"]);
  if (textBody !== null) {
    defineText(ctx, textBody, lineNo);
    return;
  }
  const nodeBody = keyword(trimmed, ["node", "block"]);
  if (nodeBody !== null) {
    defineNode(ctx, nodeBody, lineNo, true);
    return;
  }
  const edgeBody = keyword(trimmed, ["edge", "connect", "link"]);
  if (edgeBody !== null) {
    parseEdge(ctx, edgeBody, lineNo);
    return;
  }
  if (findArrows(trimmed).length) {
    parseEdge(ctx, trimmed, lineNo);
    return;
  }
  if (looksLikeNode(trimmed)) {
    defineNode(ctx, trimmed, lineNo, false);
    return;
  }
  error(ctx, lineNo, "I couldn’t read this line, so I skipped it. Start it with node, edge, group, text, title, direction, curve, or layout.");
}

/**
 * Parse Ensemble diagram text into the versioned model.
 * One bad line becomes a diagnostic and is skipped. Mermaid flowcharts are accepted too.
 */
export function parseDiagram(text: string): ParseResult {
  const source = text.replace(/^\uFEFF/, "");
  if (looksLikeMermaid(source)) return importMermaid(source);
  const ctx: Context = {
    model: emptyModel(),
    diagnostics: [],
    declared: new Set(),
    stack: [],
    inLayout: false,
    layoutBrace: false,
    source,
    lineStarts: lineStartsOf(source),
    inheritedEdges: new Set(),
  };
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const action = parseStatement(ctx, lines[i] ?? "", i + 1);
    if (action === "reprocess") i -= 1;
  }
  for (const frame of ctx.stack) {
    if (!frame.brace) continue;
    const end = source.length;
    warn(ctx, frame.line, `The group “${frame.id}” is missing its closing }.`, {
      needle: "{",
      target: frame.id,
      fixes: [{ title: "Add the closing }", from: end, to: end, insert: source.endsWith("\n") ? "}\n" : "\n}\n" }],
    });
  }
  for (const id of ctx.inheritedEdges) {
    const edge = ctx.model.edges[id];
    if (edge) edge.curve = ctx.model.meta.curve;
  }
  return { model: ctx.model, diagnostics: ctx.diagnostics };
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j]!;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + cost);
      prev = current;
    }
  }
  return row[b.length]!;
}

export function errorCount(diagnostics: Diagnostic[]): number {
  return diagnostics.filter((item) => item.severity === "error").length;
}
