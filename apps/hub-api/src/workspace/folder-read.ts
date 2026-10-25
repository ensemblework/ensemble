/**
 * Reading a run's folder for the person looking at it: one folder's entries, or one file's text.
 * A paired computer uses this to answer Ensemble on the web (live browsing and the files an agent
 * changed), and the server uses it for its own runs. Only inside the folder, never git's own files,
 * never a file or folder of keys or secrets, text only, capped, with known secret shapes redacted.
 *
 * The agent can make links, so every rule applies to where a path really leads (`ln -s .env notes.md`
 * is refused like `.env`), a hard-linked file is not shown (it may be another name for a file outside
 * the folder), and an opened file is checked again against its path, so swapping a folder for a link
 * between the check and the read is caught.
 */
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { redactText } from "../lib/redact.js";
import { GuardError, jailPath, outsideRefusal, within } from "./guard.js";

export const FOLDER_ENTRIES_MAX = 1000;
/** What one file view carries. Larger files show their first part. */
export const FILE_VIEW_BYTES = 512 * 1024;

const SECRET_NAME =
  /^(?:\.env(?:[._-].*)?|.+\.env|\.envrc|.+\.(?:pem|key|p12|pfx|keystore|jks|kdbx|ovpn|tfvars|tfstate|tfstate\.backup)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|\.npmrc|\.netrc|\.pypirc|\.pgpass|\.htpasswd|\.dev\.vars|\.git-credentials|kubeconfig|credentials(?:\.json)?|secrets?\.(?:ya?ml|json|toml))$/;
/** Folders of keys and sign-ins: nothing under them is shown. */
const SECRET_FOLDER = new Set([".ssh", ".aws", ".kube", ".gnupg", ".docker", ".azure", ".gcloud", ".password-store", ".terraform.d"]);

export type FolderEntry = { name: string; kind: "dir" | "file" | "link"; size: number | null };
export type FolderListing = { path: string; entries: FolderEntry[]; truncated: boolean; hidden: number };
export type FolderFile = { path: string; size: number; content: string | null; binary: boolean; truncated: boolean };

/** A path inside the folder, as `a/b/c` (no leading slash, no dots). */
export function folderPath(input: string): string {
  return input
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== ".")
    .join("/");
}

/**
 * A name as the file system will match it: case-insensitive disks (macOS, Windows) find `.GIT` as
 * `.git`, and Windows drops trailing dots and spaces (`.git.` is `.git`).
 */
function matchName(part: string): string {
  return part.replace(/[. ]+$/, (tail) => (tail === part ? tail : "")).toLowerCase();
}

/** Why this path is not shown, or null. */
export function refusedPath(path: string): string | null {
  const parts = folderPath(path).split("/").filter(Boolean);
  if (parts.some((part) => part.trim() === "..")) return "That is outside the task's folder.";
  // `name:stream` is an NTFS alternate data stream.
  if (parts.some((part) => part.includes(":"))) return "That is not a file in the task's folder.";
  const names = parts.map(matchName);
  if (names.includes(".git")) return "Git's own files are not shown.";
  if (names.some((name) => SECRET_FOLDER.has(name))) return "Folders of keys and sign-ins are not shown.";
  if (SECRET_NAME.test(names[names.length - 1] ?? "")) return "Files that hold keys or secrets are not shown.";
  return null;
}

/** The folder's real path and the real path of `path` inside it, refused by the same rules wherever a link led. */
async function resolveInside(root: string, path: string): Promise<{ real: string; full: string }> {
  const real = await realpath(root);
  const full = await jailPath(real, path || ".", true);
  const inner = relative(real, full).split(sep).join("/");
  const refused = inner ? refusedPath(inner) : null;
  if (refused) throw new GuardError(refused);
  return { real, full };
}

/** What an entry is, following a link only to where it really leads inside the folder. */
async function entryKind(real: string, full: string, isLink: boolean, isDir: boolean): Promise<{ kind: FolderEntry["kind"]; size: number | null; hide: boolean }> {
  if (!isLink) return { kind: isDir ? "dir" : "file", size: isDir ? null : await stat(full).then((row) => row.size, () => null), hide: false };
  try {
    const target = await realpath(full);
    if (!within(real, target)) return { kind: "link", size: null, hide: false };
    const inner = relative(real, target).split(sep).join("/");
    if (inner && refusedPath(inner)) return { kind: "link", size: null, hide: true };
    const info = await stat(target);
    return { kind: info.isDirectory() ? "dir" : "file", size: info.isDirectory() ? null : info.size, hide: false };
  } catch {
    return { kind: "link", size: null, hide: false };
  }
}

/** One folder's entries: folders first, then files, by name. Git's folder and secrets are left out. */
export async function listFolder(root: string, input = ""): Promise<FolderListing> {
  const path = folderPath(input);
  const refused = path ? refusedPath(path) : null;
  if (refused) throw new GuardError(refused);
  const { real, full } = await resolveInside(root, path);
  if (!(await stat(full)).isDirectory()) throw new GuardError(`${path || "."} is not a folder.`);
  const dirents = await readdir(full, { withFileTypes: true });
  let hidden = 0;
  const entries: FolderEntry[] = [];
  for (const dirent of dirents) {
    const name = matchName(dirent.name);
    if (name === ".git" || SECRET_FOLDER.has(name) || (!dirent.isDirectory() && SECRET_NAME.test(name))) {
      hidden += 1;
      continue;
    }
    const kind = await entryKind(real, join(full, dirent.name), dirent.isSymbolicLink(), dirent.isDirectory());
    if (kind.hide) {
      hidden += 1;
      continue;
    }
    entries.push({ name: dirent.name, kind: kind.kind, size: kind.size });
  }
  entries.sort((a, b) => ((a.kind === "dir") === (b.kind === "dir") ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
  return { path, entries: entries.slice(0, FOLDER_ENTRIES_MAX), truncated: entries.length > FOLDER_ENTRIES_MAX, hidden };
}

/** One file's text (its first `max` bytes), or `binary` with no content. */
export async function readFolderFile(root: string, input: string, max = FILE_VIEW_BYTES): Promise<FolderFile> {
  const path = folderPath(input);
  if (!path) throw new GuardError("Which file?");
  const refused = refusedPath(path);
  if (refused) throw new GuardError(refused);
  const { real, full } = await resolveInside(root, path);
  const info = await stat(full);
  if (!info.isFile()) throw new GuardError(`${path} is not a file.`);
  if (info.nlink > 1) throw new GuardError("A file with more than one name (a hard link) is not shown.");
  const handle = await open(full, "r");
  try {
    // The file opened is the one checked: a folder swapped for a link in between is caught here.
    const opened = await handle.stat();
    const again = await realpath(full).catch(() => "");
    const now = again && within(real, again) ? await lstat(again).catch(() => null) : null;
    if (!now || now.ino !== opened.ino || now.dev !== opened.dev || !opened.isFile() || opened.nlink > 1) {
      throw new GuardError("That file changed while it was being read. Try again.");
    }
    const length = Math.min(opened.size, max);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.subarray(0, 8000).includes(0)) return { path, size: opened.size, content: null, binary: true, truncated: false };
    return { path, size: opened.size, content: redactText(bytes.toString("utf8")), binary: false, truncated: opened.size > max };
  } finally {
    await handle.close();
  }
}

/** How a run lists a file it changed outside its folder: `~/…` in the home folder, or a full path. */
export function outsideListing(path: string): boolean {
  return path.startsWith("~/") || path.startsWith("/");
}

/** The paths a run's evidence lists as changed. */
export function listedChanges(evidence: unknown): string[] {
  const files = evidence && typeof evidence === "object" && Array.isArray((evidence as { files?: unknown }).files) ? (evidence as { files: Array<{ path?: unknown }> }).files : [];
  return files.map((file) => file.path).filter((path): path is string => typeof path === "string" && path.length > 0);
}

/**
 * A file the run changed: inside its folder by the folder's rules, or outside it (`~/…`) only when
 * the run's own evidence lists that exact path, the outside floor allows reading it (no keys,
 * sign-ins or another account) and it passes the same file rules as a file in the folder.
 */
export async function readChangedFile(root: string, listed: string[], path: string, max = FILE_VIEW_BYTES, home = homedir()): Promise<FolderFile> {
  if (!outsideListing(path)) return readFolderFile(root, path, max);
  if (!listed.includes(path)) throw new GuardError("That file is outside the task's folder and is not one this run changed.");
  if (path.split(/[\\/]/).some((part) => part === "..")) throw new GuardError("That is outside the task's folder.");
  const full = path.startsWith("~/") ? join(home, path.slice(2)) : path;
  const real = await realpath(full).catch(() => full);
  const named = within(home, real, false) ? relative(home, real).split(sep).join("/") : basename(real);
  const refused = refusedPath(named) ?? outsideRefusal(real, false, home);
  if (refused) throw new GuardError(refused);
  const read = await readFolderFile(dirname(real), basename(real), max);
  return { ...read, path };
}
