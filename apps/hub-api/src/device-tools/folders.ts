/**
 * Where a node's tool call may act on this computer: a folder it shares with Ensemble (by its label)
 * or any folder named by its full path that Ensemble may hand to an agent at all (`resolveWorkFolder`:
 * never a link, the home folder, a system folder, a folder of keys or Ensemble's own code or data).
 * A call that names no folder works in the node's own folder, `<workspace>/nodes/<handle>`.
 * That is the hard floor; whether the call then runs is the policy's (device-tools/policy.ts).
 * Commands run with the same sandbox denials whatever the folder (`nodeToolDenies`).
 */
import { lstat, mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { DEFAULT_KEY_FILE } from "../lib/secrets.js";
import { protectedDeviceFolders } from "../evidence/files.js";
import { ENSEMBLE_SOURCE, GuardError, holdsProtected, knownWorkspace, resolveWorkFolder, SECRET_PATHS, within, workspaceRoot } from "../workspace/guard.js";
import { loadSettings } from "../remote/store.js";
import { isEnsembleData } from "../workspace/data-denies.js";

/** `own`: the node's own folder on this computer, or Ensemble's run and node folders, which need no answer from the owner. */
export type ToolFolder = { path: string; label: string; own?: boolean };

/** Refuses a folder that holds keys, sign-ins or Ensemble's own files. */
function checkFloor(path: string): void {
  if (holdsProtected(path)) throw new GuardError("That folder holds keys, sign-ins or Ensemble's own files, so no node may work in it.");
  if (isEnsembleData(path) || protectedDeviceFolders().some((folder) => within(path, folder))) throw new GuardError("Ensemble's own data folder is off limits.");
}

/**
 * Whether a folder is Ensemble's own work folder for agents: a run's (`<workspace>/runs/<job>`) or a
 * node's (`<workspace>/nodes/<handle>`), or a folder inside one. A node's tools work there without
 * asking, as in its own folder (the floor still applies).
 */
export async function isEnsembleWorkFolder(path: string): Promise<boolean> {
  const root = await workspaceRoot();
  for (const area of ["runs", "nodes"]) {
    const rel = relative(join(root, area), path);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return true;
  }
  return false;
}

/** A folder for a node's tool: a shared folder's label, or a full path Ensemble may hand to an agent. */
export async function resolveToolFolder(input: string): Promise<ToolFolder> {
  const named = input.trim();
  const shared = loadSettings().folders.find((row) => row.label === named);
  const path = await resolveWorkFolder(shared ? shared.path : named);
  checkFloor(path);
  const home = homedir();
  const own = await isEnsembleWorkFolder(path);
  return { path, label: shared ? shared.label : within(home, path, false) ? `~/${relative(home, path).split(/[\\/]/).join("/")}` : path, ...(own ? { own: true } : {}) };
}

/** The name of a node's own folder: its handle, else the start of its id. */
export function ownFolderName(node: { nodeId: string; nodeSlug?: string }): string {
  if (node.nodeSlug && /^[a-z0-9][a-z0-9-]{0,63}$/.test(node.nodeSlug)) return node.nodeSlug;
  return node.nodeId.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 8) || "node";
}

/** A folder made for Ensemble (mode 0700) where none is; refused when a link or a file is there instead. */
async function ensureFolder(path: string): Promise<void> {
  const info = await lstat(path).catch(() => null);
  if (!info) {
    await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    return;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new GuardError(`${path} is not a folder Ensemble made (a link or a file is there), so no node works in it.`);
}

/**
 * The node's own folder on this computer (nodeTools 2): `<workspace>/nodes/<handle>`, made on first
 * use and readable by this account only. A call that names no folder works there without asking
 * the owner. It meets the same floor as any folder: a real folder inside the workspace, never a link.
 */
export async function ownToolFolder(node: { nodeId: string; nodeSlug?: string }): Promise<ToolFolder> {
  const root = await workspaceRoot();
  const parent = join(root, "nodes");
  await ensureFolder(parent);
  const folder = join(parent, ownFolderName(node));
  await ensureFolder(folder);
  const path = await resolveWorkFolder(folder);
  if (!within(root, path, false)) throw new GuardError("The node's own folder leads outside Ensemble's workspace.");
  checkFloor(path);
  return { path, label: node.nodeSlug ? `@${node.nodeSlug}'s folder` : "the node's own folder", own: true };
}

/** The folder a call names, or the node's own folder when it names none. */
export async function toolFolderFor(request: { folder?: string; nodeId: string; nodeSlug?: string }): Promise<ToolFolder> {
  return request.folder?.trim() ? resolveToolFolder(request.folder) : ownToolFolder(request);
}

/**
 * A data folder to keep out of reach: all of it, or (where the Ensemble workspace and the cache every
 * command uses live inside it, as with the testing CLI) everything in it but the workspace.
 */
async function dataDenies(folder: string): Promise<string[]> {
  const workspace = knownWorkspace();
  if (!within(folder, workspace)) return [folder];
  const names = await readdir(folder).catch(() => [] as string[]);
  return names.map((name) => join(folder, name)).filter((path) => !within(path, workspace));
}

/**
 * What a node's commands never reach, even inside a granted folder: keys and sign-ins in the home
 * folder, Ensemble's data (its database and the run secrets in it), the key that encrypts them, its
 * git helper and the browser profile. The OS sandbox enforces it; without one it is best effort.
 */
export async function nodeToolDenies(home = homedir()): Promise<string[]> {
  const keyFile = process.env.ENSEMBLE_SECRET_KEY_FILE?.trim() || DEFAULT_KEY_FILE;
  const database = process.env.ENSEMBLE_DATA_DIR?.trim();
  const data = (await Promise.all(protectedDeviceFolders(home).map(dataDenies))).flat();
  return [
    ...new Set([
      ...data,
      ...(database ? [database] : []),
      // In the checkout's own .ensemble folder (no other key file named), the key is Ensemble's code: denied anyway.
      ...(within(ENSEMBLE_SOURCE, keyFile) ? [] : [keyFile]),
      join(knownWorkspace(), ".askpass"),
      ...SECRET_PATHS.map((name) => join(home, name)),
    ]),
  ];
}
