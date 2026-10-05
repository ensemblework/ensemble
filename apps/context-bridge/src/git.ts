import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitLocation {
  repo?: string;
  branch?: string;
}

/** owner/repo from a git remote URL. Returns undefined when it is not a GitHub-style name. */
export function repoFromRemote(raw: string): string | undefined {
  const value = raw.trim().replace(/\.git$/, "");
  const match = value.match(/github\.com[/:]([\w.-]+)\/([\w.-]+)/i) ?? value.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!match) return undefined;
  return `${match[1]}/${match[2]}`;
}

/** Best-effort repo and branch from cwd. Failure is an empty result, never a throw. */
export async function detectGit(cwd = process.cwd()): Promise<GitLocation> {
  try {
    const branchOut = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 2000 });
    const branch = branchOut.stdout.trim();
    let repo: string | undefined;
    try {
      const remote = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd, timeout: 2000 });
      repo = repoFromRemote(remote.stdout);
    } catch {
      repo = undefined;
    }
    return {
      repo,
      branch: branch && branch !== "HEAD" ? branch : undefined,
    };
  } catch {
    return {};
  }
}
