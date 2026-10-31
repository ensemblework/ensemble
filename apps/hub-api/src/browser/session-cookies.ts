/**
 * A profile's session cookies (those with no expiry) kept across its browser's restarts. Chromium keeps
 * only cookies with an expiry on disk, and ends the session (dropping the rest) when its last page
 * closes, so a restart (a window for the owner, the janitor closing an idle browser or tab, Ensemble
 * restarting) would sign the owner out of every site that signs in for the session only (Azure's
 * portal, many banks). The broker writes them every 30 seconds, and before it closes or restarts the
 * browser or closes its last page, into `ensemble-session-cookies.json` in the profile's own folder
 * (mode 0600), beside Chromium's cookie store in the same folder every run and agent is denied, and puts
 * them back when the browser starts or opens a page again. A browser with no page left is not read: its
 * session is over, and the last snapshot stands.
 */
import { randomBytes } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext } from "playwright-core";

export const SESSION_COOKIES_FILE = "ensemble-session-cookies.json";
/** How often a profile's session cookies are written while its browser runs. */
export const SESSION_COOKIES_EVERY_MS = 30_000;
const MAX_COOKIES = 5_000;

type Cookie = { name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; sameSite?: "Strict" | "Lax" | "None" };

function cookieOf(raw: unknown): Cookie | null {
  const value = raw as Partial<Cookie> | null;
  if (!value || typeof value.name !== "string" || typeof value.value !== "string" || typeof value.domain !== "string" || !value.domain) return null;
  const sameSite = value.sameSite === "Strict" || value.sameSite === "Lax" || value.sameSite === "None" ? value.sameSite : undefined;
  return { name: value.name, value: value.value, domain: value.domain, path: typeof value.path === "string" && value.path ? value.path : "/", expires: -1, httpOnly: value.httpOnly === true, secure: value.secure === true, ...(sameSite ? { sameSite } : {}) };
}

/** Writes the context's session cookies (all of them, none when there are none) into the profile's folder. Null when the browser could not be read. */
export async function saveSessionCookies(context: BrowserContext, profileDir: string): Promise<number | null> {
  if (!context.pages().length) return null;
  let cookies;
  try {
    cookies = await context.cookies();
  } catch {
    return null;
  }
  const session = cookies.filter((cookie) => cookie.expires === -1).slice(0, MAX_COOKIES).map(cookieOf).filter((cookie): cookie is Cookie => cookie !== null);
  const path = join(profileDir, SESSION_COOKIES_FILE);
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify({ v: 1, savedAt: new Date().toISOString(), cookies: session })}\n`, { mode: 0o600 });
    await rename(temp, path);
  } catch {
    await rm(temp, { force: true }).catch(() => undefined);
    return null;
  }
  return session.length;
}

/** Puts a profile's saved session cookies back into its browser; how many it took. */
export async function restoreSessionCookies(context: BrowserContext, profileDir: string): Promise<number> {
  let cookies: Cookie[];
  try {
    const saved = JSON.parse(await readFile(join(profileDir, SESSION_COOKIES_FILE), "utf8")) as { cookies?: unknown };
    cookies = (Array.isArray(saved.cookies) ? saved.cookies : []).slice(0, MAX_COOKIES).map(cookieOf).filter((cookie): cookie is Cookie => cookie !== null);
  } catch {
    return 0;
  }
  return addCookies(context, cookies);
}

/** Adds cookies to a context, all at once, else one at a time so one the browser refuses does not stop the rest. */
export async function addCookies(context: BrowserContext, cookies: readonly Cookie[]): Promise<number> {
  if (!cookies.length) return 0;
  try {
    await context.addCookies([...cookies]);
    return cookies.length;
  } catch {
    let added = 0;
    for (const cookie of cookies) {
      try {
        await context.addCookies([cookie]);
        added += 1;
      } catch {
        // A cookie this browser does not take (a __Host- cookie with a domain, SameSite=None without Secure).
      }
    }
    return added;
  }
}
