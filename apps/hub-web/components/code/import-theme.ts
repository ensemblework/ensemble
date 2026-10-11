import { unzipSync } from "fflate";
import { convertExtensionThemes, convertTheme, parseJsonc, type IdeTheme, type VsThemeDocument } from "@ensemble/ide-theme";

/** Read color data only; extension scripts are never extracted or executed. */
export function importColorThemes(bytes: Uint8Array, filename: string, fingerprint: string): IdeTheme[] {
  if (bytes.byteLength > 12 * 1024 * 1024) throw new Error("Choose a theme package smaller than 12 MB.");
  const decode = new TextDecoder();
  if (/\.jsonc?$/i.test(filename)) {
    if (bytes.byteLength > 512 * 1024) throw new Error("Choose a color file smaller than 512 KB.");
    const document = parseJsonc(decode.decode(bytes)) as VsThemeDocument;
    if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("Choose a VS Code color theme JSON object.");
    if (document.include) throw new Error("This theme includes other files. Import its VSIX package instead.");
    const result = convertTheme({ id: `import:${fingerprint}`, label: document.name || filename.replace(/\.jsonc?$/i, ""), uiTheme: document.type === "light" ? "vs" : "vs-dark", document });
    if (!result.ok) throw new Error(result.reason);
    return [result.theme];
  }
  if (!/\.vsix$/i.test(filename)) throw new Error("Choose a VSIX package or a VS Code color theme JSON file.");
  let total = 0;
  const archive = unzipSync(bytes, { filter: (file) => {
    const safe = file.name.startsWith("extension/") && /\.json$/i.test(file.name) && !file.name.includes("..") && file.originalSize <= 512 * 1024;
    if (safe) total += file.originalSize;
    if (total > 2 * 1024 * 1024) throw new Error("This package contains too much theme data.");
    return safe;
  } });
  const files = new Map(Object.entries(archive).map(([name, data]) => [name.slice("extension/".length), decode.decode(data)]));
  const manifest = files.get("package.json");
  if (!manifest) throw new Error("This package has no theme manifest.");
  const converted = convertExtensionThemes({ namespace: "imported", name: "theme", version: "1", packageJson: parseJsonc(manifest), files });
  const themes = converted.themes.filter((entry) => entry.theme).slice(0, 8).map((entry, index) => ({ ...entry.theme!, id: `import:${fingerprint}:${index}` }));
  if (!themes.length) throw new Error(converted.note || converted.themes[0]?.reason || "No supported JSON color themes found.");
  return themes;
}
