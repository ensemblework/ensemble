/**
 * Secrets a person saves on their own computer for its agent runs (docs/35 §8.7): an API key, a
 * GitHub token. The computer keeps each one encrypted with its own key (lib/secrets.ts). A secret with
 * allowed destinations (`allow`, origins) is used by reference only: a run may send it there through
 * `secret_http` or git (credentials/), and it is never put in any environment. Any other secret is
 * given to coding-agent runs as an environment variable (compatibility mode): every one to a run from
 * the Hub or the CLI unless the owner chose `named` (credentials/mode.ts), and only the ones it names
 * to a run with a secret scope (an Ensemble Node run, `secretScopeOf`). No model is ever given a value:
 * a node or an agent knows only the names, and every redaction hides the values (lib/redact.ts).
 * Ensemble on the web never stores one; a value typed on the web reaches the computer encrypted for its
 * key (credentials/seal.ts), or for an older computer over TLS through the server.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
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

export const MAX_ALLOWED_ORIGINS = 20;

/**
 * An allowed destination as it is kept: an exact origin. https, or http only on this computer's own
 * addresses; no user name, password, path, query or fragment.
 */
export function allowedOrigin(value: string): { origin: string } | { problem: string } {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { problem: `“${value.slice(0, 80)}” is not a web address. Give an origin such as https://api.stripe.com.` };
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return { problem: `${url.origin} is not https: a secret goes only over https (http only to this computer itself).` };
  if (url.username || url.password) return { problem: "An allowed destination cannot hold a user name or password." };
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) return { problem: `Give the origin only (${url.origin}), not a path.` };
  return { origin: url.origin };
}

/** The allowed destinations kept on a row: valid origins only. */
export function allowedOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const checked = allowedOrigin(item);
    if ("origin" in checked && !out.includes(checked.origin)) out.push(checked.origin);
  }
  return out.slice(0, MAX_ALLOWED_ORIGINS);
}

function checkedAllow(allow: readonly string[]): string[] {
  const out: string[] = [];
  for (const item of allow) {
    const checked = allowedOrigin(item);
    if ("problem" in checked) throw Object.assign(new Error(checked.problem), { statusCode: 400 });
    if (!out.includes(checked.origin)) out.push(checked.origin);
  }
  if (out.length > MAX_ALLOWED_ORIGINS) throw Object.assign(new Error(`A secret has at most ${MAX_ALLOWED_ORIGINS} allowed destinations.`), { statusCode: 400 });
  return out;
}

/**
 * Saves a secret. `allow` sets where it may be sent by reference (an empty list: nowhere, so it is an
 * environment secret); left out, a secret saved again keeps its destinations.
 */
export async function saveRunSecret(prisma: PrismaClient, userId: string, name: string, value: string, options: { allow?: readonly string[] } = {}): Promise<{ allow: string[] }> {
  const problem = secretNameProblem(name);
  if (problem) throw Object.assign(new Error(problem), { statusCode: 400 });
  if (!value || Buffer.byteLength(value) > MAX_SECRET_BYTES) throw Object.assign(new Error("A secret is 1 byte to 16 KB."), { statusCode: 400 });
  const allow = options.allow === undefined ? undefined : checkedAllow(options.allow);
  const existing = await prisma.runSecret.findUnique({ where: { userId_name: { userId, name } }, select: { id: true, allow: true } });
  if (!existing && (await prisma.runSecret.count({ where: { userId } })) >= MAX_SECRETS) throw Object.assign(new Error(`This computer keeps at most ${MAX_SECRETS} secrets.`), { statusCode: 409 });
  const kept = allow === undefined ? {} : { allow: allow.length ? allow : Prisma.DbNull };
  await prisma.runSecret.upsert({ where: { userId_name: { userId, name } }, create: { userId, name, value: encrypt(value), ...kept }, update: { value: encrypt(value), ...kept } });
  rememberSecretValues([value]);
  return { allow: allow ?? allowedOf(existing?.allow) };
}

/** Sets where a saved secret may be sent by reference (`ensemble secrets allow`); an empty list makes it an environment secret again. */
export async function setSecretAllow(prisma: PrismaClient, userId: string, name: string, allow: readonly string[]): Promise<string[]> {
  const checked = checkedAllow(allow);
  const done = await prisma.runSecret.updateMany({ where: { userId, name }, data: { allow: checked.length ? checked : Prisma.DbNull } });
  if (!done.count) throw Object.assign(new Error(`There is no secret called ${name} on this computer.`), { statusCode: 404 });
  return checked;
}

export async function removeRunSecret(prisma: PrismaClient, userId: string, name: string): Promise<boolean> {
  return (await prisma.runSecret.deleteMany({ where: { userId, name } })).count > 0;
}

/** Names and where each may be sent, newest change first: a value leaves the store only into a run's environment or a request by reference. */
export async function listRunSecrets(prisma: PrismaClient, userId: string): Promise<Array<{ name: string; updatedAt: string; allow: string[] }>> {
  const rows = await prisma.runSecret.findMany({ where: { userId }, orderBy: { updatedAt: "desc" }, select: { name: true, updatedAt: true, allow: true } });
  return rows.map((row) => ({ name: row.name, updatedAt: row.updatedAt.toISOString(), allow: allowedOf(row.allow) }));
}

/**
 * Which saved secrets a run gets: `all` (a run from the Hub or the CLI, as before scopes existed) or
 * exactly the names listed, possibly none (an Ensemble Node run: the names its step or mission names,
 * or that its node asked the owner for). Kept on the job's context as `secrets`.
 */
export type SecretScope = "all" | string[];

/** The secret scope on a job's context: a list of names, else `all` (no scope, or `"all"`). */
export function secretScopeOf(context: unknown): SecretScope {
  const value = typeof context === "object" && context !== null ? (context as { secrets?: unknown }).secrets : undefined;
  if (!Array.isArray(value)) return "all";
  return [...new Set(value.filter((name): name is string => typeof name === "string" && !secretNameProblem(name)))].slice(0, MAX_SECRETS);
}

type Saved = { value: string; allow: string[] };

/** Every saved secret this computer's key can open, by name, with where it may be sent. Their values are hidden by every redaction from now on. */
async function savedSecrets(prisma: PrismaClient, userId: string): Promise<Record<string, Saved>> {
  const rows = await prisma.runSecret.findMany({ where: { userId }, select: { name: true, value: true, allow: true } });
  const all: Record<string, Saved> = {};
  for (const row of rows) {
    if (secretNameProblem(row.name)) continue;
    try {
      all[row.name] = { value: decrypt(row.value), allow: allowedOf(row.allow) };
    } catch {
      // A value this computer's key cannot open (the key changed) is left out rather than failing the run.
    }
  }
  rememberSecretValues(Object.values(all).map((row) => row.value));
  return all;
}

/** A secret may be used under a scope: `all`, or named in it. */
export function inScope(scope: SecretScope, name: string): boolean {
  return scope === "all" || scope.includes(name);
}

/**
 * The environment a run on this computer gets: every environment secret for `all`, else only the names
 * in the scope. A secret with allowed destinations is used by reference only and never put in an
 * environment. Every saved value is remembered for redaction either way, so output never shows one.
 */
export async function runSecretEnv(prisma: PrismaClient, userId: string, scope: SecretScope = "all"): Promise<Record<string, string>> {
  const all = await savedSecrets(prisma, userId);
  return Object.fromEntries(Object.entries(all).filter(([name, row]) => !row.allow.length && inScope(scope, name)).map(([name, row]) => [name, row.value]));
}

/** The secrets a scope may use by reference: names and where each may go, never the values. */
export async function referenceSecrets(prisma: PrismaClient, userId: string, scope: SecretScope = "all"): Promise<Array<{ name: string; allow: string[] }>> {
  const all = await savedSecrets(prisma, userId);
  return Object.entries(all)
    .filter(([name, row]) => row.allow.length > 0 && inScope(scope, name))
    .map(([name, row]) => ({ name, allow: row.allow }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** One saved secret with its destinations, for a request by reference on this computer (credentials/). Null when it is not saved here. */
export async function savedSecret(prisma: PrismaClient, userId: string, name: string): Promise<Saved | null> {
  return (await savedSecrets(prisma, userId))[name] ?? null;
}

/** Every saved value (for checks such as "this file holds a saved secret"); never put into an environment. */
export async function savedSecretValues(prisma: PrismaClient, userId: string): Promise<string[]> {
  return Object.values(await savedSecrets(prisma, userId)).map((row) => row.value);
}

/** Remembers every saved value for redaction, at start-up: before the computer sends anything (runs that ended before a restart included). */
export async function rememberRunSecrets(prisma: PrismaClient, userId: string): Promise<void> {
  await savedSecrets(prisma, userId);
}

/**
 * The lines a run's agent is told: names only, and how to use them without showing them. Other names in
 * the environment (Ensemble's git settings) are not secrets and are left out.
 */
export function secretRules(names: readonly string[], references: ReadonlyArray<{ name: string; allow: readonly string[] }> = []): string[] {
  const own = names.filter((name) => !secretNameProblem(name));
  const lines: string[] = [];
  if (own.length) {
    lines.push(
      `- Secrets your person saved on this computer, in your environment: ${own.map((name) => `$${name}`).join(", ")}. Use them in commands and code by name (for example "Authorization: Bearer $${own[0]}"). Never print, echo, log or write a secret's value into a file, a commit or your replies.`,
    );
  }
  if (references.length) {
    lines.push(
      `- Secrets you use by reference, never in your environment: ${references.map((row) => `${row.name} (only to ${row.allow.join(", ")})`).join("; ")}. Call those addresses with the secret_http tool and put {{NAME}} where the value goes (for example the header "Authorization: Bearer {{${references[0]!.name}}}"); the answer comes back with the value hidden.${names.includes("GIT_CONFIG_COUNT") ? " Git over https to those hosts signs in with it by itself." : ""}`,
    );
  }
  return lines;
}

/** When a run needs a secret it does not have: ask for it by name, never for the value in a reply. */
export const MISSING_SECRET_RULE =
  "- A secret (API key, token, password) you need but don't have in your environment: never ask for its value. Stop and name the environment variable and what it's for; Ensemble asks the person for it privately and gives it to your next run.";
