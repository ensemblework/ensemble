/**
 * Git signs in with a saved secret by reference (B12, docs/35 §8.7): a run that names a secret whose
 * allowed destinations include a git host (https://github.com) gets git settings in its environment
 * (`GIT_CONFIG_COUNT`/`KEY`/`VALUE`, the same as `git -c` on every git it runs) that make Ensemble's
 * credential helper the only one for those hosts. When git needs a password for one of them, the
 * helper asks this computer's Ensemble over loopback with a token made for this run, and Ensemble
 * answers only while the run goes on, only for a host the secret allows, and only for a secret the run
 * may use. The token is in no file, prompt or log, and each use is in the ledger.
 *
 * This keeps the token out of the run's environment, files and model context; it is not isolation
 * from the agent itself: a command the agent runs can ask the helper as git does and read the answer.
 * `secret_http` is the isolated path; git over https needs the token in git's hands.
 */
import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { appendLedger } from "../lib/ledger.js";
import { inScope, referenceSecrets, savedSecret, type SecretScope } from "../lib/run-secrets.js";

type GitRun = { jobId: string; userId: string; scope: SecretScope; madeAt: number };

const runs = new Map<string, GitRun>();
const MAX_RUNS = 500;
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "interrupted", "blocked"]);

/** The helper git runs (`!` is a shell snippet; git adds the action, get, store or erase). Only `get` asks; nothing is ever stored. */
export function gitHelperCommand(engineUrl: string, token: string): string {
  return `!f() { test "$1" = get || exit 0; curl -sf --max-time 20 -H 'content-type: text/plain' -H 'x-ensemble-git: ${token}' --data-binary @- '${engineUrl}/api/engine/git-credential'; }; f`;
}

/** The hosts git may sign in to with a secret: the https origins (http only on this computer) its owner allowed. */
function gitOrigins(allow: readonly string[]): string[] {
  return allow.filter((origin) => origin.startsWith("https://") || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin));
}

/**
 * The git settings for a run's environment, or none when it may use no secret allowed for a git host.
 * Each host's helper list is emptied first, so git asks no other helper there and stores nothing.
 */
export async function gitCredentialEnv(prisma: Pick<PrismaClient, "runSecret">, run: { jobId: string; userId: string }, scope: SecretScope, engineUrl: string): Promise<Record<string, string>> {
  // Only the secrets the run names: a run that names none (compatibility mode's `all`) gets no git sign-in from them.
  if (scope === "all") return {};
  const references = await referenceSecrets(prisma as PrismaClient, run.userId, scope);
  const origins = [...new Set(references.flatMap((row) => gitOrigins(row.allow)))].sort();
  if (!origins.length) return {};
  if (runs.size >= MAX_RUNS) {
    const oldest = [...runs.entries()].sort((a, b) => a[1].madeAt - b[1].madeAt)[0];
    if (oldest) runs.delete(oldest[0]);
  }
  const token = randomBytes(24).toString("base64url");
  runs.set(token, { jobId: run.jobId, userId: run.userId, scope, madeAt: Date.now() });
  const entries: Array<[string, string]> = origins.flatMap((origin): Array<[string, string]> => [
    [`credential.${origin}.helper`, ""],
    [`credential.${origin}.helper`, gitHelperCommand(engineUrl, token)],
    [`credential.${origin}.useHttpPath`, "false"],
  ]);
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

/** git's credential request: `key=value` lines. */
export function parseGitRequest(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/).slice(0, 50)) {
    const at = line.indexOf("=");
    if (at > 0) out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

/**
 * The helper's answer, in git's format, or "" (git then has no password from it). `jobStatus` reads the
 * run's job: a token stops working when its run ends.
 */
export async function gitCredentialAnswer(prisma: Pick<PrismaClient, "runSecret">, token: string | undefined, request: string, jobStatus: (jobId: string) => Promise<string | null>): Promise<string> {
  const run = token ? runs.get(token) : undefined;
  if (!run || !token) return "";
  const status = await jobStatus(run.jobId);
  if (!status || TERMINAL.has(status)) {
    runs.delete(token);
    return "";
  }
  const asked = parseGitRequest(request);
  const protocol = asked.protocol;
  const host = asked.host;
  if ((protocol !== "https" && protocol !== "http") || !host || !/^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9a-fA-F:]+\](:\d{1,5})?$/.test(host)) return "";
  const origin = `${protocol}://${host.toLowerCase()}`;
  const references = await referenceSecrets(prisma as PrismaClient, run.userId, run.scope);
  const match = references.find((row) => gitOrigins(row.allow).includes(origin) && inScope(run.scope, row.name));
  if (!match) return "";
  const saved = await savedSecret(prisma as PrismaClient, run.userId, match.name);
  if (!saved || /[\r\n]/.test(saved.value)) return "";
  await appendLedger({ userId: run.userId, actor: "agent", action: "secret.use", payload: { name: match.name, origin, via: "git", jobId: run.jobId } }).catch(() => undefined);
  const username = asked.username && /^[^\r\n=]{1,200}$/.test(asked.username) ? asked.username : "x-access-token";
  return `username=${username}\npassword=${saved.value}\n`;
}

/** Tests: forget every run's token. */
export function forgetGitRunsForTests(): void {
  runs.clear();
}
