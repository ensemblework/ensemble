/**
 * CLI 0.1 kept its own database in its own folder, so a computer with both the
 * CLI and the desktop app had two runtimes, two pairings and two trusted-folder
 * lists. Both now use the desktop app's folder. This moves an older CLI's data
 * there once, before the first sidecar starts, when that folder has no
 * database yet. Nothing is deleted; when both folders already hold a database
 * the old one stays where it is and `ensemble doctor`-style output says so.
 */
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileExists, resolveLegacyDataHome, type CliPaths } from "./paths.js";

/** The database, its backups, the key that encrypts saved credentials, and pairing state. */
export const MOVED_ENTRIES = ["pglite", "backups", "secret.key", "remote.json", "remote-jobs.json"];

export type MigrationResult =
  | { status: "none" }
  | { status: "moved"; from: string; to: string; entries: string[] }
  | { status: "kept-both"; from: string; to: string; reason: string }
  | { status: "skipped-running"; from: string };

async function same(a: string, b: string): Promise<boolean> {
  try {
    return (await readFile(a)).equals(await readFile(b));
  } catch {
    return false;
  }
}

async function move(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await cp(from, to, { recursive: true, errorOnExist: true, force: false });
    await rm(from, { recursive: true, force: true });
  }
}

export async function migrateLegacyData(
  paths: CliPaths,
  options: { legacy?: string; legacyRunning?: (discoveryFile: string) => Promise<boolean> } = {},
): Promise<MigrationResult> {
  const legacy = options.legacy ?? resolveLegacyDataHome();
  const target = paths.dataHome;
  if (legacy === target || !(await fileExists(join(legacy, "pglite")))) return { status: "none" };
  if (await fileExists(join(target, "pglite"))) {
    return { status: "kept-both", from: legacy, to: target, reason: "The Ensemble app already has a database on this computer." };
  }
  if ((await fileExists(join(target, "secret.key"))) && (await fileExists(join(legacy, "secret.key"))) && !(await same(join(target, "secret.key"), join(legacy, "secret.key")))) {
    return { status: "kept-both", from: legacy, to: target, reason: "The two folders use different encryption keys." };
  }
  if (options.legacyRunning && (await options.legacyRunning(join(legacy, "api.json")))) return { status: "skipped-running", from: legacy };
  await mkdir(target, { recursive: true, mode: 0o700 });
  const entries: string[] = [];
  for (const name of MOVED_ENTRIES) {
    const from = join(legacy, name);
    const to = join(target, name);
    if (!(await fileExists(from)) || (await fileExists(to))) continue;
    await move(from, to);
    entries.push(name);
  }
  await writeFile(
    join(legacy, "MOVED.txt"),
    `Ensemble moved this folder's database to ${target} on ${new Date().toISOString()}.\nThe CLI and the desktop app now share that folder.\n`,
  );
  return { status: "moved", from: legacy, to: target, entries };
}
