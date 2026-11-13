/**
 * Filesystem jail for workspace execution (docs/06).
 *
 * A repository-supplied docker binary must never become a host tool through
 * CWD/PATH lookup. hostExecutable only accepts absolute PATH entries that
 * sit *outside* ENSEMBLE_WORKSPACE_ROOT.
 */
import { existsSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { env } from "../config.js";
import { expandHome } from "./guard.js";

export class WorkspaceBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceBlockedError";
  }
}

export function isWithin(root: string, candidate: string, allowEqual = false): boolean {
  const normRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const norm = candidate.replace(/\\/g, "/");
  if (allowEqual && (norm === normRoot || norm === root)) return true;
  return norm.startsWith(`${normRoot}/`);
}

const executables = new Map<string, string>();
/** For tests that put a stand-in program on PATH after another one was found. */
export function forgetExecutablesForTests(): void {
  executables.clear();
}

export async function hostExecutable(name: string): Promise<string> {
  const cached = executables.get(name);
  if (cached) return cached;
  const filename = process.platform === "win32" && !name.endsWith(".exe") ? `${name}.exe` : name;
  const pathVar = process.env.PATH ?? process.env.Path ?? "";
  for (const directory of pathVar.split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    try {
      const candidate = await realpath(join(directory, filename));
      if (isWithin(expandHome(env.ENSEMBLE_WORKSPACE_ROOT), candidate, true)) continue;
      if (!(await lstat(candidate)).isFile()) continue;
      executables.set(name, candidate);
      return candidate;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR"].includes(String(error.code)))) {
        throw error;
      }
    }
  }
  throw new WorkspaceBlockedError(
    `${name} was not found on the trusted host PATH. Install it outside the workspace before running this task.`,
  );
}

/**
 * What an npm `.cmd` shim on Windows runs (npm's cmd-shim: `"%_prog%" "%dp0%\\node_modules\\…\\cli.js" %*`):
 * the script or program it points at, beside the shim. Null when the text is not such a shim. Exported for tests.
 */
export function npmShimTarget(text: string, shim: string): string | null {
  const found = /"%(?:~dp0|dp0%)\\?([^"%]+)"\s*%\*/i.exec(text);
  if (!found) return null;
  return resolve(dirname(shim), found[1]!.replace(/\\/g, "/"));
}

export type HostLaunch = { program: string; args: string[] };

/**
 * A program on the trusted PATH as a launch: `hostExecutable`, and on Windows an npm-installed command's
 * `.cmd` shim as Node and the script it runs (Gemini CLI, Qwen Code), since Windows cannot start a `.cmd`
 * without a shell. The Node beside the shim when there is one, as the shim itself prefers.
 */
export async function hostLaunch(name: string, platform: NodeJS.Platform = process.platform): Promise<HostLaunch> {
  try {
    return { program: await hostExecutable(name), args: [] };
  } catch (error) {
    if (platform !== "win32") throw error;
  }
  const pathVar = process.env.PATH ?? process.env.Path ?? "";
  for (const directory of pathVar.split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const shim = join(directory, `${name}.cmd`);
    if (!existsSync(shim) || isWithin(expandHome(env.ENSEMBLE_WORKSPACE_ROOT), shim, true)) continue;
    const target = npmShimTarget(await readFile(shim, "utf8").catch(() => ""), shim);
    if (!target || !existsSync(target) || isWithin(expandHome(env.ENSEMBLE_WORKSPACE_ROOT), target, true)) continue;
    if (/\.exe$/i.test(target)) return { program: target, args: [] };
    const besides = join(directory, "node.exe");
    const node = existsSync(besides) ? besides : await hostExecutable("node");
    return { program: node, args: [target] };
  }
  throw new WorkspaceBlockedError(`${name} was not found on the trusted host PATH. Install it outside the workspace before running this task.`);
}
