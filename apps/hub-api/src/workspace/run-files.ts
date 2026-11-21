/**
 * Files Ensemble writes into a run's folder for the agent (its skills, a handoff record): each folder
 * made one level at a time and never through a link, each file written through a new file renamed
 * over it, and git told to leave them out of the folder's changes in `.git/info/exclude` (never the
 * repository's own .gitignore). A run in the folder can plant links there, so nothing is followed.
 */
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** A real folder (never a link to one). */
export const isFolder = (path: string) => lstat(path).then((info) => info.isDirectory() && !info.isSymbolicLink(), () => false);

/** A file's text without following a link: null when it is missing, a link, or not a plain file. */
export async function readRegular(path: string): Promise<string | null> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => null);
  if (!handle) return null;
  try {
    if (!(await handle.stat()).isFile()) return null;
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

/** Writes a file in a real folder through a new file renamed over it, so a link in its place is replaced, never followed. */
export async function writeSafely(dir: string, name: string, text: string): Promise<void> {
  if (!(await isFolder(dir))) throw new Error(`${dir} is not a folder.`);
  const temporary = join(dir, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(temporary, text, { flag: "wx", mode: 0o644 });
  try {
    await rename(temporary, join(dir, name));
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/**
 * `root/<parts…>` as a real folder, made where missing; null when one of them is a link or a file.
 * The root itself must be a real folder.
 */
export async function folderIn(root: string, parts: readonly string[]): Promise<string | null> {
  if (!(await isFolder(root))) return null;
  let at = root;
  for (const part of parts) {
    if (!part || part === "." || part === ".." || part.includes("/") || part.includes("\\")) return null;
    at = join(at, part);
    const info = await lstat(at).catch(() => null);
    if (!info) {
      const made = await mkdir(at).then(() => true, (error: NodeJS.ErrnoException) => error.code === "EEXIST");
      if (!made || !(await isFolder(at))) return null;
      continue;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) return null;
  }
  return at;
}

const isPlainFile = (path: string) => lstat(path).then((info) => info.isFile() && !info.isSymbolicLink(), () => false);

/** A git directory a `.git` file points at, only when it looks like one (a worktree's, a submodule's). */
async function gitDirOf(dotGit: string): Promise<string | null> {
  if (await isFolder(dotGit)) return dotGit;
  if (!(await isPlainFile(dotGit))) return null;
  const line = ((await readRegular(dotGit)) ?? "").split("\n")[0]?.trim() ?? "";
  const match = /^gitdir:\s*(.+)$/.exec(line);
  if (!match) return null;
  const dir = resolve(dirname(dotGit), match[1]!.trim());
  return (await isPlainFile(join(dir, "HEAD"))) ? dir : null;
}

/** Where git reads the repository's exclude file: the common directory of a worktree's git directory. */
async function commonDirOf(gitDir: string): Promise<string> {
  const pointer = (await readRegular(join(gitDir, "commondir")))?.trim();
  if (!pointer) return gitDir;
  const common = isAbsolute(pointer) ? pointer : resolve(gitDir, pointer);
  return (await isFolder(common)) ? common : gitDir;
}

/** The repository the folder is in: its top folder and the git directory whose exclude applies. */
export async function repositoryOf(folder: string): Promise<{ top: string; common: string } | null> {
  let at = resolve(folder);
  for (let hops = 0; hops < 40; hops += 1) {
    const dotGit = join(at, ".git");
    if (await lstat(dotGit).then(() => true, () => false)) {
      const gitDir = await gitDirOf(dotGit);
      return gitDir ? { top: at, common: await commonDirOf(gitDir) } : null;
    }
    const up = dirname(at);
    if (up === at) return null;
    at = up;
  }
  return null;
}

/**
 * Adds the patterns (relative to `folder`, in git's syntax: `.claude/skills/ensemble-planning/`) to the
 * exclude file of the repository the folder is in, under a heading, once. Nothing when the folder is
 * not in a repository. Returns the lines as written there.
 */
export async function excludeInGit(folder: string, patterns: readonly string[], heading: string): Promise<string[]> {
  const repo = await repositoryOf(folder);
  if (!repo) return [];
  const prefix = relative(repo.top, resolve(folder)).split(sep).filter(Boolean).join("/");
  const lines = patterns.map((pattern) => `/${prefix ? `${prefix}/` : ""}${pattern.replace(/^\/+/, "")}`);
  const info = join(repo.common, "info");
  if (!(await isFolder(info))) {
    if (await lstat(info).then(() => true, () => false)) return [];
    await mkdir(info).catch(() => undefined);
    if (!(await isFolder(info))) return [];
  }
  const text = (await readRegular(join(info, "exclude"))) ?? (await readFile(join(info, "exclude"), "utf8").then(() => null, () => ""));
  if (text === null) return [];
  const have = new Set(text.split("\n").map((line) => line.trim()));
  const missing = lines.filter((line) => !have.has(line));
  if (missing.length) await writeSafely(info, "exclude", `${text}${text && !text.endsWith("\n") ? "\n" : ""}# ${heading}\n${missing.join("\n")}\n`);
  return lines;
}
