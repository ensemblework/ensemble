/**
 * `git clone` as Ensemble runs it for an agent. Claude Code's sandbox does not let git write
 * `.git/config` or `.git/hooks` anywhere under the run folder, so a clone inside it always fails;
 * loosening that rule would let any script in the run plant a hook or a config key that runs later
 * outside the sandbox. Instead Ensemble clones: a public https repository, no credentials, no
 * hooks (`--template=`), into a new folder inside the run folder. This file is the parsing and the
 * rules; `cloneForAgent` in tools.ts runs it.
 */
import { basename } from "node:path";

/** Flags that change only what is fetched, with the values they may take. */
const VALUE_FLAGS: Record<string, RegExp> = {
  "--depth": /^\d{1,6}$/,
  "--branch": /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/,
  "-b": /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/,
  "--filter": /^(blob:none|tree:0|blob:limit=\d{1,9}[kmg]?)$/,
  "--shallow-since": /^[\w:.-]{1,40}$/,
};
const BARE_FLAGS = new Set(["--single-branch", "--no-single-branch", "-q", "--quiet", "--no-tags", "--progress", "--no-checkout", "-n"]);
const ALLOWED = "--depth, --branch, --single-branch, --filter, --no-tags, --quiet";

export type ClonePlan = { url: string; dest: string; flags: string[] };

/** A clone source Ensemble fetches without credentials: https only, no user, query or fragment. */
export function publicHttpsUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port) return null;
  if (!url.hostname.includes(".") || !/^[a-z0-9.-]+$/i.test(url.hostname)) return null;
  if (!/^\/[\w.@~/-]+$/.test(url.pathname) || url.pathname.split("/").some((part) => part === "..")) return null;
  return url.toString();
}

/** The folder git would clone into: the repository's name without `.git`. */
export function defaultCloneFolder(url: string): string | null {
  const name = basename(new URL(url).pathname.replace(/\/+$/, "")).replace(/\.git$/, "");
  return /^[\w.-]+$/.test(name) && name !== "." && name !== ".." ? name : null;
}

/** The git subcommand of an argv (`git [--no-pager] <sub>`), or null. */
export function gitSubcommand(argv: string[]): string | null {
  const program = argv[0] ?? "";
  if (program !== "git" && !program.endsWith("/git")) return null;
  let index = 1;
  while (argv[index] === "--no-pager") index += 1;
  return argv[index] ?? null;
}

/** Shell redirections around a command (`> log`, `2>&1`); they decide nothing about the clone. */
function redirection(token: string): "alone" | "joined" | null {
  if (/^(\d*>{1,2}|\d*<|&>)$/.test(token)) return "alone";
  if (/^(\d*>{1,2}|&>)\S+$/.test(token) || /^\d*>&\d+$/.test(token)) return "joined";
  return null;
}

/**
 * `git clone …` as Ensemble will run it, or why not. Only flags that change what is fetched are
 * kept; anything that runs a program (`--upload-pack`, `-c`, `--config`, `--template`) or reaches
 * further (`--recurse-submodules`, `--reference`, `--separate-git-dir`) is refused.
 */
export function parseClone(argv: string[]): ClonePlan | { error: string } {
  let index = 1;
  while (argv[index] === "--no-pager") index += 1;
  if (argv[index] !== "clone") return { error: "Not a git clone." };
  const args = argv.slice(index + 1);
  const flags: string[] = [];
  const positional: string[] = [];
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at]!;
    const redirect = redirection(arg);
    if (redirect) {
      if (redirect === "alone") at += 1;
      continue;
    }
    if (arg === "--") {
      positional.push(...args.slice(at + 1));
      break;
    }
    if (arg.startsWith("-")) {
      const [name, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, null];
      if (BARE_FLAGS.has(arg)) {
        flags.push(arg);
        continue;
      }
      const rule = VALUE_FLAGS[name!];
      if (!rule) return { error: `git clone ${name} is not allowed here. Ensemble clones with ${ALLOWED} only.` };
      const value = inline ?? args[++at];
      if (value == null || !rule.test(value)) return { error: `git clone ${name} needs a plain value.` };
      flags.push(name === "-b" ? "--branch" : name!, value);
      continue;
    }
    positional.push(arg);
  }
  if (!positional.length) return { error: "Which repository? Run git clone <https URL> [folder]." };
  if (positional.length > 2) return { error: "Run git clone <https URL> [folder], one repository at a time." };
  const url = publicHttpsUrl(positional[0]!);
  if (!url) return { error: `${positional[0]} is not a public https URL. Ensemble clones https://… repositories without credentials (no ssh, no file paths).` };
  const dest = positional[1] ?? defaultCloneFolder(url);
  if (!dest) return { error: "Name the folder to clone into: git clone <https URL> <folder>." };
  return { url, dest, flags };
}
