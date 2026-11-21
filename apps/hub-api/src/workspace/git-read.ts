/**
 * Whether a git command only reads: the one test both judges use, the node's own-tools judge
 * (subscriptions/node-own-tools.ts `commandNeeds`) and a coding run's (`readsOnly` and `quietRead` in
 * workspace/tools.ts, through engines/judge.ts `quietCommand`), so they cannot drift.
 *
 * An allowlist. The global options that only say where git looks; the read subcommands; for each, the
 * options known to be safe. A long option is matched the way git matches it, by a unique prefix, against
 * every option of that subcommand listed here, the unsafe ones included: an unknown, ambiguous or unsafe
 * option is not a read. Never a read: a `VAR=value` in front (`GIT_EXTERNAL_DIFF`, `GIT_CONFIG_COUNT`,
 * `GIT_SSH_COMMAND`: the shell segment's `assigned`), `-c`, `--config-env`, `--exec-path`, a pager,
 * `-O`/`--open-files-in-pager`, `--ext-diff`, `--textconv`, `--upload-pack`, `--receive-pack`, `--exec`,
 * `--output`, `--edit`/`-e`, `ls-remote` and `fetch` (they reach a remote and run its helpers), and any
 * config write. What a read finds in a repository's own config (a pager, fsmonitor, a diff driver) is the
 * callers' check (workspace/tools.ts `gitConfigSafe`).
 */
import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * A safe long option: a flag, one that takes a value (`--x=v` or `--x v`), one whose value is optional (`--x[=v]` only),
 * or one that takes the next word when there is one that is not an option (`--merged [<commit>]`, as git's last-argument default).
 */
type Kind = "flag" | "value" | "optional" | "next";

type Spec = {
  safe: Readonly<Record<string, Kind>>;
  /** Long options that start a program, write, reach a remote or edit; with `safe`, every option an abbreviation is matched against. */
  unsafe?: readonly string[];
  /** Short flags; those that take a value (attached, `-n5`, or the next word); those whose value can only be attached (`-uno`). */
  short?: string;
  shortValue?: string;
  shortOptional?: string;
  /** Short options that are never a read here (`-O`, `-e`, `-d`). */
  shortUnsafe?: string;
  /** What the words after the options may be (a listing's patterns), given the options seen. */
  words?: (words: readonly string[], seen: ReadonlySet<string>) => boolean;
};

const UNSAFE_EVERYWHERE = ["ext-diff", "textconv", "output", "open-files-in-pager", "exec", "upload-pack", "receive-pack", "edit", "show-signature"];

const flags = (...names: string[]): Record<string, Kind> => Object.fromEntries(names.map((name) => [name, "flag" as const]));
const values = (...names: string[]): Record<string, Kind> => Object.fromEntries(names.map((name) => [name, "value" as const]));
const optional = (...names: string[]): Record<string, Kind> => Object.fromEntries(names.map((name) => [name, "optional" as const]));
const nexts = (...names: string[]): Record<string, Kind> => Object.fromEntries(names.map((name) => [name, "next" as const]));

/** What `git diff`, `log`, `show` and the like print, and how they compare: nothing here runs a program or writes. */
const DIFF: Record<string, Kind> = {
  ...flags(
    "patch", "no-patch", "raw", "patch-with-raw", "patch-with-stat", "shortstat", "numstat", "summary", "name-only", "name-status", "compact-summary",
    "full-index", "binary", "no-abbrev", "minimal", "patience", "histogram", "no-renames", "rename-empty", "no-rename-empty", "find-copies-harder",
    "irreversible-delete", "ignore-space-change", "ignore-all-space", "ignore-blank-lines", "ignore-space-at-eol", "ignore-cr-at-eol", "no-color",
    "no-color-moved", "exit-code", "quiet", "check", "function-context", "text", "no-prefix", "default-prefix", "ita-invisible-in-index",
    "ita-visible-in-index", "no-relative", "pickaxe-all", "pickaxe-regex", "no-ext-diff", "no-textconv", "cc", "combined-all-paths", "no-indent-heuristic",
    "indent-heuristic", "no-stat", "remerge-diff", "dd", "no-diff-merges", "full-diff",
  ),
  ...values(
    "diff-algorithm", "anchored", "unified", "src-prefix", "dst-prefix", "line-prefix", "word-diff-regex", "diff-filter", "find-object", "ws-error-highlight",
    "output-indicator-new", "output-indicator-old", "output-indicator-context", "inter-hunk-context", "stat-width", "stat-name-width", "stat-graph-width",
    "stat-count", "skip-to", "rotate-to", "diff-merges", "color-moved-ws",
  ),
  ...optional("stat", "dirstat", "relative", "abbrev", "find-renames", "find-copies", "break-rewrites", "word-diff", "color", "color-words", "color-moved", "submodule", "ignore-submodules"),
};

/** Which commits `git log`, `show`, `shortlog` and `rev-list` walk, and how they print them. */
const REVS: Record<string, Kind> = {
  ...DIFF,
  ...flags(
    "oneline", "graph", "no-decorate", "abbrev-commit", "no-abbrev-commit", "all", "first-parent", "merges", "no-merges", "reverse", "date-order",
    "author-date-order", "topo-order", "follow", "no-follow", "relative-date", "all-match", "invert-grep", "regexp-ignore-case", "basic-regexp",
    "extended-regexp", "fixed-strings", "perl-regexp", "no-min-parents", "no-max-parents", "simplify-by-decoration", "simplify-merges", "full-history",
    "dense", "sparse", "show-pulls", "left-right", "left-only", "right-only", "cherry", "cherry-mark", "cherry-pick", "boundary", "source", "use-mailmap",
    "mailmap", "no-mailmap", "log-size", "parents", "children", "no-expand-tabs", "no-notes", "standard-notes", "no-standard-notes", "walk-reflogs",
    "not", "count", "single-worktree", "reflog", "alternate-refs", "ignore-missing", "in-commit-order", "do-walk", "clear-decorations",
    "exclude-first-parent-only", "objects", "objects-edge", "no-object-names", "object-names", "header", "timestamp", "bisect", "no-graph",
  ),
  ...values(
    "format", "date", "author", "committer", "grep", "since", "after", "until", "before", "max-count", "skip", "min-parents", "max-parents", "encoding",
    "glob", "exclude", "decorate-refs", "decorate-refs-exclude", "since-as-filter", "max-age", "min-age", "filter",
  ),
  ...optional("decorate", "pretty", "branches", "tags", "remotes", "ancestry-path", "expand-tabs", "notes", "show-notes", "show-linear-break", "no-walk"),
};
const REV_SHORT = { short: "pusSzRwbtcmrgiEFPWaDMCB0123456789", shortValue: "nLSGUl", shortUnsafe: "O" };

const LOG: Spec = { safe: REVS, ...REV_SHORT };

const DIFF_SPEC: Spec = { safe: { ...DIFF, ...flags("cached", "staged", "merge-base", "no-index", "base", "ours", "theirs") }, short: "pusRwbzaWMCBD0123", shortValue: "USGl", shortUnsafe: "O" };

/** A listing's words are patterns only with `--list`; otherwise a word names a branch or tag to create. */
const patternsWithList = (words: readonly string[], seen: ReadonlySet<string>) => words.length === 0 || seen.has("list") || seen.has("l");

const SPECS: Readonly<Record<string, Spec>> = {
  status: {
    safe: { ...flags("short", "branch", "show-stash", "long", "verbose", "null", "no-column", "ahead-behind", "no-ahead-behind", "renames", "no-renames"), ...optional("porcelain", "untracked-files", "ignore-submodules", "ignored", "column", "find-renames") },
    short: "sbvz",
    shortOptional: "u",
  },
  log: LOG,
  show: LOG,
  whatchanged: LOG,
  "rev-list": LOG,
  shortlog: { safe: { ...REVS, ...flags("numbered", "summary", "email", "committer"), ...values("group") }, short: "nsec0123456789", shortOptional: "w", shortValue: "L", shortUnsafe: "O" },
  diff: DIFF_SPEC,
  blame: {
    safe: {
      ...flags("incremental", "porcelain", "line-porcelain", "show-stats", "root", "show-name", "show-number", "show-email", "minimal", "first-parent", "progress", "no-progress", "score-debug", "color-lines", "color-by-age", "no-textconv"),
      ...flags("reverse"),
      ...values("date", "ignore-rev", "ignore-revs-file", "since", "contents", "encoding"),
      ...optional("abbrev"),
    },
    short: "bclnpstwefCM0123456789",
    shortValue: "LS",
  },
  "rev-parse": {
    safe: {
      ...flags(
        "all", "show-toplevel", "show-cdup", "show-prefix", "show-superproject-working-tree", "show-ref-format", "git-dir", "git-common-dir", "absolute-git-dir",
        "is-inside-git-dir", "is-inside-work-tree", "is-bare-repository", "is-shallow-repository", "shared-index-path", "local-env-vars", "verify", "quiet",
        "symbolic", "symbolic-full-name", "revs-only", "no-revs", "flags", "no-flags", "sq", "sq-quote", "not", "keep-dashdash", "stop-at-non-option", "stuck-long",
      ),
      ...values("glob", "exclude", "disambiguate", "git-path", "resolve-git-dir", "since", "after", "until", "before", "default", "prefix", "path-format", "exclude-hidden"),
      ...optional("abbrev-ref", "branches", "tags", "remotes", "show-object-format", "short"),
    },
    short: "q",
  },
  "ls-files": {
    safe: {
      ...flags("cached", "deleted", "modified", "others", "ignored", "stage", "unmerged", "killed", "directory", "no-empty-directory", "exclude-standard", "error-unmatch", "full-name", "recurse-submodules", "debug", "eol", "deduplicate", "sparse", "resolve-undo"),
      ...values("exclude", "exclude-from", "exclude-per-directory", "with-tree", "format"),
      ...optional("abbrev"),
    },
    short: "cdmoiskutvfz",
    shortValue: "xX",
  },
  grep: {
    safe: {
      ...flags(
        "cached", "untracked", "no-index", "no-exclude-standard", "exclude-standard", "recurse-submodules", "text", "no-textconv", "ignore-case", "recursive", "no-recursive",
        "word-regexp", "invert-match", "full-name", "extended-regexp", "basic-regexp", "fixed-strings", "perl-regexp", "line-number", "column", "files-with-matches", "name-only",
        "files-without-match", "null", "only-matching", "count", "no-color", "break", "heading", "show-function", "function-context", "and", "or", "not", "all-match", "quiet",
      ),
      ...values("max-depth", "context", "after-context", "before-context", "threads", "file", "max-count"),
      ...optional("color"),
    },
    unsafe: ["ext-grep"],
    short: "aiIvwnhHlLcozqEFPGrWp0123456789",
    shortValue: "efABCm",
    shortUnsafe: "O",
  },
  describe: { safe: { ...flags("all", "tags", "contains", "exact-match", "debug", "long", "always", "first-parent"), ...values("candidates", "match", "exclude"), ...optional("abbrev", "dirty", "broken") } },
  branch: {
    safe: { ...flags("list", "all", "remotes", "verbose", "show-current", "no-color", "no-column", "ignore-case", "omit-empty", "no-abbrev", "quiet"), ...nexts("contains", "no-contains", "merged", "no-merged", "points-at"), ...values("format", "sort", "abbrev"), ...optional("color", "column") },
    unsafe: ["delete", "move", "copy", "force", "set-upstream-to", "set-upstream", "unset-upstream", "edit-description", "track", "no-track", "create-reflog", "recurse-submodules"],
    short: "larvqi",
    shortUnsafe: "dDmMcCfuteE",
    words: patternsWithList,
  },
  tag: {
    safe: { ...flags("list", "no-color", "no-column", "ignore-case", "omit-empty"), ...nexts("contains", "no-contains", "merged", "no-merged", "points-at"), ...values("sort", "format"), ...optional("color", "column") },
    unsafe: ["annotate", "sign", "no-sign", "local-user", "force", "delete", "verify", "message", "file", "cleanup", "create-reflog", "trailer"],
    short: "li",
    shortOptional: "n",
    shortUnsafe: "asufdvmFe",
    words: patternsWithList,
  },
  "ls-tree": { safe: { ...flags("long", "name-only", "name-status", "object-only", "full-name", "full-tree"), ...values("format"), ...optional("abbrev") }, short: "dlrtz" },
  "merge-base": { safe: flags("all", "octopus", "independent", "is-ancestor", "fork-point"), short: "a" },
  "show-ref": { safe: { ...flags("head", "heads", "tags", "branches", "verify", "exists", "dereference", "quiet"), ...optional("hash", "abbrev", "exclude-existing") }, short: "dsq" },
  "for-each-ref": {
    safe: { ...flags("shell", "perl", "python", "tcl", "ignore-case", "omit-empty", "include-root-refs", "stdin"), ...nexts("points-at", "merged", "no-merged", "contains", "no-contains"), ...values("count", "sort", "format", "exclude", "start-after"), ...optional("color") },
  },
  "name-rev": { safe: { ...flags("tags", "all", "annotate-stdin", "name-only", "no-undefined", "always", "stdin"), ...values("refs", "exclude") } },
  "count-objects": { safe: flags("verbose", "human-readable"), short: "vH" },
  "check-ignore": { safe: flags("quiet", "verbose", "stdin", "non-matching", "no-index"), short: "qvnz" },
  "check-attr": { safe: { ...flags("all", "cached", "stdin"), ...values("source") }, short: "az" },
  version: { safe: flags("build-options") },
  var: { safe: {}, short: "l" },
};

/** Subcommands with their own words first: what follows each word is read as that word's own options. */
const NESTED: Readonly<Record<string, Readonly<Record<string, Spec>>>> = {
  stash: { list: LOG, show: DIFF_SPEC },
  reflog: { show: LOG, exists: { safe: {} } },
  worktree: { list: { safe: { ...flags("porcelain", "verbose"), ...values("expire") }, short: "vz" } },
  notes: { list: { safe: {} }, show: { safe: {} } },
};

/** git's global options that only say where it looks and how it reads paths (exact: git takes no abbreviation of these). */
const GLOBAL_FLAGS = new Set(["--no-pager", "-P", "--bare", "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--no-optional-locks", "--no-replace-objects"]);
const GLOBAL_VALUES = new Set(["-C", "--git-dir", "--work-tree", "--namespace"]);

export type GitGlobals = { dirs: string[]; gitDir: string | null; sub: string; rest: string[] } | null;

/** The global options of a git argv, the subcommand and its arguments; null when a global option is not one that only says where git looks. */
export function gitParts(argv: readonly string[]): GitGlobals {
  const args = argv.slice(1);
  const dirs: string[] = [];
  let gitDir: string | null = null;
  let index = 0;
  for (; index < args.length && args[index]!.startsWith("-"); index += 1) {
    const arg = args[index]!;
    if (GLOBAL_FLAGS.has(arg)) continue;
    const eq = arg.indexOf("=");
    const name = eq > 0 && arg.startsWith("--") ? arg.slice(0, eq) : arg;
    if (!GLOBAL_VALUES.has(name)) return null;
    const value = eq > 0 && arg.startsWith("--") ? arg.slice(eq + 1) : args[(index += 1)];
    if (value === undefined) return null;
    if (name === "-C") dirs.push(value);
    if (name === "--git-dir") gitDir = value;
  }
  const sub = args[index];
  return sub ? { dirs, gitDir, sub, rest: args.slice(index + 1) } : null;
}

/** The option a long option names, by git's unique-prefix rule; null when unknown, ambiguous or unsafe. `--no-<option>` turns a known one off. */
function longOption(spec: Spec, given: string): { name: string; kind: Kind } | null {
  const unsafe = new Set([...UNSAFE_EVERYWHERE, ...(spec.unsafe ?? [])]);
  const names = [...new Set([...Object.keys(spec.safe), ...unsafe])];
  const pick = (wanted: string): string | null | undefined => {
    if (names.includes(wanted)) return wanted;
    const found = names.filter((name) => name.startsWith(wanted));
    return found.length === 1 ? found[0]! : found.length ? null : undefined;
  };
  const found = pick(given);
  if (found === null) return null;
  if (found !== undefined) return unsafe.has(found) ? null : { name: found, kind: spec.safe[found]! };
  if (!given.startsWith("no-")) return null;
  // `--no-ext-diff`, `--no-textconv`: turning an option off reads; the option itself must be known.
  const base = pick(given.slice(3));
  return base ? { name: `no-${base}`, kind: "flag" } : null;
}

/** An option's value given as the next word: there, and not itself an option. */
const valueNext = (args: readonly string[], at: number): boolean => at < args.length && !args[at]!.startsWith("-");

/** Whether these options and words are all a read for `spec`. */
function readsWith(spec: Spec, args: readonly string[]): boolean {
  const seen = new Set<string>();
  const words: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") {
      words.push(...args.slice(index + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const option = longOption(spec, eq > 0 ? arg.slice(2, eq) : arg.slice(2));
      if (!option) return false;
      if (option.kind === "flag" && eq > 0) return false;
      // A value in the next word is skipped only when it cannot be an option: were git to read this option as a flag, that
      // word would be its next option.
      if (option.kind === "value" && eq < 0 && !valueNext(args, (index += 1))) return false;
      if (option.kind === "next" && eq < 0 && valueNext(args, index + 1)) index += 1;
      seen.add(option.name);
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      for (let at = 1; at < arg.length; at += 1) {
        const letter = arg[at]!;
        if (spec.shortUnsafe?.includes(letter)) return false;
        seen.add(letter);
        if (spec.shortValue?.includes(letter)) {
          if (at === arg.length - 1 && !valueNext(args, (index += 1))) return false;
          break;
        }
        if (spec.shortOptional?.includes(letter)) break;
        if (!spec.short?.includes(letter)) return false;
      }
      continue;
    }
    words.push(arg);
  }
  return spec.words ? spec.words(words, seen) : true;
}

/** `git config`: a read only with a read action (`--get*`, `--list`, `get`, `list`) or one key alone; never with a write option. */
const CONFIG: Spec = {
  safe: {
    ...flags("get", "get-all", "get-regexp", "get-urlmatch", "list", "global", "system", "local", "worktree", "show-origin", "show-scope", "show-names", "name-only", "null", "bool", "int", "bool-or-int", "bool-or-str", "path", "expiry-date", "includes", "no-includes", "fixed-value", "get-color", "get-colorbool", "all", "regexp"),
    ...values("file", "blob", "type", "default", "value", "url"),
  },
  unsafe: ["add", "replace-all", "unset", "unset-all", "rename-section", "remove-section", "comment", "append"],
  short: "lz",
  shortValue: "f",
  shortUnsafe: "e",
};
const CONFIG_READ_ACTIONS = new Set(["get", "get-all", "get-regexp", "get-urlmatch", "list", "l", "get-color", "get-colorbool"]);
const CONFIG_WRITE_WORDS = new Set(["set", "unset", "rename-section", "remove-section", "edit"]);

function configReads(rest: readonly string[]): boolean {
  const first = rest.find((arg) => !arg.startsWith("-"));
  if (first !== undefined && CONFIG_WRITE_WORDS.has(first)) return false;
  if (first === "get" || first === "list") {
    const at = rest.indexOf(first);
    return readsWith(CONFIG, [...rest.slice(0, at), ...rest.slice(at + 1)]);
  }
  let reads = false;
  const spec: Spec = {
    ...CONFIG,
    words: (words, seen) => {
      reads = [...seen].some((name) => CONFIG_READ_ACTIONS.has(name)) || words.length === 1;
      return true;
    },
  };
  return readsWith(spec, rest) && reads;
}

/** `git remote`, `remote -v`, `remote get-url`, and `remote show -n` (without `-n` it asks the remote). */
function remoteReads(rest: readonly string[]): boolean {
  const words = rest.filter((arg) => arg !== "-v" && arg !== "--verbose");
  if (!words.length) return true;
  const [first, ...more] = words;
  if (first === "get-url") return more.every((arg) => !arg.startsWith("-") || arg === "--push" || arg === "--all");
  if (first === "show") return more.includes("-n") && more.every((arg) => !arg.startsWith("-") || arg === "-n");
  return false;
}

/**
 * Whether a git argv only reads (see the top of this file). `assigned`: the shell segment has a `VAR=value`
 * or `env` in front, which can make git run anything (`GIT_EXTERNAL_DIFF`, `GIT_CONFIG_*`, `GIT_SSH_COMMAND`).
 */
export function gitReadsOnly(argv: readonly string[], assigned = false): boolean {
  if (assigned) return false;
  const parts = gitParts(argv);
  if (!parts) return false;
  const { sub, rest } = parts;
  if (sub === "config") return configReads(rest);
  if (sub === "remote") return remoteReads(rest);
  const nested = NESTED[sub];
  if (nested) {
    const at = rest.findIndex((arg) => !arg.startsWith("-"));
    // `git reflog` alone shows the reflog, as `git reflog show`; `git stash` alone stashes.
    if (at < 0) return sub === "reflog" ? readsWith(nested.show!, rest) : false;
    const spec = nested[rest[at]!];
    if (!spec || at > 0) return false;
    return readsWith(spec, rest.slice(at + 1));
  }
  const spec = SPECS[sub];
  return spec ? readsWith(spec, rest) : false;
}

/**
 * Files a git command writes beyond the repository it runs in, which the judges hold as outside writes: a config
 * write to `--global` (`~/.gitconfig`), `--system` (`/etc/gitconfig`) or `--file <path>`. Empty for a read.
 */
export function gitWrites(argv: readonly string[], cwd: string, home = homedir()): string[] {
  if (argv[0]?.split(/[\\/]/).pop()?.replace(/\.exe$/i, "") !== "git") return [];
  const parts = gitParts(argv);
  if (!parts || parts.sub !== "config" || configReads(parts.rest)) return [];
  const out: string[] = [];
  for (let index = 0; index < parts.rest.length; index += 1) {
    const arg = parts.rest[index]!;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--")) {
      const option = longOption(CONFIG, eq > 0 ? arg.slice(2, eq) : arg.slice(2));
      if (option?.name === "global") out.push(resolve(home, ".gitconfig"));
      else if (option?.name === "system") out.push("/etc/gitconfig");
      else if (option?.name === "file") out.push(resolve(cwd, (eq > 0 ? arg.slice(eq + 1) : parts.rest[index + 1]) ?? ""));
    } else if (arg === "-f" && parts.rest[index + 1]) out.push(resolve(cwd, parts.rest[index + 1]!));
  }
  return out;
}
