/**
 * The folder picker's view of a computer (docs/16 §1, "Open a folder"): a few places to start from
 * (home, Desktop, Documents, project folders, Ensemble's workspace, the folders Code can use) and the
 * folders inside them, one level at a time. Nothing outside those places is listed: not `/`, not
 * system folders, not dot-folders or app data in the home folder. A folder outside the workspace and
 * the folders Code can use is listed but has to be trusted (added to them) before Code or an agent
 * works in it.
 */
import { access, mkdir, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { env } from "../config.js";
import { blockedReason, expandHome, GuardError, within } from "../workspace/guard.js";
import { git } from "./git.js";
import { dotUnderHome, resolveCodeFolder, usableCodeRoots } from "./code-folders.js";
import { loadSettings, saveSettings } from "./settings.js";

export type BrowsePlace = { kind: "home" | "desktop" | "documents" | "projects" | "workspace" | "code"; name: string; path: string };
export type BrowseEntry = { name: string; path: string; repo: boolean; trusted: boolean };
export type BrowseFolder = {
  path: string;
  name: string;
  /** The folder above, when it is still inside the places. */
  parent: string | null;
  entries: BrowseEntry[];
  /** Folders past `MAX_ENTRIES` that were not listed. */
  more: number;
  repo: boolean;
  /** Code and agents may work here without asking: the workspace or a folder Code can use. */
  trusted: boolean;
  /** Why this folder itself cannot be chosen (too broad, settings), or null. */
  why: string | null;
};

const MAX_ENTRIES = 400;
/** Folders that hold dependencies or build output, never a project to open. */
const SKIPPED = new Set(["node_modules", "__pycache__", "venv", "target", "dist", "build", "Library", "AppData", "Applications"]);
/** Folders in the home folder people keep projects in, offered when they are there. */
const PROJECT_FOLDERS = ["code", "codes", "Code", "projects", "Projects", "dev", "Developer", "src", "repos", "git", "GitHub", "workspace", "work"];
const FOLDER_NAME = /^[^/\\:*?"<>|\0]{1,100}$/;

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

const real = (path: string) => realpath(path).catch(() => null);

/** The workspace and the folders Code can use, resolved. */
async function trustedRoots(prisma: PrismaClient, userId: string): Promise<string[]> {
  const settings = await loadSettings(prisma, userId);
  const workspace = await real(expandHome(env.ENSEMBLE_WORKSPACE_ROOT));
  return [...(workspace ? [workspace] : []), ...(await usableCodeRoots(settings, userId))];
}

/** Where the picker starts: the places that exist on this computer. */
export async function browsePlaces(prisma: PrismaClient, userId: string): Promise<BrowsePlace[]> {
  const home = (await real(homedir())) ?? homedir();
  const places: BrowsePlace[] = [{ kind: "home", name: "Home", path: home }];
  for (const [kind, name] of [["desktop", "Desktop"], ["documents", "Documents"]] as const) {
    const path = join(home, name);
    if (await exists(path)) places.push({ kind, name, path });
  }
  for (const name of PROJECT_FOLDERS) {
    const path = await real(join(home, name));
    if (path && within(home, path, false) && !places.some((place) => place.path === path)) places.push({ kind: "projects", name, path });
  }
  const workspace = await real(expandHome(env.ENSEMBLE_WORKSPACE_ROOT));
  if (workspace) places.push({ kind: "workspace", name: "Ensemble workspace", path: workspace });
  const settings = await loadSettings(prisma, userId);
  for (const path of await usableCodeRoots(settings, userId)) {
    if (!places.some((place) => place.path === path)) places.push({ kind: "code", name: basename(path), path });
  }
  return places;
}

/** The real path of a folder the picker may show, or a GuardError. */
async function browsable(path: string, places: BrowsePlace[]): Promise<string> {
  const typed = path.trim();
  if (!typed) throw new GuardError("Pick a folder.");
  if (typed.split(/[/\\]+/).includes("..")) throw new GuardError("Write the folder's path without “..”.");
  const found = await real(expandHome(typed));
  if (!found) throw new GuardError("That folder does not exist.");
  if (!places.some((place) => within(place.path, found))) throw new GuardError("The picker shows your home folder, the Ensemble workspace and the folders Code can use.");
  const home = (await real(homedir())) ?? homedir();
  if (dotUnderHome(found, home)) throw new GuardError("Folders starting with a dot hold settings or app data.");
  const blocked = blockedReason(found);
  // The home folder and Desktop are too broad to work in, but fine to look through.
  if (blocked && !/too broad/.test(blocked)) throw new GuardError(blocked);
  return found;
}

/** One folder's folders, for the picker. */
export async function browseFolder(prisma: PrismaClient, userId: string, path: string | null): Promise<{ places: BrowsePlace[]; folder: BrowseFolder }> {
  const places = await browsePlaces(prisma, userId);
  const start = places.find((place) => place.kind === "projects") ?? places.find((place) => place.kind === "workspace") ?? places[0]!;
  const folder = await browsable(path ?? start.path, places);
  const listed = await readdir(folder, { withFileTypes: true }).catch(() => []);
  const dirs = listed
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !SKIPPED.has(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
  const shown = dirs.slice(0, MAX_ENTRIES);
  const roots = await trustedRoots(prisma, userId);
  const entries = await Promise.all(
    shown.map(async (entry) => {
      const path = join(folder, entry.name);
      return { name: entry.name, path, repo: await exists(join(path, ".git")), trusted: roots.some((root) => within(root, path)) };
    }),
  );
  const above = dirname(folder);
  const parent = above !== folder && places.some((place) => within(place.path, above)) ? above : null;
  const blocked = blockedReason(folder);
  return {
    places,
    folder: {
      path: folder,
      name: basename(folder) || folder,
      parent,
      entries,
      more: Math.max(0, dirs.length - shown.length),
      repo: await exists(join(folder, ".git")),
      trusted: roots.some((root) => within(root, folder)),
      why: blocked,
    },
  };
}

/** Makes a folder inside one the picker shows; with `repo`, a git repository in it. Returns its path. */
export async function makeFolder(prisma: PrismaClient, userId: string, parent: string, name: string, repo: boolean): Promise<string> {
  const clean = name.trim();
  if (!FOLDER_NAME.test(clean) || clean.startsWith(".") || clean === "..") throw new GuardError("Use a folder name without slashes, and not starting with a dot.");
  const places = await browsePlaces(prisma, userId);
  const base = await browsable(parent, places);
  const path = join(base, clean);
  if (await exists(path)) throw new GuardError(`${clean} is already there.`);
  await mkdir(path);
  if (repo) await git(path, ["init", "-q"]).catch(() => undefined);
  return path;
}

/**
 * Trusts a folder for Code and agents: adds it to the folders Code can use (`settings.code.roots`),
 * after the same checks Settings makes. A folder already inside the workspace or one of them is left as
 * it is. With `repo`, a folder that is not a git repository becomes one, as Code works in repositories.
 */
export async function trustFolder(prisma: PrismaClient, userId: string, path: string, repo: boolean): Promise<{ path: string; added: boolean }> {
  const resolved = await resolveCodeFolder(path, userId);
  if (repo && !(await exists(join(resolved, ".git")))) await git(resolved, ["init", "-q"]);
  const roots = await trustedRoots(prisma, userId);
  if (roots.some((root) => within(root, resolved))) return { path: resolved, added: false };
  const settings = await loadSettings(prisma, userId);
  await saveSettings(prisma, userId, { code: { ...settings.code, roots: [...settings.code.roots, resolved] } });
  return { path: resolved, added: true };
}
