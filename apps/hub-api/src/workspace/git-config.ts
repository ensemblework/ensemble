/**
 * A repository's own git settings, read the way git reads them but without running anything: no git process, no
 * include followed. Both judges' git reads use it (workspace/tools.ts `gitReadSafeAt` and `gitConfigSafe`): a
 * `git status`, `diff` or `log` in a repository whose settings or hooks name a program would run that program, and so
 * would one with a populated submodule (git runs `git status` inside it, with that repository's own settings).
 *
 * The repository is found as git finds it (setup.c): the real folder, walking up past a `.git` that is not a git
 * folder, `commondir` followed. Wherever git's rules leave a doubt, or a file cannot be read plainly (not a regular
 * file, too big), the answer is "not safe": the judge then asks.
 */
import { constants } from "node:fs";
import { access, lstat, open, readdir, readlink, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

/** A setting by its dotted name, with its value; `literal` when the value had no quotes or escapes. */
export type GitSetting = { name: string; value: string; literal: boolean };

/** The most a file of a repository's settings may hold; a bigger one is not read and the repository is not safe. */
const MAX_FILE = 1_000_000;
/** The most an index may hold to be read for submodules (a few hundred thousand files); a bigger one is not safe. */
const MAX_INDEX = 64_000_000;
/** More hooks or submodules than this are not looked through: not safe. */
const MAX_ENTRIES = 1_000;

const NAME_START = /[A-Za-z]/;
const NAME_CHAR = /[A-Za-z0-9-]/;
const SECTION_CHAR = /[A-Za-z0-9.-]/;

/**
 * The settings of one git config file as dotted names (`core.pager`, `filter.lfs.clean`, `diff.x.command`; section and
 * name lower-cased, a quoted subsection as written) with their values; null when the text is not a config git would
 * read, which callers take as unsafe.
 */
export function parseGitConfig(text: string): GitSetting[] | null {
  const out: GitSetting[] = [];
  let section: string | null = null;
  let at = 0;
  const lineEnd = () => {
    const end = text.indexOf("\n", at);
    at = end < 0 ? text.length : end + 1;
  };
  while (at < text.length) {
    const char = text[at]!;
    if (char === " " || char === "\t" || char === "\r" || char === "\n") {
      at += 1;
    } else if (char === "#" || char === ";") {
      lineEnd();
    } else if (char === "[") {
      at += 1;
      let name = "";
      while (at < text.length && SECTION_CHAR.test(text[at]!)) name += text[at++]!;
      if (!name) return null;
      while (text[at] === " " || text[at] === "\t") at += 1;
      if (text[at] === '"') {
        at += 1;
        let sub = "";
        for (;;) {
          const next = text[at];
          if (next === undefined || next === "\n") return null;
          at += 1;
          if (next === '"') break;
          sub += next === "\\" ? (text[at++] ?? "") : next;
        }
        if (text[at] !== "]") return null;
        section = `${name.toLowerCase()}.${sub}`;
      } else {
        if (text[at] !== "]") return null;
        section = name.toLowerCase();
      }
      at += 1;
    } else if (NAME_START.test(char)) {
      if (section === null) return null;
      let key = "";
      while (at < text.length && NAME_CHAR.test(text[at]!)) key += text[at++]!;
      while (text[at] === " " || text[at] === "\t") at += 1;
      let value = "true";
      let literal = true;
      if (text[at] === "=") {
        at += 1;
        const parsed = readValue(text, at);
        if (!parsed) return null;
        ({ value, literal } = parsed);
        at = parsed.end;
      } else if (at < text.length && !"\r\n#;".includes(text[at]!)) return null;
      out.push({ name: `${section}.${key.toLowerCase()}`, value, literal });
    } else return null;
  }
  return out;
}

/** A value from `start` to the end of its line: quotes, escapes and a `\` at the end of a line that joins the next. */
function readValue(text: string, start: number): { value: string; end: number; literal: boolean } | null {
  let value = "";
  let literal = true;
  let quoted = false;
  let spaces = "";
  let at = start;
  while (at < text.length && (text[at] === " " || text[at] === "\t")) at += 1;
  for (; at < text.length; at += 1) {
    const char = text[at]!;
    // git reads "\r\n" as the end of the line; a lone "\r" is a space to it.
    const lineEnds = char === "\n" || (char === "\r" && text[at + 1] === "\n");
    if (lineEnds && !quoted) {
      if (char === "\r") at += 1;
      break;
    }
    if (lineEnds) return null;
    if ((char === "#" || char === ";") && !quoted) {
      while (at < text.length && text[at] !== "\n") at += 1;
      break;
    }
    if (char === " " || char === "\t" || char === "\r") {
      if (char === "\r") literal = false;
      if (quoted) value += char;
      else if (value) spaces += char;
      continue;
    }
    value += spaces;
    spaces = "";
    if (char === '"') {
      literal = false;
      quoted = !quoted;
      continue;
    }
    if (char === "\\") {
      literal = false;
      const next = text[at + 1];
      at += 1;
      if (next === "\n") continue;
      if (next === "\r" && text[at + 1] === "\n") {
        at += 1;
        continue;
      }
      if (next === "n") value += "\n";
      else if (next === "t") value += "\t";
      else if (next === "b") value += "\b";
      else if (next === '"' || next === "\\") value += next;
      else return null;
      continue;
    }
    value += char;
  }
  if (quoted) return null;
  return { value, end: at, literal };
}

const PROGRAM_NAMES = new Set([
  "core.pager", "core.sshcommand", "core.hookspath", "core.alternaterefscommand", "core.editor", "core.askpass", "core.gitproxy", "sequence.editor",
  "uploadpack.packobjectshook", "interactive.difffilter", "web.browser", "diff.external", "gpg.program", "credential.helper",
  // Not programs, but they move the work tree (whose submodules this check would not see), print a line of any file
  // (`fatal: invalid object name: <the file's first line>`), or fetch missing objects from a remote during a read.
  "core.worktree", "blame.ignorerevsfile", "extensions.partialclone",
]);

/** Settings that are safe only with one of these values, written plainly (no quotes or escapes): anything else may start a program. */
const SAFE_ONLY_AS: Readonly<Record<string, RegExp>> = {
  // Any other value names a hook (escapes git keeps as bytes included).
  "core.fsmonitor": /^(false|no|off|0)$/i,
  // `diff` runs `git diff` inside each submodule, with that repository's settings.
  "diff.submodule": /^(short|log)$/,
  // `git status` runs `git submodule summary`.
  "status.submodulesummary": /^(false|no|off|0)$/i,
  // Checking signatures runs gpg or ssh-keygen.
  "log.showsignature": /^(false|no|off|0)$/i,
};

/**
 * Whether a setting names a program git may run, or brings in settings no static read can judge: filters, diff drivers'
 * commands and text conversion, merge drivers, gpg and credential programs, fsmonitor, pagers, editors, ssh, hooks
 * elsewhere or in settings, aliases, includes, submodule diffs and summaries, signature checks, lazy fetches.
 */
export function startsProgram(setting: GitSetting): boolean {
  const name = setting.name.toLowerCase();
  if (PROGRAM_NAMES.has(name)) return true;
  const only = SAFE_ONLY_AS[name];
  if (only) return !(setting.literal && only.test(setting.value));
  if (/^remote\..+\.promisor$/.test(name)) return !(setting.literal && /^(false|no|off|0)$/i.test(setting.value));
  if (/^(filter|alias|pager|include|includeif|hook)\./.test(name) || /^trailer\..+\.(command|cmd)$/.test(name)) return true;
  if (/^diff\..+\.(command|textconv)$/.test(name) || /^merge\..+\.driver$/.test(name) || /^gpg\..+\.program$/.test(name) || /^credential\..+\.helper$/.test(name)) return true;
  if (/^(difftool|mergetool|man|browser|instaweb)\..+\.(cmd|path)$/.test(name) || /^remote\..+\.(uploadpack|receivepack|vcs)$/.test(name)) return true;
  return /^submodule\..+\.update$/.test(name) && setting.value.trim().startsWith("!");
}

const OPEN_PLAIN = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOCTTY ?? 0);

/**
 * A file's bytes, read only when it is a regular file (never a FIFO, a device or a socket; opening never waits): up to
 * `max`, or null past that unless `partial` (then its first `max` bytes). undefined when there is none; null when it
 * cannot be read that way, which a caller takes as unsafe.
 */
async function readPlain(file: string, max = MAX_FILE, partial = false): Promise<Buffer | null | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file, OPEN_PLAIN);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null;
  }
  try {
    if (!(await handle.stat()).isFile()) return null;
    // The size a file reports is not trusted (some report 0): read until the end, or one byte past `max`.
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(65_536, max + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
      if (total > max) {
        if (!partial) return null;
        break;
      }
    }
    return Buffer.concat(chunks).subarray(0, max);
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** A config file's settings; [] when there is none, null when it cannot be read or parsed. */
async function settingsIn(file: string): Promise<GitSetting[] | null> {
  const bytes = await readPlain(file);
  if (bytes === undefined) return [];
  return bytes === null ? null : parseGitConfig(bytes.toString("utf8"));
}

/** A hook git could run there: any file in the hooks folder but the `.sample` ones (executable on a system with modes). */
async function hasHooks(folder: string): Promise<boolean> {
  const entries = await readdir(folder).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? [] : null));
  if (entries === null || entries.length > MAX_ENTRIES) return true;
  for (const entry of entries) {
    if (entry.endsWith(".sample")) continue;
    const info = await stat(join(folder, entry)).catch(() => null);
    if (!info || info.isDirectory()) continue;
    if (!info.isFile() || process.platform === "win32" || (info.mode & 0o111) !== 0) return true;
  }
  return false;
}

/**
 * The folder a git folder shares its settings, hooks, objects and refs with: the one its `commondir` file names (a
 * linked worktree's), as git reads it (only line ends trimmed, relative to the git folder, links followed); the git
 * folder itself when there is none; null when the file cannot be read plainly or names nothing that exists.
 */
async function commonDir(gitDir: string): Promise<string | null> {
  const named = await readPlain(join(gitDir, "commondir"), 4_096);
  if (named === undefined) return gitDir;
  if (named === null) return null;
  const path = named.toString("utf8").replace(/[\r\n]+$/, "");
  if (!path || path.includes("\0") || path.includes("\ufffd")) return null;
  return realpath(isAbsolute(path) ? path : `${gitDir}/${path}`).catch(() => null);
}

/**
 * A folder as git's discovery sees it (setup.c `is_git_directory`): `git` with a valid `HEAD` (a link into `refs/`,
 * `ref: refs/…` or an object id) and `objects` and `refs` in its common folder; `not` without a valid `HEAD`, which git
 * passes; `unsure` for anything this check cannot read as git does, which callers take as unsafe.
 */
export async function gitDirState(folder: string): Promise<"git" | "not" | "unsure"> {
  const headFile = join(folder, "HEAD");
  const head = await lstat(headFile).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" || error.code === "ENOTDIR" ? undefined : null));
  if (head === undefined) return "not";
  if (head === null || head.isDirectory()) return "unsure";
  let valid: boolean;
  if (head.isSymbolicLink()) {
    const target = await readlink(headFile, { encoding: "buffer" }).catch(() => null);
    if (!target) return "unsure";
    valid = target.subarray(0, 5).toString("latin1") === "refs/";
  } else {
    const start = await readPlain(headFile, 255, true);
    if (!start) return "unsure";
    // git's own spaces (`isspace`: no vertical tab or form feed), and an object id's hex digits at the start.
    const text = start.toString("latin1");
    valid = /^ref:[ \t\n\r]*refs\//.test(text) || /^[0-9a-fA-F]{40}/.test(text);
  }
  if (!valid) return "not";
  const common = await commonDir(folder);
  if (common === null) return "unsure";
  const reachable = async (name: string) => access(join(common, name), constants.X_OK).then(() => true, () => false);
  return (await reachable("objects")) && (await reachable("refs")) ? "git" : "unsure";
}

/** Whether a folder is itself a git folder by git's own rules (`gitDirState`). */
export async function isGitDir(folder: string): Promise<boolean> {
  return (await gitDirState(folder)) === "git";
}

/** A repository a git command uses: its git folder, and its work tree (none for a bare one). */
export type Repository = { gitDir: string; workTree: string | null };

/**
 * The repository git uses for a command run in `start`, found as setup.c finds it without `GIT_DIR`: from the real
 * folder upward, a `.git` folder that is a git folder, else the folder itself when it is one (bare); a `.git` that is
 * not one is passed, as git passes it. null: none (git reads no repository's settings). "unsure": a `.git` file (a
 * linked worktree or submodule, not followed here), a folder git's rules leave unclear, or the walk left `inside`.
 */
export async function discoverRepository(start: string, inside: (dir: string) => boolean = () => true): Promise<Repository | null | "unsure"> {
  let dir = await realpath(start).catch(() => null);
  if (dir === null) return "unsure";
  for (;;) {
    if (!inside(dir)) return "unsure";
    const dotGit = join(dir, ".git");
    const info = await stat(dotGit).catch(() => null);
    if (info?.isFile()) return "unsure";
    if (info) {
      const state = await gitDirState(dotGit);
      if (state === "git") return { gitDir: dotGit, workTree: dir };
      if (state === "unsure") return "unsure";
    }
    const bare = await gitDirState(dir);
    if (bare === "git") return { gitDir: dir, workTree: null };
    if (bare === "unsure") return "unsure";
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The object id size an index of this repository uses (`extensions.objectFormat`); null when git would not read it as SHA-1 or SHA-256 plainly. */
function hashSize(settings: readonly GitSetting[]): number | null {
  const format = settings.filter((setting) => setting.name === "extensions.objectformat").pop();
  if (!format) return 20;
  const version = settings.filter((setting) => setting.name === "core.repositoryformatversion").pop();
  if (!format.literal || version?.value !== "1") return null;
  return format.value === "sha256" ? 32 : format.value === "sha1" ? 20 : null;
}

/**
 * The paths an index lists as submodules (gitlinks, mode 160000), read as git's read-cache.c reads it: versions 2 to 4,
 * prefix-compressed names in 4. null when it is not one this can follow as git would: a split index (entries in
 * another file), an end-of-entries record (git may then load entries from offsets of its own), or a malformed one.
 */
export function indexGitlinks(data: Buffer, hash: number): Buffer[] | null {
  if (data.length < 12 + hash || data.toString("latin1", 0, 4) !== "DIRC") return null;
  const version = data.readUInt32BE(4);
  if (version < 2 || version > 4) return null;
  const count = data.readUInt32BE(8);
  const end = data.length - hash;
  const eoie = end - 12 - hash;
  if (eoie >= 12 && data.toString("latin1", eoie, eoie + 4) === "EOIE") return null;
  const links: Buffer[] = [];
  let previous: Buffer = Buffer.alloc(0);
  let at = 12;
  for (let entry = 0; entry < count; entry += 1) {
    const start = at;
    if (at + 40 + hash + 2 > end) return null;
    const mode = data.readUInt32BE(at + 24);
    const flags = data.readUInt16BE(at + 40 + hash);
    at += 40 + hash + 2;
    if (flags & 0x4000) {
      if (version < 3) return null;
      at += 2;
    }
    let length = flags & 0x0fff;
    let name: Buffer;
    if (version === 4) {
      // The number of bytes of the previous name to drop (git's offset varint), then the rest of this one.
      let byte = data[at++];
      if (byte === undefined) return null;
      let strip = byte & 127;
      while (byte & 128) {
        byte = data[at++];
        if (byte === undefined || strip > 0xffffff) return null;
        strip = (strip + 1) * 128 + (byte & 127);
      }
      if (strip > previous.length) return null;
      const kept = previous.length - strip;
      if (length === 0x0fff) {
        const nul = data.indexOf(0, at);
        if (nul < 0 || nul >= end) return null;
        length = nul - at + kept;
      }
      const rest = length - kept;
      if (rest < 0 || at + rest + 1 > end) return null;
      name = Buffer.concat([previous.subarray(0, kept), data.subarray(at, at + rest)]);
      at += rest + 1;
    } else {
      if (length === 0x0fff) {
        const nul = data.indexOf(0, at);
        if (nul < 0 || nul >= end) return null;
        length = nul - at;
      }
      if (at + length > end) return null;
      name = data.subarray(at, at + length);
      at = start + ((at - start + length + 8) & ~7);
      if (at > end) return null;
    }
    previous = name;
    if ((mode & 0o170000) === 0o160000) links.push(name);
  }
  while (at + 8 <= end) {
    if (data.toString("latin1", at, at + 4) === "link") return null;
    at += 8 + data.readUInt32BE(at + 4);
  }
  return links;
}

/**
 * Whether git status and diff in this work tree stay out of submodules: no path that its index lists as a submodule
 * (or its `.gitmodules` names) holds a `.git`, since git runs `git status` there with that repository's settings and
 * hooks. Anything unreadable, a path that leaves the tree, or more than a thousand submodules: not safe.
 */
async function submodulesSafe(workTree: string, gitDir: string, hash: number | null): Promise<boolean> {
  const paths: Buffer[] = [];
  const listed = await readPlain(join(workTree, ".gitmodules"));
  if (listed === null) return false;
  if (listed) {
    const settings = parseGitConfig(listed.toString("utf8"));
    if (!settings) return false;
    for (const setting of settings) if (/^submodule\..+\.path$/.test(setting.name.toLowerCase())) paths.push(Buffer.from(setting.value, "utf8"));
  }
  const index = await readPlain(join(gitDir, "index"), MAX_INDEX);
  if (index === null) return false;
  if (index) {
    const links = hash === null ? null : indexGitlinks(index, hash);
    if (!links) return false;
    paths.push(...links);
  }
  if (paths.length > MAX_ENTRIES) return false;
  for (const path of paths) {
    const text = path.toString("utf8");
    if (!text || !Buffer.from(text, "utf8").equals(path) || text.includes("\0") || isAbsolute(text) || text.split(/[\\/]/).includes("..")) return false;
    const populated = await lstat(join(workTree, text, ".git")).then(
      () => true,
      (error: NodeJS.ErrnoException) => error.code !== "ENOENT" && error.code !== "ENOTDIR",
    );
    if (populated) return false;
  }
  return true;
}

/**
 * Whether a read in this repository starts no program of the repository's: the settings git reads there (`config`
 * and `config.worktree`, in the git folder and in the one its `commondir` names) name none (`startsProgram`), no hooks
 * folder of theirs holds a hook (`post-index-change` runs when a read refreshes the index), and no submodule is
 * populated in its work tree (`submodulesSafe`). Anything that cannot be read plainly is not safe.
 */
export async function repositorySafe(gitDir: string, workTree: string | null): Promise<boolean> {
  const common = await commonDir(gitDir);
  if (common === null) return false;
  const settings: GitSetting[] = [];
  for (const folder of common === gitDir ? [gitDir] : [common, gitDir]) {
    for (const file of ["config", "config.worktree"]) {
      const found = await settingsIn(join(folder, file));
      if (found === null || found.some(startsProgram)) return false;
      settings.push(...found);
    }
    if (await hasHooks(join(folder, "hooks"))) return false;
  }
  return workTree === null || submodulesSafe(workTree, gitDir, hashSize(settings));
}

/** `repositorySafe` for a git folder with no work tree to look in (a bare repository, or one named by `--git-dir` alone). */
export async function gitDirSafe(gitDir: string): Promise<boolean> {
  return repositorySafe(gitDir, null);
}
