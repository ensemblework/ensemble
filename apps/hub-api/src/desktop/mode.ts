/**
 * How this computer uses Ensemble (docs/DESKTOP.md §1): `local` keeps everything here and never talks
 * to Ensemble's servers; `account` opens the person's Ensemble account in the app window and pairs this
 * computer to it. The choice lives in `mode.json` in the shared data folder, so the desktop app, its
 * sidecar and the CLI runner all see the same one. Only this module writes it.
 *
 * `local` → `account` happens at most once (the local data moves into the account); `account` never
 * goes back to `local`.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { desktopDataDir } from "@ensemble/shared-types/desktop-discovery";

export type RuntimeMode = {
  mode: "local" | "account" | null;
  chosenAt?: string;
  /** When this computer left local-only mode for an account. Set once; never cleared. */
  switchedAt?: string;
  /** The account's web app, for the window (https://app.ensemblework.com unless the computer was paired elsewhere). */
  appUrl?: string;
  apiBase?: string;
  /** The account this computer signed in to, to notice a different account signing in later. */
  accountEmail?: string;
  /** What the move to the account carried, for the app's "moved" note. */
  moved?: { added: number; merged: number; skipped: number; notes: string[] };
};

export function appDataDir(): string {
  const explicit = process.env.ENSEMBLE_APP_DATA_DIR?.trim();
  if (explicit) return explicit;
  const pglite = process.env.ENSEMBLE_DATA_DIR?.trim();
  if (pglite) return dirname(pglite);
  return desktopDataDir({ platform: process.platform, home: homedir(), env: process.env });
}

export function modeFile(): string {
  return join(appDataDir(), "mode.json");
}

let cached: { path: string; mtime: number; value: RuntimeMode } | null = null;

export function readMode(): RuntimeMode {
  const path = modeFile();
  try {
    const mtime = statSync(path).mtimeMs;
    if (cached?.path === path && cached.mtime === mtime) return cached.value;
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<RuntimeMode>;
    const value: RuntimeMode = {
      mode: raw.mode === "local" || raw.mode === "account" ? raw.mode : null,
      ...(typeof raw.chosenAt === "string" ? { chosenAt: raw.chosenAt } : {}),
      ...(typeof raw.switchedAt === "string" ? { switchedAt: raw.switchedAt } : {}),
      ...(typeof raw.appUrl === "string" ? { appUrl: raw.appUrl } : {}),
      ...(typeof raw.apiBase === "string" ? { apiBase: raw.apiBase } : {}),
      ...(typeof raw.accountEmail === "string" ? { accountEmail: raw.accountEmail } : {}),
      ...(raw.moved && typeof raw.moved === "object" ? { moved: raw.moved } : {}),
    };
    cached = { path, mtime, value };
    return value;
  } catch {
    return { mode: null };
  }
}

export function writeMode(next: RuntimeMode): RuntimeMode {
  const path = modeFile();
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
  cached = null;
  return readMode();
}

/** True when this computer keeps Ensemble local only: no pairing, no included models, no Ensemble servers. */
export function localOnly(): boolean {
  // Only a computer's own runtime has a mode; a hosted server never reads one.
  if (process.env.ENSEMBLE_DESKTOP !== "1") return false;
  return process.env.ENSEMBLE_LOCAL_ONLY === "1" || readMode().mode === "local";
}

export const LOCAL_ONLY_REFUSAL =
  "This computer keeps Ensemble local only, so it does not connect to an Ensemble account. To use your account here, open the Ensemble app and choose Settings → Account → Move to your Ensemble account.";

export function modeFileExists(): boolean {
  return existsSync(modeFile());
}
