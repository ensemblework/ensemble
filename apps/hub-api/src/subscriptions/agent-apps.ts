/**
 * Agents' desktop apps, and where the programs Ensemble runs for them are (docs/30 §8).
 *
 * Two apps come without that program: the Cursor app (Cursor's agent installs apart from it) and
 * VS Code with GitHub Copilot (Copilot runs inside VS Code, and the `@github/copilot` package VS Code
 * bundles is Copilot's SDK: no `npm-loader.js`, no platform program to run). A computer reports the
 * ones it has (`appPresence`, capabilities `agentApps`); with the app and without the agent, Set up
 * installs the agent with the vendor's own installer (`signin.ts`).
 *
 * Programs are looked for where their installers put them too, since a runtime started by the
 * desktop app or a login service often lacks those folders on its PATH. Cursor's agent is never the
 * copy the Cursor app's Agents window keeps (`anysphere.cursor-agent-worker`): that one is the app's
 * own, signed in only with a key the app passes it on each launch.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentApp } from "@ensemble/shared-types";
import { env as config } from "../config.js";
import { expandHome } from "../workspace/guard.js";
import { hostExecutable, hostLaunch, isWithin, type HostLaunch } from "../workspace/policy.js";

/** The computer to look at: this one, or a stand-in under a temporary folder in tests. */
export type Where = {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  /** The file system's root, under which the system's own folders (`/Applications`, `/usr/share`, `/opt`) are. */
  root: string;
  /** A program on the trusted PATH (`hostExecutable`, its real path), or null. */
  onPath: (name: string) => Promise<string | null>;
};

const here = (where: Partial<Where>): Where => ({
  platform: process.platform,
  home: homedir(),
  env: process.env,
  root: "/",
  onPath: (name) => hostExecutable(name).catch(() => null),
  ...where,
});

const localAppData = (where: Where): string => where.env.LOCALAPPDATA ?? join(where.home, "AppData", "Local");

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** A program where an installer leaves it, never one inside the workspace (as on the trusted PATH, `hostExecutable`). */
const isProgram = (path: string): boolean => isFile(path) && !isWithin(expandHome(config.ENSEMBLE_WORKSPACE_ROOT), path, true);

/** The paths in a folder whose names match; none when it cannot be read. */
function named(folder: string, match: RegExp): string[] {
  try {
    return readdirSync(folder)
      .filter((name) => match.test(name))
      .map((name) => join(folder, name));
  } catch {
    return [];
  }
}

/** Where the Cursor app installs: the app bundle, `Cursor.exe`, or the folder or AppImage on Linux. */
export function cursorAppPaths(input: Partial<Where> = {}): string[] {
  const where = here(input);
  const { platform, home, root } = where;
  if (platform === "darwin") return [join(root, "Applications", "Cursor.app"), join(home, "Applications", "Cursor.app")];
  if (platform === "win32") {
    // The user installer, then the system one.
    return [join(localAppData(where), "Programs", "cursor", "Cursor.exe"), ...(where.env.ProgramFiles ? [join(where.env.ProgramFiles, "cursor", "Cursor.exe")] : [])];
  }
  // The .deb and .rpm packages install into /usr/share/cursor; an AppImage is wherever it was saved, ~/Applications by convention.
  const appImage = /^cursor.*\.appimage$/i;
  return [join(root, "usr", "share", "cursor"), join(root, "opt", "Cursor"), join(root, "opt", "cursor"), ...named(join(home, "Applications"), appImage), ...named(join(root, "opt"), appImage)];
}

/** Each VS Code install's `resources/app` folder, which holds its built-in extensions. */
export function vscodeAppFolders(input: Partial<Where> = {}): string[] {
  const where = here(input);
  const { platform, home, root } = where;
  if (platform === "darwin") {
    return ["Visual Studio Code", "Visual Studio Code - Insiders"]
      .flatMap((name) => [join(root, "Applications", `${name}.app`), join(home, "Applications", `${name}.app`)])
      .map((app) => join(app, "Contents", "Resources", "app"));
  }
  if (platform === "win32") {
    const installs = ["Microsoft VS Code", "Microsoft VS Code Insiders"].flatMap((name) => [join(localAppData(where), "Programs", name), ...(where.env.ProgramFiles ? [join(where.env.ProgramFiles, name)] : [])]);
    // From VS Code 1.109 the resources are in a folder named for the build's commit, beside Code.exe.
    return installs.flatMap((install) => [join(install, "resources", "app"), ...named(install, /^[0-9a-f]{6,40}$/i).map((build) => join(build, "resources", "app"))]);
  }
  return [
    // The .deb and .rpm packages, the snap, Arch's package, the tarball where it is usually unpacked, and Flathub's.
    join(root, "usr", "share", "code"),
    join(root, "usr", "share", "code-insiders"),
    join(root, "snap", "code", "current", "usr", "share", "code"),
    join(root, "opt", "visual-studio-code"),
    join(root, "opt", "VSCode-linux-x64"),
    join(home, "VSCode-linux-x64"),
    join(root, "var", "lib", "flatpak", "app", "com.visualstudio.code", "current", "active", "files", "extra", "vscode"),
    join(home, ".local", "share", "flatpak", "app", "com.visualstudio.code", "current", "active", "files", "extra", "vscode"),
  ].map((install) => join(install, "resources", "app"));
}

/** VS Code with GitHub Copilot: built in (`extensions/copilot`), or added to the person's extensions on an older VS Code. */
export function vscodeWithCopilot(input: Partial<Where> = {}): boolean {
  const where = here(input);
  const installs = vscodeAppFolders(where).filter((folder) => existsSync(folder));
  if (!installs.length) return false;
  if (installs.some((folder) => isFile(join(folder, "extensions", "copilot", "package.json")))) return true;
  return [".vscode", ".vscode-insiders"].some((folder) => named(join(where.home, folder, "extensions"), /^github\.copilot(-chat)?-\d/i).length > 0);
}

/** The agents' apps on this computer that come without the program Ensemble runs (capabilities `agentApps`). */
export function appPresence(input: Partial<Where> = {}): AgentApp[] {
  const where = here(input);
  const apps: AgentApp[] = [];
  if (cursorAppPaths(where).some((path) => existsSync(path))) apps.push("cursor-app");
  if (vscodeWithCopilot(where)) apps.push("vscode-copilot");
  return apps;
}

const WORKER_COPY = /anysphere\.cursor-agent-worker/i;

/** A program of Cursor's agent install (in a `cursor-agent` folder, or named so), never the Agents window's copy. */
export function isCursorAgent(path: string): boolean {
  return !WORKER_COPY.test(path) && path.split(/[\\/]/).some((part) => /^cursor-agent(\.exe)?$/i.test(part));
}

/**
 * Where the installer Set up runs leaves the agent's program: Cursor's in `~/.local/bin` (`%LOCALAPPDATA%\cursor-agent`
 * on Windows); GitHub's script in `~/.local/bin` for a person who is not root, WinGet in its `Links` folder on Windows.
 */
export function installedProgram(app: AgentApp, input: Partial<Where> = {}): string {
  const where = here(input);
  if (app === "cursor-app") return where.platform === "win32" ? join(localAppData(where), "cursor-agent", "cursor-agent.exe") : join(where.home, ".local", "bin", "cursor-agent");
  return where.platform === "win32" ? join(localAppData(where), "Microsoft", "WinGet", "Links", "copilot.exe") : join(where.home, ".local", "bin", "copilot");
}

/**
 * Cursor's agent: `cursor-agent` on the PATH, or `agent` (its newer name) when that is Cursor's; then
 * where Cursor's installer puts it (`~/.local/bin/cursor-agent`, `%LOCALAPPDATA%\cursor-agent` on Windows).
 */
export async function cursorAgentProgram(input: Partial<Where> = {}): Promise<string | null> {
  const where = here(input);
  const command = await where.onPath("cursor-agent");
  if (command && !WORKER_COPY.test(command)) return command;
  const short = await where.onPath("agent");
  if (short && isCursorAgent(short)) return short;
  const installed = installedProgram("cursor-app", where);
  return isProgram(installed) ? installed : null;
}

/**
 * Copilot CLI: `copilot` on the PATH, then where its installers put it: GitHub's script (`~/.local/bin`,
 * `/usr/local/bin` as root), Homebrew (`/opt/homebrew` on Apple silicon, `/usr/local` on Intel), WinGet.
 */
export async function copilotProgram(input: Partial<Where> = {}): Promise<string | null> {
  const where = here(input);
  const command = await where.onPath("copilot");
  if (command) return command;
  const { platform, root } = where;
  const candidates =
    platform === "win32"
      ? [installedProgram("vscode-copilot", where), ...named(join(localAppData(where), "Microsoft", "WinGet", "Packages"), /^GitHub\.Copilot(\.Prerelease)?_/i).map((folder) => join(folder, "copilot.exe"))]
      : [
          installedProgram("vscode-copilot", where),
          join(root, "usr", "local", "bin", "copilot"),
          platform === "darwin" ? join(root, "opt", "homebrew", "bin", "copilot") : join(root, "home", "linuxbrew", ".linuxbrew", "bin", "copilot"),
        ];
  return candidates.find(isProgram) ?? null;
}

/** The copy of OpenCode the OpenCode app runs itself (`opencode-cli` in the app's resources). */
export function opencodeAppCopy(input: Partial<Where> = {}): string | null {
  const where = here(input);
  const { platform, home, root } = where;
  const candidates =
    platform === "darwin"
      ? [join(root, "Applications", "OpenCode.app"), join(home, "Applications", "OpenCode.app")].map((app) => join(app, "Contents", "Resources", "opencode-cli"))
      : platform === "win32"
        ? [join(localAppData(where), "Programs", "OpenCode", "resources", "opencode-cli.exe")]
        : [join(root, "opt", "OpenCode", "resources", "opencode-cli")];
  return candidates.find(isProgram) ?? null;
}

/**
 * OpenCode: `opencode` on the PATH (an npm shim on Windows read as Node and its script), then where its
 * installer puts it (`~/.opencode/bin`, which the OpenCode app's own Install CLI uses too), then the app's copy.
 */
export async function opencodeProgram(
  input: Partial<Where> = {},
  launch: (name: string) => Promise<HostLaunch | null> = (name) => hostLaunch(name).catch(() => null),
): Promise<(HostLaunch & { via: "app" | "cli" }) | null> {
  const where = here(input);
  const command = await launch("opencode");
  if (command) return { ...command, via: "cli" };
  const installed = join(where.home, ".opencode", "bin", where.platform === "win32" ? "opencode.exe" : "opencode");
  if (isProgram(installed)) return { program: installed, args: [], via: "cli" };
  const app = opencodeAppCopy(where);
  return app ? { program: app, args: [], via: "app" } : null;
}
