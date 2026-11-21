/**
 * A repository's own git settings, read the way git reads them but without running anything: no git process, no
 * include followed. Both judges' git reads use it (workspace/tools.ts `gitReadSafeAt` and `gitConfigSafe`): a
 * `git status`, `diff` or `log` in a repository whose settings or hooks name a program would run that program.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export type GitSetting = { name: string; value: string };

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
      if (text[at] === "=") {
        at += 1;
        const parsed = readValue(text, at);
        if (!parsed) return null;
        value = parsed.value;
        at = parsed.end;
      } else if (at < text.length && !"\r\n#;".includes(text[at]!)) return null;
      out.push({ name: `${section}.${key.toLowerCase()}`, value });
    } else return null;
  }
  return out;
}

/** A value from `start` to the end of its line: quotes, escapes and a `\` at the end of a line that joins the next. */
function readValue(text: string, start: number): { value: string; end: number } | null {
  let value = "";
  let quoted = false;
  let spaces = "";
  let at = start;
  while (at < text.length && (text[at] === " " || text[at] === "\t")) at += 1;
  for (; at < text.length; at += 1) {
    const char = text[at]!;
    if (char === "\n" && !quoted) break;
    if (char === "\n") return null;
    if ((char === "#" || char === ";") && !quoted) {
      while (at < text.length && text[at] !== "\n") at += 1;
      break;
    }
    if (char === " " || char === "\t") {
      if (quoted) value += char;
      else spaces += char;
      continue;
    }
    if (char === "\r" && !quoted) continue;
    value += spaces;
    spaces = "";
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "\\") {
      const next = text[at + 1];
      at += 1;
      if (next === "\n") continue;
      if (next === "\r" && text[at + 1] === "\n") {
        at += 1;
        continue;
      }
      if (next === "n") value += "\n";
      else if (next === "t") value += "\t";
      else if (next === "b") value = value.slice(0, -1);
      else if (next === '"' || next === "\\") value += next;
      else return null;
      continue;
    }
    value += char;
  }
  if (quoted) return null;
  return { value, end: at };
}

const PROGRAM_NAMES = new Set([
  "core.pager", "core.sshcommand", "core.hookspath", "core.alternaterefscommand", "core.editor", "core.askpass", "core.gitproxy", "sequence.editor",
  "uploadpack.packobjectshook", "interactive.difffilter", "web.browser", "diff.external", "gpg.program", "credential.helper",
]);

/**
 * Whether a setting names a program git may run, or brings in settings no static read can judge: filters, diff drivers'
 * commands and text conversion, merge drivers, gpg and credential programs, fsmonitor, pagers, editors, ssh, hooks
 * elsewhere, aliases and includes.
 */
export function startsProgram(setting: GitSetting): boolean {
  const name = setting.name.toLowerCase();
  if (PROGRAM_NAMES.has(name)) return true;
  if (name === "core.fsmonitor") return !/^(false|no|off|0|)$/i.test(setting.value.trim());
  if (/^(filter|alias|pager|include|includeif)\./.test(name)) return true;
  if (/^diff\..+\.(command|textconv)$/.test(name) || /^merge\..+\.driver$/.test(name) || /^gpg\..+\.program$/.test(name) || /^credential\..+\.helper$/.test(name)) return true;
  if (/^(difftool|mergetool|man|browser|instaweb)\..+\.(cmd|path)$/.test(name) || /^remote\..+\.(uploadpack|receivepack|vcs)$/.test(name)) return true;
  return /^submodule\..+\.update$/.test(name) && setting.value.trim().startsWith("!");
}

/** A config file's settings; [] when there is none, null when it cannot be read or parsed. */
async function settingsIn(file: string): Promise<GitSetting[] | null> {
  const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? "" : null));
  return text === null ? null : parseGitConfig(text);
}

/** A hook git could run there: any file in the hooks folder but the `.sample` ones (executable on a system with modes). */
async function hasHooks(folder: string): Promise<boolean> {
  const entries = await readdir(folder).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? [] : null));
  if (entries === null) return true;
  for (const entry of entries) {
    if (entry.endsWith(".sample")) continue;
    const info = await stat(join(folder, entry)).catch(() => null);
    if (info?.isFile() && (process.platform === "win32" || (info.mode & 0o111) !== 0)) return true;
  }
  return false;
}

/**
 * Whether a read in the repository whose git folder is `gitDir` (its `.git`, or a bare repository itself) starts no
 * program of the repository's: its config, and `config.worktree` when `extensions.worktreeConfig` is on, name none
 * (`startsProgram`), and its hooks folder holds no hook (`post-index-change` runs when a read refreshes the index).
 */
export async function gitDirSafe(gitDir: string): Promise<boolean> {
  const main = await settingsIn(join(gitDir, "config"));
  if (main === null) return false;
  let settings = main;
  if (main.some((setting) => setting.name === "extensions.worktreeconfig" && /^(true|yes|on|1)$/i.test(setting.value.trim()))) {
    const worktree = await settingsIn(join(gitDir, "config.worktree"));
    if (worktree === null) return false;
    settings = [...main, ...worktree];
  }
  if (settings.some(startsProgram)) return false;
  return !(await hasHooks(join(gitDir, "hooks")));
}

/** Whether a folder is itself a git folder (a bare repository, or inside `.git`): `HEAD`, `objects` and `refs` there. */
export async function isGitDir(folder: string): Promise<boolean> {
  const [head, objects, refs] = await Promise.all(["HEAD", "objects", "refs"].map((name) => stat(join(folder, name)).catch(() => null)));
  return Boolean(head?.isFile() && objects?.isDirectory() && refs?.isDirectory());
}
