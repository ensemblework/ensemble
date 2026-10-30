/**
 * Saved logins on this computer (B11, docs/35 §8.16): a username and password, and an optional
 * one-time-code seed, per site, that the browser broker fills into a sign-in page itself when the owner
 * picks "Use saved login". They are kept apart from run secrets, in `logins.json` in Ensemble's data
 * folder (mode 0600), every value encrypted with the runtime's local key (lib/secrets.ts, `secret.key`
 * beside it), as `seal-key.json` is. No run, agent or node command can read the file (docs/24 §3,
 * workspace/data-denies.ts), and nothing here is sent to the web or to a model: the web hears only
 * whether a login is saved for the one site a sign-in card is about.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { decrypt, encrypt } from "../lib/secrets.js";
import { stateDir } from "../remote/store.js";
import { normalizeTotpSeed } from "./totp.js";

export const LOGINS_FILE = "logins.json";
const MAX_LOGINS = 500;

type Stored = { origin: string; username: string; password: string; totp?: string; createdAt: string; usedAt: string | null };
type File = { v: 1; logins: Stored[] };

/** A saved login with its values, for the broker's fill only. */
export type SavedLogin = { origin: string; username: string; password: string; totp: string | null; createdAt: string; usedAt: string | null };

/** What `ensemble browser logins` lists: never the password or the seed. */
export type SavedLoginView = { origin: string; username: string; totp: boolean; createdAt: string; usedAt: string | null };

export class LoginStoreError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

export function loginsPath(): string {
  return join(stateDir(), LOGINS_FILE);
}

/** A site as logins are kept: its origin (scheme, host and port), https unless it is this computer's own address. */
export function loginOrigin(input: string): string {
  const raw = input.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new LoginStoreError(`“${raw.slice(0, 80)}” is not a site. Give its address, such as https://app.example.com.`);
  }
  if (url.username || url.password) throw new LoginStoreError("Give the site's address without a user name or password in it.");
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new LoginStoreError("Logins are saved for https sites (or this computer's own http://localhost).");
  return url.origin;
}

function read(): File {
  const path = loginsPath();
  if (!existsSync(path)) return { v: 1, logins: [] };
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<File>;
    return { v: 1, logins: Array.isArray(value.logins) ? value.logins.filter((row) => row && typeof row.origin === "string") : [] };
  } catch {
    return { v: 1, logins: [] };
  }
}

function write(file: File): void {
  const path = loginsPath();
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

function open(row: Stored): SavedLogin | null {
  try {
    return { origin: row.origin, username: decrypt(row.username), password: decrypt(row.password), totp: row.totp ? decrypt(row.totp) : null, createdAt: row.createdAt, usedAt: row.usedAt ?? null };
  } catch {
    // Kept with another runtime's local key: it cannot be used here.
    return null;
  }
}

/** Saved logins, without their passwords or seeds. */
export function listLogins(): SavedLoginView[] {
  return read()
    .logins.map((row) => {
      const login = open(row);
      return login ? { origin: login.origin, username: login.username, totp: Boolean(login.totp), createdAt: login.createdAt, usedAt: login.usedAt } : null;
    })
    .filter((row): row is SavedLoginView => row !== null)
    .sort((a, b) => a.origin.localeCompare(b.origin));
}

/** Whether a usable login is saved for this site. */
export function hasLogin(origin: string): boolean {
  const row = read().logins.find((item) => item.origin === origin);
  return Boolean(row && open(row));
}

/** The saved login for a site, with its values, for the broker's fill. */
export function loginFor(origin: string): SavedLogin | null {
  const row = read().logins.find((item) => item.origin === origin);
  return row ? open(row) : null;
}

/** Saves (or replaces) the login for a site. */
export function saveLogin(input: { origin: string; username: string; password: string; totp?: string | null }): SavedLoginView {
  const origin = loginOrigin(input.origin);
  const username = input.username.trim();
  if (!username || username.length > 320) throw new LoginStoreError("Give the user name or email (at most 320 characters).");
  if (!input.password || input.password.length > 1024) throw new LoginStoreError("Give the password (at most 1024 characters).");
  const totp = input.totp ? normalizeTotpSeed(input.totp) : null;
  const file = read();
  const now = new Date().toISOString();
  const earlier = file.logins.find((row) => row.origin === origin);
  const row: Stored = { origin, username: encrypt(username), password: encrypt(input.password), ...(totp ? { totp: encrypt(totp) } : {}), createdAt: earlier?.createdAt ?? now, usedAt: earlier?.usedAt ?? null };
  const others = file.logins.filter((item) => item.origin !== origin);
  if (others.length >= MAX_LOGINS) throw new LoginStoreError(`At most ${MAX_LOGINS} logins are saved. Forget one first.`, 409);
  write({ v: 1, logins: [...others, row] });
  return { origin, username, totp: Boolean(totp), createdAt: row.createdAt, usedAt: row.usedAt };
}

/** Forgets the login for a site. False when there was none. */
export function forgetLogin(origin: string): boolean {
  const key = loginOrigin(origin);
  const file = read();
  const kept = file.logins.filter((row) => row.origin !== key);
  if (kept.length === file.logins.length) return false;
  write({ v: 1, logins: kept });
  return true;
}

/** Notes that a saved login was filled. */
export function markLoginUsed(origin: string): void {
  const file = read();
  const row = file.logins.find((item) => item.origin === origin);
  if (!row) return;
  row.usedAt = new Date().toISOString();
  write(file);
}
