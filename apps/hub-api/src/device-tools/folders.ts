/**
 * Where a node's tool call may act on this computer: a folder it shares with Ensemble (by its label)
 * or any folder named by its full path that Ensemble may hand to an agent at all (`resolveWorkFolder`:
 * never a link, the home folder, a system folder, a folder of keys or Ensemble's own code or data).
 * That is the hard floor; whether the call then runs is the policy's (device-tools/policy.ts).
 * Commands run with the same sandbox denials whatever the folder (`nodeToolDenies`).
 */
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { DEFAULT_KEY_FILE } from "../lib/secrets.js";
import { protectedDeviceFolders } from "../evidence/files.js";
import { ENSEMBLE_SOURCE, GuardError, holdsProtected, knownWorkspace, resolveWorkFolder, SECRET_PATHS, within } from "../workspace/guard.js";
import { loadSettings } from "../remote/store.js";

export type ToolFolder = { path: string; label: string };

/** A folder for a node's tool: a shared folder's label, or a full path Ensemble may hand to an agent. */
export async function resolveToolFolder(input: string): Promise<ToolFolder> {
  const named = input.trim();
  const shared = loadSettings().folders.find((row) => row.label === named);
  const path = await resolveWorkFolder(shared ? shared.path : named);
  if (holdsProtected(path)) throw new GuardError("That folder holds keys, sign-ins or Ensemble's own files, so no node may work in it.");
  if (protectedDeviceFolders().some((folder) => within(folder, path) || within(path, folder))) throw new GuardError("Ensemble's own data folder is off limits.");
  const home = homedir();
  return { path, label: shared ? shared.label : within(home, path, false) ? `~/${relative(home, path).split(/[\\/]/).join("/")}` : path };
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
