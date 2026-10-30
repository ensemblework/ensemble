/**
 * `ensemble browser` (docs/26, docs/35 §8.16): the logins saved on this computer for Ensemble's
 * browser to fill when a site asks its owner to sign in. Sites and user names come out, never a
 * password or a one-time-code seed; values only go in, read without showing them.
 */
import { createInterface } from "node:readline/promises";
import { readSecret } from "./secret.js";
import { localJson, type Discovery } from "./sidecar.js";

export type SavedLogin = { origin: string; username: string; totp: boolean; createdAt: string; usedAt: string | null };

export type BrowserCommand = { subcommand: "logins" } | { subcommand: "save-login"; origin: string; totp: boolean } | { subcommand: "forget-login"; origin: string };

export function parseBrowserArgs(args: string[], command = "ensemble"): BrowserCommand | { error: string } {
  const [first = "logins", ...rest] = args;
  if (first === "logins") return rest.length === 0 || (rest.length === 1 && rest[0] === "list") ? { subcommand: "logins" } : { error: `Usage: ${command} browser logins [list]` };
  if (first === "save-login") {
    const totp = rest.includes("--totp");
    const sites = rest.filter((arg) => arg !== "--totp");
    if (sites.length !== 1 || sites[0]!.startsWith("-")) return { error: `Usage: ${command} browser save-login <site> [--totp]` };
    return { subcommand: "save-login", origin: sites[0]!, totp };
  }
  if (first === "forget-login") {
    if (rest.length !== 1 || rest[0]!.startsWith("-")) return { error: `Usage: ${command} browser forget-login <site>` };
    return { subcommand: "forget-login", origin: rest[0]! };
  }
  return { error: `Usage: ${command} browser logins [list] | save-login <site> [--totp] | forget-login <site>` };
}

export async function listLogins(discovery: Discovery): Promise<SavedLogin[]> {
  return (await localJson<{ logins?: SavedLogin[] }>(discovery, "/api/browser/logins")).logins ?? [];
}

export async function saveLogin(discovery: Discovery, login: { origin: string; username: string; password: string; totp?: string }): Promise<SavedLogin> {
  return (await localJson<{ login: SavedLogin }>(discovery, "/api/browser/logins", { method: "PUT", body: JSON.stringify(login) })).login;
}

export async function forgetLogin(discovery: Discovery, origin: string): Promise<{ forgotten: boolean; origin: string }> {
  return localJson(discovery, `/api/browser/logins?origin=${encodeURIComponent(origin)}`, { method: "DELETE" });
}

/** One line per saved login: the site, the user name, a one-time-code seed or not, when it was saved and last used. */
export function formatLogins(rows: SavedLogin[], command = "ensemble"): string {
  if (!rows.length) return `No logins saved on this computer. Save one with \`${command} browser save-login <site>\`; Ensemble's browser fills it when a site asks you to sign in and you pick "Use saved login".`;
  const width = Math.max(...rows.map((row) => row.origin.length));
  return rows.map((row) => `${row.origin.padEnd(width)}  ${row.username}${row.totp ? "  + one-time codes" : ""}  saved ${row.createdAt.slice(0, 10)}${row.usedAt ? `, used ${row.usedAt.slice(0, 10)}` : ""}`).join("\n");
}

/**
 * What a new login is, read here: the user name shown as typed, the password and seed not shown. From a
 * pipe: the user name, the password and (with `--totp`) the seed, one per line.
 */
export async function readLoginInput(origin: string, totp: boolean, input: NodeJS.ReadStream = process.stdin): Promise<{ username: string; password: string; totp?: string }> {
  if (!input.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of input) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const [username = "", password = "", seed = ""] = Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
    return { username: username.trim(), password, ...(totp && seed.trim() ? { totp: seed.trim() } : {}) };
  }
  const rl = createInterface({ input, output: process.stderr });
  let username: string;
  try {
    username = (await rl.question(`User name or email for ${origin}: `)).trim();
  } finally {
    rl.close();
  }
  const password = await readSecret("Password (not shown): ");
  const seed = totp ? await readSecret("One-time-code seed, the text beside the site's QR code (not shown): ") : "";
  return { username, password, ...(seed.trim() ? { totp: seed.trim() } : {}) };
}
