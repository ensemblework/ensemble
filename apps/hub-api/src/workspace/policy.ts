/**
 * Filesystem jail for workspace execution (docs/06).
 *
 * A repository-supplied docker binary must never become a host tool through
 * CWD/PATH lookup. hostExecutable only accepts absolute PATH entries that
 * sit *outside* ENSEMBLE_WORKSPACE_ROOT.
 */
import { lstat, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
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
