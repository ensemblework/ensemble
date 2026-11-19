import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const release = JSON.parse(readFileSync(join(root, "release.json"), "utf8"));
export const releaseVersion = release.version;
if (!/^\d+\.\d+\.\d+$/.test(releaseVersion)) throw new Error("release.json needs a stable major.minor.patch version.");
// `desktop` names the last desktop release while a release publishes only the CLI, so downloads keep pointing at installers that exist.
export const desktopVersion = release.desktop ?? releaseVersion;
const numbers = version => version.split(".").map(Number);
const after = (a, b) => { const [x, y] = [numbers(a), numbers(b)]; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
if (!/^\d+\.\d+\.\d+$/.test(desktopVersion) || after(desktopVersion, releaseVersion)) throw new Error("release.json's desktop version must be a major.minor.patch release no newer than version.");
const changes = [];
const change = (path, update) => {
  const file = join(root, path);
  if (!existsSync(file)) return;
  const current = readFileSync(file, "utf8").replace(/\r\n/g, "\n"), next = update(current);
  if (next !== current) changes.push({ path, next });
};
const jsonVersion = path => change(path, current => { const data = JSON.parse(current); data.version = releaseVersion; return `${JSON.stringify(data, null, 2)}\n`; });
jsonVersion("package.json");
for (const group of ["apps", "packages"]) for (const name of readdirSync(join(root, group))) jsonVersion(`${group}/${name}/package.json`);
for (const app of ["desktop", "quick-capture"]) {
  jsonVersion(`apps/${app}/src-tauri/tauri.conf.json`);
  const cargo = `apps/${app}/src-tauri/Cargo.toml`;
  const packageName = /^name = "([^"]+)"/m.exec(readFileSync(join(root, cargo), "utf8"))[1];
  change(cargo, current => current.replace(/^version = "[^"]+"/m, `version = "${releaseVersion}"`));
  change(`apps/${app}/src-tauri/Cargo.lock`, current => current.replace(new RegExp(`(\\[\\[package\\]\\]\\nname = "${packageName}"\\nversion = ")[^"]+"`), `$1${releaseVersion}"`));
}
change("apps/agent-runtime/pyproject.toml", current => current.replace(/^version = "[^"]+"/m, `version = "${releaseVersion}"`));
const sharedPath = "packages/shared-types/src/version.ts";
const generated = `/** Generated from release.json. Every surface uses this release number. */\nexport const ENSEMBLE_VERSION = "${releaseVersion}";\n/** The desktop release the download page offers (release.json's \`desktop\`, else the same number). */\nexport const DESKTOP_VERSION = "${desktopVersion}";\n`;
if (!existsSync(join(root, sharedPath)) || readFileSync(join(root, sharedPath), "utf8").replace(/\r\n/g, "\n") !== generated) changes.push({ path: sharedPath, next: generated });
const pythonVersionPath = "apps/agent-runtime/ensemble_agent/version.py";
const pythonVersion = `"""Generated from release.json."""\n__version__ = "${releaseVersion}"\n`;
if (!existsSync(join(root, pythonVersionPath)) || readFileSync(join(root, pythonVersionPath), "utf8").replace(/\r\n/g, "\n") !== pythonVersion) changes.push({ path: pythonVersionPath, next: pythonVersion });
export function checkReleaseVersion() {
  if (changes.length) throw new Error(`Release versions need synchronizing: ${changes.map(item => item.path).join(", ")}. Run pnpm version:sync.`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--sync")) for (const { path, next } of changes) writeFileSync(join(root, path), next);
  else checkReleaseVersion();
  process.stdout.write(`Ensemble ${releaseVersion}${process.argv.includes("--sync") ? `: synchronized ${changes.length} files` : ": versions match"}\n`);
}
