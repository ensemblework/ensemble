import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseJsonc } from "../src/jsonc.js";

const jobs: Array<[string, string]> = [
  ["/tmp/theme-staging/raw/zhuangtongfa.material-theme--OneDark-Pro.json", "one-dark-pro.json"],
  ["/tmp/theme-staging/raw/Catppuccin.catppuccin-vsc--mocha.json", "catppuccin-mocha.json"],
  ["/tmp/theme-staging/raw/dracula-theme.theme-dracula--dracula.json", "dracula.json"],
  ["/tmp/theme-staging/raw/GitHub.github-vscode-theme--dark-default.json", "github-dark.json"],
  ["/tmp/theme-staging/raw/GitHub.github-vscode-theme--light-default.json", "github-light.json"],
  ["/tmp/theme-staging/raw/teabyii.ayu--ayu-dark.json", "ayu-dark.json"],
  ["/tmp/theme-staging/raw/enkia.tokyo-night--tokyo-night-color-theme.json", "tokyo-night.json"],
  ["/tmp/theme-staging/raw/sdras.night-owl--Night Owl-color-theme.json", "night-owl.json"],
  ["/tmp/theme-staging/raw/arcticicestudio.nord-visual-studio-code--nord-color-theme.json", "nord.json"],
  ["/tmp/theme-staging/raw/vscode.theme-monokai--monokai-color-theme.json", "monokai.json"],
  ["/tmp/theme-staging/raw/vscode.theme-solarized-dark--solarized-dark-color-theme.json", "solarized-dark.json"],
];

const outDir = resolve(import.meta.dirname, "../themes");
mkdirSync(outDir, { recursive: true });
for (const [from, name] of jobs) {
  const document = parseJsonc(readFileSync(from, "utf8"));
  const target = resolve(outDir, name);
  writeFileSync(target, JSON.stringify(document));
  console.log(name, JSON.stringify(document).length);
}
