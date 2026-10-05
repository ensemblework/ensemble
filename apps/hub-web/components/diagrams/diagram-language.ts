import { type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { foldService, LanguageSupport, StreamLanguage } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { hoverTooltip, type Tooltip } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { COLORS, SHAPE_IDS, scanLine, type DiagramModel, type DiagramToken } from "@ensemble/block-diagrams";

const SHAPE_HELP: Record<string, string> = {
  rectangle: "A plain block.",
  rounded: "A block with rounded corners.",
  diamond: "A decision, usually a question.",
  circle: "A round block, often a start or end.",
  ellipse: "An oval block.",
  cylinder: "A database or store.",
  server: "A service, drawn as a stack of bays.",
  triangle: "A triangle.",
  parallelogram: "Input or output.",
  document: "A document with a wavy foot.",
  cloud: "An outside system.",
  actor: "A person. The name sits under the figure.",
  hexagon: "A preparation step.",
  note: "A note with a folded corner.",
  trapezoid: "A manual step.",
};

const lineCache = new Map<string, DiagramToken[]>();

function tokensFor(line: string): DiagramToken[] {
  const cached = lineCache.get(line);
  if (cached) return cached;
  const tokens = scanLine(line);
  if (lineCache.size > 400) lineCache.clear();
  lineCache.set(line, tokens);
  return tokens;
}

function tokenAt(line: string, column: number): DiagramToken | null {
  return tokensFor(line).find((token) => column >= token.from && column <= token.to) ?? null;
}

/** Braces, parens, and brackets stay punctuation-coloured, but each pair is its own token so matching stays accurate. */
function tokenStyle(line: string, token: DiagramToken): string {
  if (token.kind !== "punctuation") return token.kind;
  const ch = line[token.from];
  if (ch === "{" || ch === "}") return "brace";
  if (ch === "(" || ch === ")") return "paren";
  if (ch === "[" || ch === "]") return "bracket";
  return "punctuation";
}

function completions(context: CompletionContext, model: DiagramModel | null): CompletionResult | null {
  const word = context.matchBefore(/[#A-Za-z_][\w-]*/);
  if (!word && !context.explicit) return null;
  const from = word?.from ?? context.pos;
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);
  const ids = model ? [...Object.keys(model.nodes), ...Object.keys(model.groups), ...Object.keys(model.texts)] : [];
  const keywords = ["title", "direction", "curve", "node", "edge", "group", "text", "layout", "shape", "color", "locked"].map(
    (label) => ({ label, type: "keyword" as const }),
  );
  let options: Completion[] = [];
  if (/(?:shape|type|\(|\[)\s*[A-Za-z_]*$/i.test(before)) {
    options = SHAPE_IDS.map((label) => ({ label, type: "type", detail: SHAPE_HELP[label] }));
  } else if (/(?:color|colour)\s*[#A-Za-z_]*$/i.test(before)) {
    options = COLORS.map((label) => ({ label, type: "constant", detail: "colour" }));
  } else if (/(?:direction|dir)\s*[A-Za-z-]*$/i.test(before)) {
    options = ["down", "up", "left", "right"].map((label) => ({ label, type: "keyword", detail: "direction" }));
  } else if (/\bcurve\s*[A-Za-z-]*$/i.test(before)) {
    options = ["straight", "curved", "elbow"].map((label) => ({ label, type: "keyword", detail: "curve" }));
  } else if (/(?:edge|connect|link|-->|->|~~>|=>|>|<--|<-|<)\s*[A-Za-z_][\w-]*$/i.test(before)) {
    options = ids.map((label) => ({
      label,
      type: "variable",
      detail: model?.nodes[label] ? model.nodes[label].shape : model?.groups[label] ? "group" : "text",
    }));
  } else if (/^\s*[A-Za-z_]*$/.test(before)) {
    options = keywords;
  } else if (word) {
    options = [...keywords, ...SHAPE_IDS.map((label) => ({ label, type: "type" as const })), ...ids.map((label) => ({ label, type: "variable" as const }))];
  }
  if (!options.length) return null;
  return { from, options, validFor: /^[#\w-]*$/ };
}

function hover(lineText: string, column: number, lineFrom: number, model: DiagramModel | null): Tooltip | null {
  const token = tokenAt(lineText, column);
  if (!token || token.kind === "punctuation" || token.kind === "comment") return null;
  const text = describe(token, model);
  if (!text) return null;
  return {
    pos: lineFrom + token.from,
    end: lineFrom + token.to,
    above: true,
    create() {
      const dom = document.createElement("div");
      dom.className = "diagram-hover";
      dom.textContent = text;
      return { dom };
    },
  };
}

function describe(token: DiagramToken, model: DiagramModel | null): string | null {
  if (token.kind === "keyword") {
    const help: Record<string, string> = {
      node: "A block. Example: node start \"Start\" shape circle",
      edge: "A line between blocks. Example: edge start > next : \"yes\"",
      group: "A frame around blocks. Close it with }.",
      title: "The name shown on the diagram.",
      direction: "Which way the diagram flows: down, up, left, or right.",
      curve: "How lines bend: straight, curved, or elbow (right angles).",
      straight: "A straight line from port to port.",
      curved: "A gentle curve between the two ports.",
      elbow: "An orthogonal line that turns at right angles.",
      layout: "Exact positions. Example: start 40 80 120 48",
      text: "A floating note, not a shaped block.",
      shape: "The outline of a block, such as circle or cylinder.",
      color: "A palette colour, such as blue, or a hex colour like #336699.",
      locked: "Keep this block where it is when the diagram is reorganized.",
    };
    return help[token.value.toLowerCase()] ?? `Keyword ${token.value}.`;
  }
  if (token.kind === "shape") return SHAPE_HELP[token.value.toLowerCase()] ?? `Shape ${token.value}.`;
  if (token.kind === "color") return `Colour ${token.value}.`;
  if (token.kind === "arrow") return "Connects two blocks. Use > for an arrow, --> for a dashed arrow.";
  if (token.kind === "id" && model) {
    const node = model.nodes[token.value];
    if (node) return `Block “${node.label}”. Shape ${node.shape}${node.color ? `, colour ${node.color}` : ""}.`;
    const group = model.groups[token.value];
    if (group) return `Group “${group.label}”.`;
    const text = model.texts[token.value];
    if (text) return `Text “${text.text}”.`;
  }
  return null;
}

const foldDiagram = (state: EditorState, from: number) => {
  const line = state.doc.lineAt(from);
  const text = line.text;
  const trimmed = text.trim();
  if (/^layout\b/i.test(trimmed) && !trimmed.includes("{")) {
    let to = line.to;
    for (let number = line.number + 1; number <= state.doc.lines; number += 1) {
      const next = state.doc.line(number);
      if (!next.text.trim()) {
        to = next.to;
        continue;
      }
      if (/^\s+\S/.test(next.text) && !/^(title|direction|dir|curve|node|block|edge|connect|link|group|text|textbox|layout)\b/i.test(next.text.trim())) {
        to = next.to;
        continue;
      }
      break;
    }
    return to > line.to ? { from: line.to, to } : null;
  }
  if (!/\{\s*(?:\/\/.*|#.*)?$/.test(text)) return null;
  if (!/^(group|layout)\b/i.test(trimmed)) return null;
  let depth = 1;
  let to = line.to;
  for (let number = line.number + 1; number <= state.doc.lines; number += 1) {
    const next = state.doc.line(number);
    const stripped = next.text.replace(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\/\/.*|#.*/g, "");
    depth += (stripped.match(/\{/g) ?? []).length;
    depth -= (stripped.match(/\}/g) ?? []).length;
    to = next.to;
    if (depth <= 0) break;
  }
  return to > line.to ? { from: line.to, to } : null;
};

/** Highlighting, folding, completion, and hover for the diagram language. */
export function diagramLanguage(getModel: () => DiagramModel | null): LanguageSupport {
  const language = StreamLanguage.define({
    name: "ensemble-diagram",
    token(stream) {
      const tokens = tokensFor(stream.string);
      const next = tokens.find((token) => token.to > stream.pos);
      if (!next || next.from > stream.pos) {
        stream.next();
        return null;
      }
      const style = tokenStyle(stream.string, next);
      stream.pos = next.to;
      return style;
    },
    tokenTable: {
      comment: tags.comment,
      keyword: tags.keyword,
      string: tags.string,
      shape: tags.typeName,
      color: tags.atom,
      arrow: tags.operator,
      number: tags.number,
      id: tags.variableName,
      brace: tags.punctuation,
      paren: tags.punctuation,
      bracket: tags.punctuation,
      punctuation: tags.punctuation,
    },
    languageData: {
      commentTokens: { line: "#" },
      autocomplete: (context: CompletionContext) => completions(context, getModel()),
    },
  });
  return new LanguageSupport(language, [
    foldService.of(foldDiagram),
    hoverTooltip((view, pos) => {
      const line = view.state.doc.lineAt(pos);
      return hover(line.text, pos - line.from, line.from, getModel());
    }),
  ]);
}
