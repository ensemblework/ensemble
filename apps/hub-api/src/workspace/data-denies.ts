/**
 * Ensemble's own data on this computer, which no run reads or writes whatever its mode (docs/24 §3):
 * the desktop app's data folder and the folder this runtime really uses, which is another one for the
 * testing CLI and wherever `ENSEMBLE_DATA_HOME` (`ENSEMBLE_REMOTE_STATE_DIR`, `ENSEMBLE_DATA_DIR`) puts
 * it; in them the database, the key that encrypts saved secrets (`secret.key`), the pairing and its
 * sealing key (`seal-key.json`), saved logins (`logins.json`), the run evidence, the browser profiles
 * and capture's state (`browserDeniedPaths`). The guard refuses these
 * paths (`outsideRefusal`), no folder holding one is handed to a run (`holdsProtected`), and every
 * confined spawn denies them in the OS sandbox (`prepareSpawn`), as do the engines' own sandboxes.
 *
 * A data folder that holds the workspace (the testing CLI keeps `<data>/workspace`) is denied entry by
 * entry, all but the workspace, so runs still work there. This module imports nothing from the guard
 * or the sandbox, which both import it.
 */
import { readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopDataDir } from "@ensemble/shared-types/desktop-discovery";
import { browserDeniedPaths, ensembleDataHome } from "../browser/paths.js";

/** This checkout, as guard.ts names it (`ENSEMBLE_SOURCE`): a key file kept in it is denied with the code. */
const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** What a data folder holds, named even before it exists: a sandbox that denies by name keeps it shut once it does. */
const DATA_ENTRIES = ["pglite", "secret.key", "remote.json", "remote-jobs.json", "api.json", "evidence", "backups", "seal-key.json", "seal-seen.json", "logins.json"];

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function withReal(path: string): string[] {
  try {
    return [...new Set([path, realpathSync(path)])];
  } catch {
    return [path];
  }
}

function expand(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2));
  return path;
}

/** The workspace as configured (guard.ts `configuredWorkspace`) and as it really is. */
function workspaces(env: NodeJS.ProcessEnv, home: string): string[] {
  const configured = resolve(expand(env.ENSEMBLE_WORKSPACE_ROOT?.trim() || join(home, "ensemble-workspace"), home));
  return withReal(configured);
}

function entries(folder: string): string[] {
  try {
    return readdirSync(folder);
  } catch {
    return [];
  }
}

type Options = { env?: NodeJS.ProcessEnv; home?: string; platform?: string };

let cached: { key: string; at: number; paths: string[] } | null = null;
const CACHE_MS = 2_000;

/** Every path of Ensemble's own data on this computer that a run must never reach. */
export function ensembleDataDenies(options: Options = {}): string[] {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const key = [home, platform, env.ENSEMBLE_REMOTE_STATE_DIR, env.ENSEMBLE_DATA_DIR, env.ENSEMBLE_SECRET_KEY_FILE, env.ENSEMBLE_WORKSPACE_ROOT, env.APPDATA, env.XDG_DATA_HOME].join("\0");
  if (!options.env && cached?.key === key && Date.now() - cached.at < CACHE_MS) return cached.paths;
  const dataHome = resolve(ensembleDataHome(env, platform, home));
  const desktop = resolve(desktopDataDir({ platform, home, env: { APPDATA: env.APPDATA, XDG_DATA_HOME: env.XDG_DATA_HOME } }));
  const work = workspaces(env, home);
  const denies = new Set<string>();
  for (const folder of new Set([desktop, dataHome].flatMap(withReal))) {
    if (!work.some((workspace) => inside(folder, workspace))) {
      denies.add(folder);
      continue;
    }
    for (const name of entries(folder)) {
      const path = join(folder, name);
      if (!work.some((workspace) => inside(path, workspace))) denies.add(path);
    }
    for (const name of DATA_ENTRIES) denies.add(join(folder, name));
    for (const path of browserDeniedPaths(folder)) denies.add(path);
  }
  const database = env.ENSEMBLE_DATA_DIR?.trim();
  if (database) for (const path of withReal(resolve(database))) denies.add(path);
  const keyFile = env.ENSEMBLE_SECRET_KEY_FILE?.trim();
  if (keyFile && !inside(SOURCE, resolve(keyFile))) for (const path of withReal(resolve(keyFile))) denies.add(path);
  for (const path of browserDeniedPaths(dataHome)) denies.add(path);
  // Never the workspace itself, nor a folder holding it: runs work there.
  const paths = [...denies].filter((path) => !work.some((workspace) => inside(path, workspace)));
  if (!options.env) cached = { key, at: Date.now(), paths };
  return paths;
}

/** Whether a real path is Ensemble's own data (`ensembleDataDenies`). */
export function isEnsembleData(real: string, options: Options = {}): boolean {
  return ensembleDataDenies(options).some((path) => inside(path, real));
}
