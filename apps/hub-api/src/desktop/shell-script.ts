import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

/** The desktop shell's init script, taken from the Rust source so tests and the app cannot drift. */
export function desktopInitScript(apiBase: string, token: string): string {
  const source = readFileSync(join(repoRoot, "apps/desktop/src-tauri/src/site.rs"), "utf8");
  const body = /pub fn desktop_init_script[\s\S]*?r##"([\s\S]*?)"##/.exec(source)?.[1];
  if (!body) throw new Error("desktop_init_script not found in site.rs");
  return body
    .replace(/\{\{/g, "\u0000")
    .replace(/\}\}/g, "\u0001")
    .replace("{api}", JSON.stringify(apiBase))
    .replace("{token}", JSON.stringify(token))
    .replace(/\u0000/g, "{")
    .replace(/\u0001/g, "}");
}
