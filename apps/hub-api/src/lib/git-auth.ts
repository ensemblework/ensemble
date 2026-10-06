/**
 * Private GitHub clones and pushes. The token is placed only in the environment
 * of `runTrustedGit`, the app's own git process. It is never put in a sandboxed
 * command's environment, never written into the askpass script, and never put
 * in the remote URL.
 */
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PrismaClient } from "@prisma/client";
import { decrypt } from "./secrets.js";
import { cacheDir } from "../workspace/guard.js";
import { canUseHostCredentials, requireHostAccess } from "./hosted-access.js";

const exec = promisify(execFile);
export const GITHUB_GIT_PROVIDER = "github_git";

export async function githubToken(prisma: PrismaClient, userId: string): Promise<string | null> {
  const row = await prisma.modelCredential.findUnique({ where: { userId_provider: { userId, provider: GITHUB_GIT_PROVIDER } } });
  if (!row?.secret) return null;
  try {
    const plain = decrypt(row.secret).trim();
    return plain || null;
  } catch {
    return null;
  }
}

async function askpassScript(): Promise<string> {
  const dir = await cacheDir();
  await mkdir(dir, { recursive: true });
  const path = join(dir, "git-askpass.sh");
  const body = `#!/bin/sh
case "$1" in
  *Username*|*username*) printf '%s\\n' "x-access-token" ;;
  *) printf '%s\\n' "$ENSEMBLE_GIT_TOKEN" ;;
esac
`;
  await writeFile(path, body, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

async function ghReady(): Promise<boolean> {
  try {
    await exec("gh", ["auth", "status"], { timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

export async function githubCloneAuth(
  prisma: PrismaClient,
  userId: string,
  remote: string,
): Promise<{ config: string[]; env: Record<string, string>; missing: boolean }> {
  await requireHostAccess(userId, "Repository cloning and host git credentials");
  if (!/github\.com/i.test(remote)) return { config: [], env: {}, missing: false };
  const token = await githubToken(prisma, userId);
  if (token) {
    const script = await askpassScript();
    return {
      config: ["-c", "credential.helper="],
      env: { GIT_ASKPASS: script, SSH_ASKPASS: script, ENSEMBLE_GIT_TOKEN: token, GIT_TERMINAL_PROMPT: "0" },
      missing: false,
    };
  }
  if (await canUseHostCredentials(userId) && await ghReady()) {
    return {
      config: ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"],
      env: { GIT_TERMINAL_PROMPT: "0" },
      missing: false,
    };
  }
  return { config: [], env: { GIT_TERMINAL_PROMPT: "0" }, missing: true };
}

export const GITHUB_AUTH_HINT =
  "Git has no credentials for github.com. Save a GitHub token in Settings, or run `gh auth setup-git`.";
