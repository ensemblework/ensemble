/**
 * Where the browser broker and capture keep their files, all inside Ensemble's data folder (the
 * folder the CLI and desktop app share, doc 26 §3). The OS sandbox denies that folder to agent
 * runs; `browserDeniedPaths()` names the browser parts explicitly, so a runtime whose data folder
 * is not the desktop app's (the testing CLI, `ENSEMBLE_DATA_HOME`) can deny them too.
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { desktopDataDir } from "@ensemble/shared-types/desktop-discovery";

/** Ensemble's data folder for this runtime: the same folder `remote/store.ts` keeps its state in. */
export function ensembleDataHome(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, home: string = homedir()): string {
  const explicit = env.ENSEMBLE_REMOTE_STATE_DIR?.trim();
  if (explicit) return explicit;
  const database = env.ENSEMBLE_DATA_DIR?.trim();
  if (database) return dirname(database);
  return desktopDataDir({ platform, home, env: { APPDATA: env.APPDATA, XDG_DATA_HOME: env.XDG_DATA_HOME } });
}

const PROFILE = /^[a-z0-9][a-z0-9_-]{0,47}$/i;

export function isProfileName(name: string): boolean {
  return PROFILE.test(name);
}

/** The broker's profiles: `<data>/browser/<profile>`, one persistent Chromium profile each. */
export function browserRoot(dataHome: string = ensembleDataHome()): string {
  return join(dataHome, "browser");
}

export function browserProfileDir(profile: string, dataHome: string = ensembleDataHome()): string {
  if (!isProfileName(profile)) throw new Error(`"${profile}" is not a browser profile name: letters, digits, - and _ only.`);
  return join(browserRoot(dataHome), profile);
}

/** Playwright's browsers and ffmpeg as `ensemble capture setup` installs them (PLAYWRIGHT_BROWSERS_PATH). */
export function playwrightBrowsersDir(dataHome: string = ensembleDataHome()): string {
  return join(dataHome, "playwright");
}

/** Capture's own state: the lease file the janitor reads after a crash, and X authority cookies. */
export function captureStateDir(dataHome: string = ensembleDataHome()): string {
  return join(dataHome, "capture");
}

/**
 * Folders an agent run must never read or write: the browser profiles (cookies, saved sign-ins)
 * and capture's state (virtual display cookies). Add these to the sandbox's deny list.
 */
export function browserDeniedPaths(dataHome: string = ensembleDataHome()): string[] {
  return [browserRoot(dataHome), captureStateDir(dataHome)];
}
