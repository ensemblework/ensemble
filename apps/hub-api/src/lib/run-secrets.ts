/**
 * Secrets a person saves on their own computer for its agent runs (docs/35 §8.7): an API key, a
 * GitHub token. The computer keeps each one encrypted with its own key (lib/secrets.ts) and gives them
 * to every coding-agent run there as environment variables. No model is ever given a value: a node or
 * an agent knows only the names, and every redaction hides the values (lib/redact.ts). Ensemble on the
 * web never stores one; a value saved from the web only passes through to the computer.
 */
import type { PrismaClient } from "@prisma/client";
import { rememberSecretValues } from "./redact.js";
import { decrypt, encrypt } from "./secrets.js";

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
export const MAX_SECRET_BYTES = 16 * 1024;
export const MAX_SECRETS = 100;

/** Names that would change how the computer, Ensemble or a coding agent itself runs or signs in. */
const RESERVED = [
  /^(PATH|HOME|USER|LOGNAME|SHELL|PWD|TMPDIR|TEMP|TMP|LANG|TERM|DISPLAY|EDITOR|VISUAL|PAGER|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|GIT_ASKPASS|SSH_AUTH_SOCK|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|ALL_PROXY)$/,
  /^(LD_|DYLD_|ENSEMBLE_|GIT_|XDG_|npm_config_)/,
  /^(ANTHROPIC_|CLAUDE_|OPENAI_|CODEX_|COPILOT_|CURSOR_|GEMINI_|GOOGLE_API_KEY$|GOOGLE_GENAI_|XAI_|GROK_|OPENCODE_|ANTIGRAVITY_)/,
  /^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|GH_HOST)$/,
];

/** Why a name cannot hold a secret, or null. */
export function secretNameProblem(name: string): string | null {
  if (!SECRET_NAME.test(name)) return "Use an environment variable name: capital letters, digits and underscores, starting with a letter (for example STRIPE_API_KEY).";
  if (RESERVED.some((pattern) => pattern.test(name))) {
    return `${name} would change how the computer or your coding agent runs or signs in. Save it under another name (for example ${name.replace(/^(GH|GITHUB)_TOKEN$/, "GITHUB_PAT").replace(/^([A-Z]+)_/, "MY_$1_")}).`;
  }
  return null;
}

export async function saveRunSecret(prisma: PrismaClient, userId: string, name: string, value: string): Promise<void> {
  const problem = secretNameProblem(name);
  if (problem) throw Object.assign(new Error(problem), { statusCode: 400 });
  if (!value || Buffer.byteLength(value) > MAX_SECRET_BYTES) throw Object.assign(new Error("A secret is 1 byte to 16 KB."), { statusCode: 400 });
  const existing = await prisma.runSecret.findUnique({ where: { userId_name: { userId, name } }, select: { id: true } });
  if (!existing && (await prisma.runSecret.count({ where: { userId } })) >= MAX_SECRETS) throw Object.assign(new Error(`This computer keeps at most ${MAX_SECRETS} secrets.`), { statusCode: 409 });
  await prisma.runSecret.upsert({ where: { userId_name: { userId, name } }, create: { userId, name, value: encrypt(value) }, update: { value: encrypt(value) } });
  rememberSecretValues([value]);
}

export async function removeRunSecret(prisma: PrismaClient, userId: string, name: string): Promise<boolean> {
  return (await prisma.runSecret.deleteMany({ where: { userId, name } })).count > 0;
}

/** Names only, newest change first: the values never leave the store except into a run's environment. */
export async function listRunSecrets(prisma: PrismaClient, userId: string): Promise<Array<{ name: string; updatedAt: string }>> {
  const rows = await prisma.runSecret.findMany({ where: { userId }, orderBy: { updatedAt: "desc" }, select: { name: true, updatedAt: true } });
  return rows.map((row) => ({ name: row.name, updatedAt: row.updatedAt.toISOString() }));
}

/** The environment a run on this computer gets: every saved secret. Their values are hidden by every redaction from now on. */
export async function runSecretEnv(prisma: PrismaClient, userId: string): Promise<Record<string, string>> {
  const rows = await prisma.runSecret.findMany({ where: { userId }, select: { name: true, value: true } });
  const env: Record<string, string> = {};
  for (const row of rows) {
    if (secretNameProblem(row.name)) continue;
    try {
      env[row.name] = decrypt(row.value);
    } catch {
      // A value this computer's key cannot open (the key changed) is left out rather than failing the run.
    }
  }
  rememberSecretValues(Object.values(env));
  return env;
}

/** Remembers every saved value for redaction, at start-up: before the computer sends anything (runs that ended before a restart included). */
export async function rememberRunSecrets(prisma: PrismaClient, userId: string): Promise<void> {
  await runSecretEnv(prisma, userId);
}

/** The lines a run's agent is told: names only, and how to use them without showing them. */
export function secretRules(names: readonly string[]): string[] {
  if (!names.length) return [];
  return [
    `- Secrets your person saved on this computer, in your environment: ${names.map((name) => `$${name}`).join(", ")}. Use them in commands and code by name (for example "Authorization: Bearer $${names[0]}"). Never print, echo, log or write a secret's value into a file, a commit or your replies.`,
  ];
}

/** When a run needs a secret it does not have: ask for it by name, never for the value in a reply. */
export const MISSING_SECRET_RULE =
  "- A secret (API key, token, password) you need but don't have in your environment: never ask for its value. Stop and name the environment variable and what it's for; Ensemble asks the person for it privately and gives it to your next run.";
