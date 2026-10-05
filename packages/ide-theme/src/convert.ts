import { contrastForeground, contrastRatio, formatColor, mix, parseColor, rgbTriplet, type Rgba } from "./color.js";
import { parseJsonc, ThemeSyntaxError } from "./jsonc.js";
import {
  kindFromUiTheme,
  normalizeUiTheme,
  TOKEN_ROLES,
  type EditorColors,
  type IdeTheme,
  type ThemeKind,
  type TokenRole,
  type TokenStyle,
  type UiTheme,
  type VsThemeDocument,
} from "./types.js";

const INCLUDE_MAX_DEPTH = 6;

const PROBES: Array<{ role: TokenRole; scope: string }> = [
  { role: "comment", scope: "comment.line" },
  { role: "string", scope: "string.quoted.double" },
  { role: "number", scope: "constant.numeric" },
  { role: "keyword", scope: "keyword" },
  { role: "controlKeyword", scope: "keyword.control" },
  { role: "operator", scope: "keyword.operator" },
  { role: "function", scope: "entity.name.function" },
  { role: "type", scope: "entity.name.type" },
  { role: "className", scope: "entity.name.class" },
  { role: "tag", scope: "entity.name.tag" },
  { role: "attribute", scope: "entity.other.attribute-name" },
  { role: "variable", scope: "variable.other.readwrite" },
  { role: "property", scope: "variable.other.property" },
  { role: "constant", scope: "constant.language" },
  { role: "regexp", scope: "string.regexp" },
  { role: "punctuation", scope: "punctuation" },
  { role: "invalid", scope: "invalid.illegal" },
  { role: "heading", scope: "markup.heading" },
  { role: "emphasis", scope: "markup.italic" },
  { role: "strong", scope: "markup.bold" },
  { role: "link", scope: "markup.underline.link" },
  { role: "inserted", scope: "markup.inserted" },
  { role: "deleted", scope: "markup.deleted" },
];

const SEMANTIC: Partial<Record<TokenRole, string[]>> = {
  comment: ["comment"],
  string: ["string"],
  number: ["number"],
  keyword: ["keyword"],
  function: ["function"],
  type: ["type", "interface", "enum"],
  className: ["class", "struct"],
  variable: ["variable", "parameter"],
  property: ["property"],
  constant: ["enumMember"],
  regexp: ["regexp"],
};

type Rule = { scopes: string[]; color?: Rgba; fontStyle?: string; unscoped?: boolean };

export type ResolveResult = { ok: true; document: VsThemeDocument } | { ok: false; reason: string };
export type ConvertResult = { ok: true; theme: IdeTheme } | { ok: false; reason: string };

/**
 * Follow `include` chains. `readText` returns the file relative to the extension root, or null.
 * Paths that escape the extension are rejected. Nothing in the theme is executed.
 */
export function resolveThemeDocument(entryPath: string, readText: (path: string) => string | null): ResolveResult {
  const seen = new Set<string>();
  const walk = (filePath: string, depth: number): ResolveResult => {
    if (depth > INCLUDE_MAX_DEPTH) return { ok: false, reason: "This theme includes too many other files." };
    if (seen.has(filePath)) return { ok: false, reason: "This theme includes itself in a loop." };
    seen.add(filePath);
    const text = readText(filePath);
    if (text == null) return { ok: false, reason: "Part of this theme file is missing." };
    let parsed: unknown;
    try {
      parsed = parseJsonc(text);
    } catch (error) {
      if (error instanceof ThemeSyntaxError) return { ok: false, reason: error.message };
      return { ok: false, reason: "This theme file isn't valid JSON." };
    }
    const document = asDocument(parsed);
    if (!document) return { ok: false, reason: "This theme file isn't a color theme." };
    const include = typeof document.include === "string" ? document.include : "";
    if (!include) return { ok: true, document: { ...document, include: undefined } };
    const next = safeJoin(filePath, include);
    if (!next) return { ok: false, reason: "This theme points outside its own files." };
    const base = walk(next, depth + 1);
    if (!base.ok) return base;
    return { ok: true, document: mergeDocuments(base.document, document) };
  };
  return walk(entryPath, 0);
}

export function convertTheme(input: {
  id: string;
  label: string;
  publisher?: string;
  uiTheme: string;
  document: unknown;
}): ConvertResult {
  const document = asDocument(input.document);
  if (!document) return { ok: false, reason: "This theme file isn't a color theme." };
  if (typeof document.include === "string" && document.include) {
    return { ok: false, reason: "This theme points at another file that wasn't included." };
  }
  const uiTheme = normalizeUiTheme(input.uiTheme);
  const kind = kindFromUiTheme(uiTheme);
  const colors = colorMap(document.colors);
  const rules = collectRules(document.tokenColors);
  const unscoped = rules.find((rule) => rule.unscoped && rule.color);
  const fallbackBg = kind === "light" ? parseColor("#ffffff")! : parseColor("#1e1e1e")!;
  const fallbackFg = kind === "light" ? parseColor("#1e1e1e")! : parseColor("#d4d4d4")!;
  const background = colors.get("editor.background") ?? fallbackBg;
  const foreground = colors.get("editor.foreground") ?? unscoped?.color ?? fallbackFg;
  const editor = editorColors(colors, background, foreground, kind);
  const tokens = tokenStyles(rules, document.semanticTokenColors);
  const theme: IdeTheme = {
    id: input.id.slice(0, 240),
    label: (input.label.trim() || document.name || "Theme").slice(0, 80),
    publisher: input.publisher?.trim().slice(0, 80) || undefined,
    uiTheme,
    kind,
    cssVars: chromeVars(colors, editor, kind),
    editor,
    tokens,
  };
  const clean = sanitizeIdeTheme(theme);
  if (!clean) return { ok: false, reason: "This theme's colors couldn't be read." };
  return { ok: true, theme: clean };
}

export function sanitizeIdeTheme(value: unknown): IdeTheme | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<IdeTheme>;
  if (typeof row.id !== "string" || row.id.length < 1 || row.id.length > 240) return null;
  if (typeof row.label !== "string" || row.label.length < 1 || row.label.length > 80) return null;
  if (row.uiTheme !== "vs" && row.uiTheme !== "vs-dark" && row.uiTheme !== "hc-black" && row.uiTheme !== "hc-light") return null;
  if (row.kind !== "dark" && row.kind !== "light" && row.kind !== "hc") return null;
  if (!row.cssVars || typeof row.cssVars !== "object" || Array.isArray(row.cssVars)) return null;
  const cssVars: Record<string, string> = {};
  const entries = Object.entries(row.cssVars);
  if (entries.length > 80) return null;
  for (const [key, raw] of entries) {
    if (!/^[a-z0-9-]{1,40}$/.test(key) || typeof raw !== "string") return null;
    if (key.endsWith("-rgb")) {
      if (!/^(?:[0-9]{1,3} ){2}[0-9]{1,3}$/.test(raw)) return null;
      if (raw.split(" ").some((part) => Number(part) > 255)) return null;
    } else if (!parseColor(raw)) return null;
    cssVars[key] = raw;
  }
  let editor: EditorColors | null = null;
  if (row.editor != null) {
    if (typeof row.editor !== "object") return null;
    const next = {} as EditorColors;
    for (const key of [
      "background",
      "foreground",
      "caret",
      "selection",
      "selectionMatch",
      "lineHighlight",
      "gutterBackground",
      "gutterForeground",
      "gutterActiveForeground",
      "gutterBorder",
    ] as const) {
      const color = row.editor[key];
      if (typeof color !== "string" || !parseColor(color)) return null;
      next[key] = color;
    }
    editor = next;
  }
  if (!Array.isArray(row.tokens) || row.tokens.length > TOKEN_ROLES.length) return null;
  const tokens: TokenStyle[] = [];
  for (const token of row.tokens) {
    if (!token || typeof token !== "object") return null;
    if (!TOKEN_ROLES.includes(token.role)) return null;
    const style: TokenStyle = { role: token.role };
    if (token.color != null) {
      if (typeof token.color !== "string" || !parseColor(token.color)) return null;
      style.color = token.color;
    }
    if (token.fontStyle != null) {
      if (typeof token.fontStyle !== "string" || !/^((italic|bold|underline|strikethrough)( |$))+$/.test(token.fontStyle)) return null;
      style.fontStyle = token.fontStyle.trim();
    }
    tokens.push(style);
  }
  const theme: IdeTheme = { id: row.id, label: row.label, uiTheme: row.uiTheme, kind: row.kind, cssVars, editor, tokens };
  if (typeof row.publisher === "string" && row.publisher.trim()) theme.publisher = row.publisher.trim().slice(0, 80);
  return theme;
}

function asDocument(value: unknown): VsThemeDocument | null {
  if (Array.isArray(value)) return { tokenColors: value };
  if (!value || typeof value !== "object") return null;
  return value as VsThemeDocument;
}

function mergeDocuments(base: VsThemeDocument, overlay: VsThemeDocument): VsThemeDocument {
  const baseRules = Array.isArray(base.tokenColors) ? base.tokenColors : [];
  const overlayRules = Array.isArray(overlay.tokenColors) ? overlay.tokenColors : [];
  return {
    name: typeof overlay.name === "string" ? overlay.name : base.name,
    type: typeof overlay.type === "string" ? overlay.type : base.type,
    colors: { ...stringRecord(base.colors), ...stringRecord(overlay.colors) },
    tokenColors: [...baseRules, ...overlayRules],
    semanticTokenColors: { ...plainRecord(base.semanticTokenColors), ...plainRecord(overlay.semanticTokenColors) },
  };
}

export function safeJoin(fromFile: string, include: string): string | null {
  if (!include || include.includes("\\") || include.startsWith("/") || /^[a-z]+:/i.test(include)) return null;
  const dir = fromFile.split("/").slice(0, -1);
  const stack: string[] = [];
  for (const part of [...dir, ...include.split("/")]) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!stack.length) return null;
      stack.pop();
      continue;
    }
    if (part.includes("\0")) return null;
    stack.push(part);
  }
  const next = stack.join("/");
  if (!next.endsWith(".json")) return null;
  return next;
}

function colorMap(colors: unknown): Map<string, Rgba> {
  const map = new Map<string, Rgba>();
  if (!colors || typeof colors !== "object" || Array.isArray(colors)) return map;
  for (const [key, value] of Object.entries(colors)) {
    if (typeof value !== "string") continue;
    const color = parseColor(value);
    if (color) map.set(key, color);
  }
  return map;
}

function collectRules(tokenColors: unknown): Rule[] {
  if (!Array.isArray(tokenColors)) return [];
  const rules: Rule[] = [];
  for (const entry of tokenColors.slice(0, 5000)) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as { scope?: unknown; settings?: unknown };
    const settings = row.settings && typeof row.settings === "object" ? (row.settings as Record<string, unknown>) : {};
    const color = typeof settings.foreground === "string" ? parseColor(settings.foreground) ?? undefined : undefined;
    const fontStyle = typeof settings.fontStyle === "string" ? normalizeFontStyle(settings.fontStyle) : undefined;
    if (!color && !fontStyle) continue;
    if (row.scope == null) {
      rules.push({ scopes: [], color, fontStyle, unscoped: true });
      continue;
    }
    const scopes = (Array.isArray(row.scope) ? row.scope : [row.scope]).filter(
      (scope): scope is string => typeof scope === "string" && scope.trim().length > 0,
    );
    if (scopes.length) rules.push({ scopes, color, fontStyle });
  }
  return rules;
}

function normalizeFontStyle(value: string): string | undefined {
  if (!value || value === "none") return undefined;
  const allowed = new Set(["italic", "bold", "underline", "strikethrough"]);
  const parts = value.split(/\s+/).filter((part) => allowed.has(part));
  return parts.length ? parts.join(" ") : undefined;
}

function tokenStyles(rules: Rule[], semantic: unknown): TokenStyle[] {
  const semanticMap = plainRecord(semantic);
  const styles: TokenStyle[] = [];
  for (const probe of PROBES) {
    const matched = styleFor(rules, probe.scope);
    const over = semanticStyle(semanticMap, SEMANTIC[probe.role]);
    const color = over?.color ?? matched.color;
    const fontStyle = over?.fontStyle ?? matched.fontStyle;
    if (!color && !fontStyle) continue;
    styles.push({
      role: probe.role,
      ...(color ? { color: formatColor(color) } : {}),
      ...(fontStyle ? { fontStyle } : {}),
    });
  }
  return styles;
}

function styleFor(rules: Rule[], probe: string): { color?: Rgba; fontStyle?: string } {
  let score = 0;
  let color: Rgba | undefined;
  let fontStyle: string | undefined;
  for (const rule of rules) {
    if (rule.unscoped) continue;
    let best = 0;
    for (const scope of rule.scopes) best = Math.max(best, matchScore(scope, probe));
    if (best === 0 || best < score) continue;
    score = best;
    if (rule.color) color = rule.color;
    if (rule.fontStyle) fontStyle = rule.fontStyle;
  }
  return { color, fontStyle };
}

function matchScore(selector: string, probe: string): number {
  const last = selector.trim().split(/\s+/).pop();
  if (!last) return 0;
  if (probe === last || probe.startsWith(`${last}.`)) return last.split(".").length;
  return 0;
}

function semanticStyle(
  map: Record<string, unknown>,
  keys: string[] | undefined,
): { color?: Rgba; fontStyle?: string } | null {
  if (!keys) return null;
  for (const key of keys) {
    const value = map[key];
    if (typeof value === "string") {
      const color = parseColor(value);
      return color ? { color } : null;
    }
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    const color = typeof row.foreground === "string" ? parseColor(row.foreground) ?? undefined : undefined;
    const parts = [
      row.italic === true ? "italic" : "",
      row.bold === true ? "bold" : "",
      row.underline === true ? "underline" : "",
      typeof row.fontStyle === "string" ? normalizeFontStyle(row.fontStyle) ?? "" : "",
    ].filter(Boolean);
    const fontStyle = parts.length ? [...new Set(parts.join(" ").split(" "))].join(" ") : undefined;
    if (color || fontStyle) return { color, fontStyle };
  }
  return null;
}

function editorColors(colors: Map<string, Rgba>, background: Rgba, foreground: Rgba, kind: ThemeKind): EditorColors {
  const selection = colors.get("editor.selectionBackground") ?? { ...mix(foreground, background, 0.35), a: 0.38 };
  const line = colors.get("editor.lineHighlightBackground") ?? { ...foreground, a: kind === "light" ? 0.06 : 0.08 };
  const gutterBg = colors.get("editorGutter.background") ?? background;
  const gutterFg = colors.get("editorLineNumber.foreground") ?? mix(foreground, background, 0.45);
  const border = visibleBorder(colors.get("editorGutter.border") ?? colors.get("sideBar.border"), background, foreground);
  return {
    background: formatColor(background),
    foreground: formatColor(foreground),
    caret: formatColor(colors.get("editorCursor.foreground") ?? foreground),
    selection: formatColor(selection),
    selectionMatch: formatColor(colors.get("editor.selectionHighlightBackground") ?? { ...selection, a: Math.min(selection.a, 0.45) }),
    lineHighlight: formatColor(line),
    gutterBackground: formatColor(gutterBg),
    gutterForeground: formatColor(gutterFg),
    gutterActiveForeground: formatColor(colors.get("editorLineNumber.activeForeground") ?? foreground),
    gutterBorder: formatColor(border),
  };
}

function chromeVars(colors: Map<string, Rgba>, editor: EditorColors, kind: ThemeKind): Record<string, string> {
  const background = parseColor(editor.background)!;
  const foreground = parseColor(editor.foreground)!;
  const sidebar = colors.get("sideBar.background") ?? colors.get("activityBar.background") ?? background;
  const raised = colors.get("input.background") ?? colors.get("tab.inactiveBackground") ?? mix(foreground, background, kind === "light" ? 0.04 : 0.08);
  const muted = mix(foreground, background, 0.72);
  const faint = colors.get("editorLineNumber.foreground") ?? mix(foreground, background, 0.48);
  const line = visibleBorder(
    colors.get("sideBar.border") ?? colors.get("panel.border") ?? colors.get("editorGroup.border"),
    sidebar,
    foreground,
  );
  const lineStrong = mix(foreground, background, kind === "light" ? 0.18 : 0.24);
  const hover = colors.get("list.hoverBackground") ?? { ...foreground, a: kind === "light" ? 0.06 : 0.08 };
  const vars: Record<string, string> = {};
  pair(vars, "bg", background, background);
  pair(vars, "panel", background, background);
  pair(vars, "sidebar", sidebar, background);
  pair(vars, "raised", raised, background);
  pair(vars, "ink", foreground, background);
  pair(vars, "muted", muted, background);
  pair(vars, "faint", faint, background);
  vars.line = formatColor(line);
  vars["line-strong"] = formatColor(lineStrong);
  vars.hover = formatColor(hover);
  vars.scrollbar = formatColor({ ...faint, a: 0.45 });
  const ok = colors.get("terminal.ansiGreen") ?? colors.get("gitDecoration.addedResourceForeground");
  const danger = colors.get("terminal.ansiRed") ?? colors.get("gitDecoration.deletedResourceForeground");
  const warn = colors.get("terminal.ansiYellow") ?? colors.get("gitDecoration.modifiedResourceForeground");
  if (ok) pair(vars, "ok", ok, background);
  if (danger) pair(vars, "danger", danger, background);
  if (warn) pair(vars, "warn", warn, background);
  const accent = colors.get("button.background") ?? colors.get("focusBorder");
  if (accent && contrastRatio(accent, background) >= 1.4) {
    pair(vars, "accent", accent, background);
    const fg = contrastForeground(accent);
    vars["accent-fg"] = formatColor(fg);
    vars["accent-hover"] = formatColor(mix(accent, fg, 0.12));
    vars["accent-soft"] = formatColor({ ...accent, a: 0.16 });
    vars.wash = formatColor({ ...accent, a: 0.14 });
  }
  const terminalBg = colors.get("terminal.background") ?? colors.get("panel.background") ?? mix(background, { r: 0, g: 0, b: 0, a: 1 }, kind === "light" ? 0.03 : 0.18);
  const terminalFg = colors.get("terminal.foreground") ?? foreground;
  vars["ide-terminal-bg"] = formatColor(terminalBg);
  vars["ide-terminal-fg"] = formatColor(terminalFg);
  vars["ide-terminal-dim"] = formatColor(mix(terminalFg, terminalBg, 0.55));
  vars["ide-terminal-border"] = formatColor(visibleBorder(colors.get("panel.border"), terminalBg, terminalFg));
  vars["ide-terminal-in"] = formatColor(colors.get("terminal.ansiBlue") ?? parseColor("#7cc4ff")!);
  vars["ide-terminal-err"] = formatColor(colors.get("terminal.ansiRed") ?? parseColor("#ff8f87")!);
  vars["ide-terminal-info"] = formatColor(colors.get("terminal.ansiYellow") ?? parseColor("#e5c07b")!);
  vars["ide-diff-inserted"] = diffBackground(colors.get("diffEditor.insertedLineBackground") ?? colors.get("diffEditor.insertedTextBackground"), "rgba(46, 160, 67, 0.18)");
  vars["ide-diff-removed"] = diffBackground(colors.get("diffEditor.removedLineBackground") ?? colors.get("diffEditor.removedTextBackground"), "rgba(248, 81, 73, 0.16)");
  return vars;
}

function pair(vars: Record<string, string>, name: string, color: Rgba, over: Rgba): void {
  vars[name] = formatColor(color.a >= 0.999 ? color : compositeFlat(color, over));
  vars[`${name}-rgb`] = rgbTriplet(color, over);
}

function compositeFlat(color: Rgba, over: Rgba): Rgba {
  const a = color.a;
  return {
    r: color.r * a + over.r * (1 - a),
    g: color.g * a + over.g * (1 - a),
    b: color.b * a + over.b * (1 - a),
    a: 1,
  };
}

function visibleBorder(color: Rgba | undefined, against: Rgba, foreground: Rgba): Rgba {
  if (color && contrastRatio(color.a >= 0.999 ? color : compositeFlat(color, against), against) >= 1.15) return color;
  return { ...mix(foreground, against, 0.2), a: 1 };
}

function diffBackground(color: Rgba | undefined, fallback: string): string {
  if (!color) return fallback;
  if (color.a < 0.85) return formatColor(color);
  return formatColor({ ...color, a: 0.28 });
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, item] of Object.entries(value)) if (typeof item === "string") out[key] = item;
  return out;
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function uiThemeOf(value: string): UiTheme {
  return normalizeUiTheme(value);
}
