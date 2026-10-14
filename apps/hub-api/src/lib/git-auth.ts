/**
 * Private GitHub clones and pushes. The token is placed only in the environment
 * of `runTrustedGit`, the app's own git process. It is never put in a sandboxed
 * command's environment, never written into the askpass script, and never put
 * in the remote URL.
 */
import { chmod, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PrismaClient } from "@prisma/client";
import { decrypt } from "./secrets.js";
import { askpassPath } from "../workspace/guard.js";
import { canUseHostCredentials, requireHostAccess } from "./hosted-access.js";
import { getAccount } from "../connectors/accounts.js";

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
  // Beside the agents' cache, never in it: a command that could rewrite this would run with the token.
  const path = await askpassPath();
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

/** The person's GitHub connection, when it can read code: an OAuth grant with repo scope, or a pasted token (its own permissions decide). */
async function connectorGithubToken(userId: string): Promise<string | null> {
  const account = await getAccount(userId, "github", false, false).catch(() => null);
  if (!account?.accessToken) return null;
  if (account.meta.via === "token" || account.scopes.some((scope) => scope === "repo" || scope === "public_repo")) return account.accessToken;
  return null;
}

export async function githubCloneAuth(
  prisma: PrismaClient,
  userId: string,
  remote: string,
): Promise<{ config: string[]; env: Record<string, string>; missing: boolean }> {
  await requireHostAccess(userId, "Repository cloning and host git credentials");
  if (!/github\.com/i.test(remote)) return { config: [], env: {}, missing: false };
  // The git token saved in Settings wins; otherwise the GitHub connector's own sign-in or pasted token.
  const token = (await githubToken(prisma, userId)) ?? (await connectorGithubToken(userId));
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

/**
 * A token for GitHub's API (opening a pull request): the git token saved in Settings, the GitHub
 * connection, or `gh auth token` on a computer whose owner signed in to the GitHub CLI.
 */
export async function githubApiToken(prisma: PrismaClient, userId: string): Promise<string | null> {
  const saved = (await githubToken(prisma, userId)) ?? (await connectorGithubToken(userId));
  if (saved) return saved;
  if (!(await canUseHostCredentials(userId))) return null;
  try {
    const { stdout } = await exec("gh", ["auth", "token"], { timeout: 4000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export const GITHUB_AUTH_HINT =
  "Git has no credentials for github.com. Connect GitHub in Settings → Connections, save a GitHub token in Settings, or run `gh auth setup-git`.";
