import { convertTheme, resolveThemeDocument } from "./convert.js";
import { kindFromUiTheme, normalizeUiTheme, openVsxThemeId, type IdeTheme, type ThemeKind, type UiTheme } from "./types.js";

export type PackageThemeInfo = {
  id: string;
  label: string;
  uiTheme: UiTheme;
  kind: ThemeKind;
  supported: boolean;
  reason?: string;
  path?: string;
};

export type ConvertedExtensionTheme = PackageThemeInfo & { theme?: IdeTheme };

export type ThemeDirectoryExtension = {
  namespace: string;
  name: string;
  version: string;
  displayName: string;
  publisher: string;
  description: string;
  downloadCount: number;
  themes: PackageThemeInfo[];
  note?: string;
};

const ICON_REASON = "This changes file icons, not colors, so it can't be applied to the code space.";
const PRODUCT_ICON_REASON = "This changes the editor's product icons, not colors.";
const CODE_REASON = "This theme is created by the extension while it runs. Ensemble can only apply theme files that ship as JSON.";
const EMPTY_REASON = "This extension doesn't include a color theme.";

/** Read `contributes.themes` without opening the theme files. Icon themes are reported as unsupported. */
export function listPackageThemes(
  packageJson: unknown,
  ids: { namespace: string; name: string; version: string },
): { themes: PackageThemeInfo[]; note?: string } {
  const root = asRecord(packageJson);
  const contributes = asRecord(root?.contributes);
  const colorThemes = Array.isArray(contributes?.themes) ? contributes.themes : [];
  const iconCount = Array.isArray(contributes?.iconThemes) ? contributes.iconThemes.length : 0;
  const productCount = Array.isArray(contributes?.productIconThemes) ? contributes.productIconThemes.length : 0;
  const themes: PackageThemeInfo[] = [];
  for (const entry of colorThemes) {
    const row = asRecord(entry);
    if (!row) continue;
    const label = typeof row.label === "string" && row.label.trim() ? row.label.trim().slice(0, 80) : "Untitled theme";
    const uiTheme = normalizeUiTheme(typeof row.uiTheme === "string" ? row.uiTheme : "vs-dark");
    const path = typeof row.path === "string" ? row.path : "";
    const base = {
      id: openVsxThemeId(ids.namespace, ids.name, ids.version, label),
      label,
      uiTheme,
      kind: kindFromUiTheme(uiTheme),
    };
    if (!path.endsWith(".json") || path.includes("..") || path.startsWith("/") || /^[a-z]+:/i.test(path)) {
      themes.push({ ...base, supported: false, reason: path ? CODE_REASON : "This theme has no color file." });
      continue;
    }
    themes.push({ ...base, supported: true, path: normalizePath(path) });
  }
  if (themes.length) return { themes };
  if (iconCount || productCount) {
    const reason = iconCount && productCount ? `${ICON_REASON} ${PRODUCT_ICON_REASON}` : iconCount ? ICON_REASON : PRODUCT_ICON_REASON;
    return { themes: [], note: reason };
  }
  return { themes: [], note: EMPTY_REASON };
}

/** Convert every JSON color theme in an already-unpacked extension. Theme files are data, never code. */
export function convertExtensionThemes(input: {
  namespace: string;
  name: string;
  version: string;
  publisher?: string;
  packageJson: unknown;
  files: ReadonlyMap<string, string>;
}): { themes: ConvertedExtensionTheme[]; note?: string } {
  const listed = listPackageThemes(input.packageJson, input);
  const themes: ConvertedExtensionTheme[] = listed.themes.map((info) => {
    if (!info.supported || !info.path) return info;
    const resolved = resolveThemeDocument(info.path, (file) => input.files.get(file) ?? null);
    if (!resolved.ok) return { ...info, supported: false, reason: resolved.reason };
    const converted = convertTheme({
      id: info.id,
      label: info.label,
      publisher: input.publisher,
      uiTheme: info.uiTheme,
      document: resolved.document,
    });
    if (!converted.ok) return { ...info, supported: false, reason: converted.reason };
    return { ...info, theme: converted.theme };
  });
  return { themes, note: listed.note };
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
