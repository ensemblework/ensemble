/** Stable, framework-agnostic description of a code theme. Web and native apps map this themselves. */

export const UI_THEMES = ["vs", "vs-dark", "hc-black", "hc-light"] as const;
export type UiTheme = (typeof UI_THEMES)[number];

export type ThemeKind = "dark" | "light" | "hc";

export const TOKEN_ROLES = [
  "comment",
  "string",
  "number",
  "keyword",
  "controlKeyword",
  "operator",
  "function",
  "type",
  "className",
  "tag",
  "attribute",
  "variable",
  "property",
  "constant",
  "regexp",
  "punctuation",
  "invalid",
  "heading",
  "emphasis",
  "strong",
  "link",
  "inserted",
  "deleted",
] as const;
export type TokenRole = (typeof TOKEN_ROLES)[number];

export type TokenStyle = {
  role: TokenRole;
  color?: string;
  /** Space-separated: italic, bold, underline, strikethrough. */
  fontStyle?: string;
};

export type EditorColors = {
  background: string;
  foreground: string;
  caret: string;
  selection: string;
  selectionMatch: string;
  lineHighlight: string;
  gutterBackground: string;
  gutterForeground: string;
  gutterActiveForeground: string;
  gutterBorder: string;
};

/**
 * `editor` and `tokens` are null/empty for Ensemble Default, which means
 * "keep the app's colors and the editor's built-in One Dark palette".
 * `cssVars` keys have no leading `--`. Values are sanitized colors or `r g b` triplets.
 */
export type IdeTheme = {
  id: string;
  label: string;
  publisher?: string;
  uiTheme: UiTheme;
  kind: ThemeKind;
  cssVars: Record<string, string>;
  editor: EditorColors | null;
  tokens: TokenStyle[];
};

export type ThemeFavourite = {
  id: string;
  label: string;
  kind: ThemeKind;
  source: "builtin" | "openvsx";
};

export const ENSEMBLE_DEFAULT_ID = "builtin:ensemble-default";
export const MAX_FAVOURITES = 3;

export type VsThemeDocument = {
  name?: string;
  type?: string;
  include?: string;
  colors?: Record<string, unknown>;
  tokenColors?: unknown;
  semanticTokenColors?: unknown;
};

export function kindFromUiTheme(uiTheme: string): ThemeKind {
  if (uiTheme === "vs") return "light";
  if (uiTheme === "hc-black" || uiTheme === "hc-light") return "hc";
  return "dark";
}

export function normalizeUiTheme(value: string): UiTheme {
  if (value === "vs" || value === "vs-dark" || value === "hc-black" || value === "hc-light") return value;
  return "vs-dark";
}

const NS = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VER = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

export function openVsxThemeId(namespace: string, name: string, version: string, label: string): string {
  return `openvsx:${namespace}/${name}@${version}#${encodeURIComponent(label)}`;
}

export function parseOpenVsxThemeId(
  id: string,
): { namespace: string; name: string; version: string; label: string } | null {
  const match = /^openvsx:([^/]+)\/([^@]+)@([^#]+)#(.+)$/.exec(id);
  if (!match) return null;
  const namespace = match[1] ?? "";
  const name = match[2] ?? "";
  const version = match[3] ?? "";
  if (!NS.test(namespace) || !NS.test(name) || !VER.test(version)) return null;
  try {
    const label = decodeURIComponent(match[4] ?? "");
    if (!label || label.length > 80) return null;
    return { namespace, name, version, label };
  } catch {
    return null;
  }
}

export function themeSource(id: string): "builtin" | "openvsx" | null {
  if (id.startsWith("builtin:")) return "builtin";
  if (id.startsWith("openvsx:")) return "openvsx";
  return null;
}
