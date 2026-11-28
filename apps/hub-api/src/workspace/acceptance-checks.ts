/**
 * The checks an assigned run answers to besides those its agent reports (docs/16 §9): the commands its
 * task's or plan step's acceptance criteria name, such as "AC-1 `node accept.js` passes in the export
 * folder". When the agent says it is done, Ensemble runs them again with the agent's reported checks
 * (completion.ts), and the task is done only when they pass.
 */
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { acceptanceOf as stepAcceptance } from "../node/packet.js";
import { gitReadsOnly } from "./git-read.js";
import { within } from "./guard.js";
import { acceptanceOf, type Criterion } from "./turn-packet.js";

export const AcceptanceCheck = z.object({
  id: z.string().min(1).max(80),
  text: z.string().min(1).max(600),
  command: z.string().min(1).max(2000),
  /** A folder the criterion names ("in the web folder"); the run's own folder when it names none, or it is not there. */
  folder: z.string().max(300).nullable(),
});
export type AcceptanceCheck = z.infer<typeof AcceptanceCheck>;

export const MAX_ACCEPTANCE_CHECKS = 12;

/** What the criterion says about a command right after it: it passes, succeeds, exits 0 (also "should pass", "must succeed"). */
const SAID_AFTER = /^\s*(?:(?:should|must|will|shall|has to|have to|needs? to)\s+)?(?:pass(?:es|ing)?|succeed(?:s|ing)?|exits?\s+(?:with\s+)?(?:code\s+|status\s+)?0|returns?\s+0)\b/i;
/** What the criterion says right before a command: run it, execute it. */
const SAID_BEFORE = /\b(?:run|execute)\s*:?\s*$/i;
/** Words that turn "run `X`" (or "change X") around: never run, do not run, avoid, without. */
export const NEGATED = /\b(?:never|not|nor|avoid(?:ing)?|without|skip(?:ping)?|stop(?:ping)?|don'?t|doesn'?t|won'?t|shouldn'?t|mustn'?t|can'?t|cannot)\b/i;
/** Other spans the same words cover: "`A`, `B` and `C` pass". */
const LISTED = /^(?:\s*(?:,\s*(?:and\s+)?|and\s+|&\s+)`[^`\n]+`)+/i;
/** A folder the criterion names: "in the export folder", "in `packages/web/`". */
const FOLDER_NAMED = /\bin (?:the )?`?([\w.@-][\w.@/-]*?)\/?`? (?:folder|directory|dir|package)\b/i;
const FOLDER_PATH = /\bin `([\w.@-][\w.@/-]*?)\/?`/;
const NOT_A_FOLDER = new Set(["this", "that", "the", "same", "current", "project", "repository", "repo", "root", "run's", "its", "your", "my", "our", "their", "work", "working"]);

/** Whether the criterion says the span at `at` runs or passes: never under "never run" or "do not run". */
function said(text: string, at: number, length: number): boolean {
  const after = text.slice(at + length).replace(LISTED, "");
  if (SAID_AFTER.test(after)) return true;
  const before = text.slice(0, at);
  return SAID_BEFORE.test(before) && !NEGATED.test(before.split(/[.!?;\n]/).pop() ?? "");
}

/** Letters, digits and `_ . : = / -`, one space between words: nothing a shell or PowerShell reads as syntax, a variable, a glob, a quote or a home folder. */
const PLAIN = /^[A-Za-z0-9_.:=/-]+(?: [A-Za-z0-9_.:=/-]+)*$/;
const WORD = /^[A-Za-z0-9_.:-]+$/;

/** A word that names a place stays in the run's folder: never absolute, a drive, a URL, or out through `..`. */
function staysInside(word: string): boolean {
  const value = word.startsWith("-") && word.includes("=") ? word.slice(word.indexOf("=") + 1) : word;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value) || /^[A-Za-z][\w+.-]*:\/\//.test(value)) return false;
  return !value.split("/").includes("..");
}

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
/** A package script that checks: test, lint, build, check, typecheck or verify, alone or with `:` or `-` after. */
const CHECK_SCRIPT = /^(?:test|lint|build|check|typecheck|verify)(?:[:-][A-Za-z0-9:._-]*)?$/i;
/** Words a checking script never has anywhere in its name: it deploys, publishes, resets, migrates or changes things. */
const RISKY = ["deploy", "release", "publish", "reset", "drop", "migrat", "seed", "clean", "push", "prod", "watch", "install", "upload", "commit", "delete", "destroy", "purge", "wipe", "update", "write"];
/** Short ones, as a whole part of the name (`lint:fix`, `test:rm`, `sync_users`), so `format`, `fixtures`, `server` and `async` stay clear. */
const RISKY_PART = new Set(["rm", "rmrf", "fix", "serve", "start", "sync"]);
/** Words that make a file's name a check's: `test_api.py`, `unit.spec.js`, `accept.js`, `check_output.py`, a `tests` folder. */
const CHECK_WORDS = new Set(["test", "tests", "testing", "spec", "specs", "check", "checks", "accept", "acceptance", "verify", "lint"]);
/** Folders a check's file never comes from: installed packages, vendored code, git's own. */
const NOT_PROJECT = new Set(["node_modules", "vendor", ".git"]);
/** A package script name that is a file (`bun run` runs files): never taken as a script. */
const FILE_LIKE = /\/|\.(?:[cm]?[jt]sx?|py|sh)$/i;
/** A make target that checks: test, lint, build, check, typecheck or verify, alone or with `-`, `_` or `.` after. */
const CHECK_TARGET = /^(?:test|lint|build|check|typecheck|verify)(?:[-_.][A-Za-z0-9._-]*)?$/i;
/** Checkers a package runner may start, only from the run's own install (`localToolProblem`): `npx tsc --noEmit`, `pnpm exec vitest run`. */
const LOCAL_TOOLS = new Set(["tsc", "vitest", "jest", "mocha", "eslint"]);

/** How many words in front are a package runner starting an installed checker (`npx`, `pnpm exec`); 0 for any other command. */
function runnerWords(words: readonly string[]): number {
  const [program = "", sub = "", tool = ""] = words;
  if (program === "npx" && LOCAL_TOOLS.has(sub)) return 1;
  if (program === "pnpm" && sub === "exec" && LOCAL_TOOLS.has(tool)) return 2;
  return 0;
}

/** A name's parts: split at `/ : . _ -` and where a lower-case letter or digit meets a capital. */
function nameParts(name: string): string[] {
  return name
    .split(/[/:._-]+/)
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/))
    .map((part) => part.toLowerCase())
    .filter(Boolean);
}

function riskyScript(name: string): boolean {
  const lower = name.toLowerCase();
  return RISKY.some((word) => lower.includes(word)) || nameParts(name).some((part) => RISKY_PART.has(part));
}

/** The target a check command makes (`make test`, `make lint`): one checking target with no risky word, nothing else; null for any other command. */
export function makeTarget(command: string): string | null {
  const [program = "", target = "", ...rest] = command.trim().split(/\s+/);
  return program === "make" && !rest.length && CHECK_TARGET.test(target) && !riskyScript(target) ? target : null;
}

/**
 * Whether a file (or test folder) a check command runs is a check's: its own name has a check word, its
 * path no risky word, and it is not in installed packages, vendored code, git's folder or a hidden folder.
 * A deploy or reset script a criterion names is never run as a check.
 */
function checkFile(path: string): boolean {
  const file = path.split("::")[0]!;
  const segments = file.split("/").filter((segment) => segment && segment !== ".");
  if (!segments.length || segments.some((segment) => segment.startsWith(".") || NOT_PROJECT.has(segment.toLowerCase()))) return false;
  return nameParts(segments.at(-1)!).some((part) => CHECK_WORDS.has(part)) && !riskyScript(file);
}

type Args = {
  /** Flags allowed as they are. */
  flags: RegExp;
  /** Flags followed by a value word (`-k export`, `-p web/tsconfig.json`): the value is a plain word, or a path in the folder. */
  valued?: Readonly<Record<string, "word" | "path">>;
  /** Words after the flags: paths in the folder (test files, packages), or none. */
  paths?: RegExp;
  /** After `--`: what the test binary or linter takes. */
  rest?: RegExp;
  /** The words after the flags are files the program runs (pytest, mocha), each held to `checkFile`. */
  files?: boolean;
};

/** The words after the flags (the paths), as their places in `args`, or null when an argument is not allowed. */
function positionalsAt(args: readonly string[], spec: Args): number[] | null {
  const found: number[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--" && spec.rest) return args.slice(index + 1).every((word) => spec.rest!.test(word)) ? found : null;
    const valued = spec.valued?.[arg];
    if (valued) {
      const value = args[index + 1];
      index += 1;
      if (!value || value.startsWith("-") || (valued === "word" ? !WORD.test(value) : !(spec.paths ?? /^[\w./-]+$/).test(value) || !staysInside(value))) return null;
      continue;
    }
    if (arg.startsWith("-")) {
      if (!spec.flags.test(arg)) return null;
      continue;
    }
    if (!spec.paths?.test(arg) || !staysInside(arg) || (spec.files && !checkFile(arg))) return null;
    found.push(index);
  }
  return found;
}

const argsAllowed = (args: readonly string[], spec: Args) => positionalsAt(args, spec) !== null;

const TEST_PATHS = /^[\w./-]+(?:::[\w.-]+)*$/;
const PYTEST: Args = {
  flags: /^(?:-q{1,2}|-v{1,2}|-x|-s|-l|-ra|-rA|--quiet|--verbose|--exitfirst|--no-header|--strict-markers|--lf|--last-failed|--ff|--failed-first|--disable-warnings|--tb=(?:auto|long|short|line|native|no)|--maxfail=\d{1,3}|--durations=\d{1,3})$/,
  valued: { "-k": "word", "-m": "word", "-n": "word" },
  paths: TEST_PATHS,
  files: true,
};
const CARGO: Args = {
  flags: /^(?:--workspace|--all|--all-targets|--all-features|--release|--locked|--offline|--frozen|-q|--quiet|-v|--verbose|--lib|--bins|--tests|--doc|--no-fail-fast)$/,
  valued: { "-p": "word", "--package": "word", "--features": "word" },
  rest: /^(?:-[DWA]|--nocapture|--include-ignored|--ignored|--exact|--show-output|--test-threads=\d{1,3}|[A-Za-z_][\w:-]*)$/,
};
const GO: Args = { flags: /^-(?:v|race|short|cover|failfast|count=\d{1,3}|timeout=\w+|vet=off)$/, valued: { "-run": "word", "-count": "word", "-timeout": "word" }, paths: /^\.(?:\/[\w.-]+)*$/ };
const JS_RUNNER: Args = { flags: /^(?:--run|--runInBand|-i|--ci|--coverage|--silent|--passWithNoTests|--bail|--recursive|--exit|--reporter=[\w-]+)$/, paths: TEST_PATHS };
const MOCHA: Args = { ...JS_RUNNER, files: true };
const TSC: Args = { flags: /^(?:--noEmit|--pretty)$/, valued: { "-p": "path", "--project": "path" }, paths: /^[\w./-]+$/ };
const ESLINT: Args = { flags: /^(?:--quiet|--no-cache|--max-warnings=\d{1,4}|--format=[\w-]+)$/, valued: { "--max-warnings": "word" }, paths: /^[\w./-]+$/ };
const RUFF: Args = { flags: /^(?:--quiet|-q|--no-cache|--statistics|--check|--diff)$/, paths: /^[\w./-]+$/ };
const MYPY: Args = { flags: /^(?:--strict|--ignore-missing-imports|--pretty|--no-incremental|--no-error-summary|--show-error-codes)$/, valued: { "-p": "word", "--package": "word", "-m": "word", "--module": "word" }, paths: /^[\w./-]+$/ };

/**
 * Whether a command is one Ensemble runs as a task's check (docs/16 §9): plain words only (`PLAIN`), every
 * place in the run's folder, and one of the test, lint, build and typecheck forms: `npm|pnpm|yarn|bun test`,
 * `npm|pnpm|yarn|bun run <script>` for a checking script with no risky word in its name (run only when the package.json
 * where it runs has it, `checkCommandAt`), pytest (also
 * `python -m pytest`), `cargo test|build|check|clippy`, `go test|vet|build`, vitest, jest, mocha,
 * `tsc --noEmit`, eslint, `ruff check`, `ruff format --check`, mypy, `node <file>.js` or `python <file>.py`
 * with nothing else, git that only reads (`gitReadsOnly`, the judges' own test), one of tsc, Vitest, Jest,
 * Mocha or ESLint started by `npx` or `pnpm exec` (run only when the run's folder has it installed where it runs,
 * `checkCommandAt`), and `make <target>` for a checking target with no risky word in its name (run only when the
 * Makefile where it runs has it). Never an interpreter's `-e` or `-c`, another package runner, or a shell. The web
 * uses it to take a criterion's command, and the computer again before it runs one.
 */
export function isCheckCommand(command: string): boolean {
  if (command.length > 300 || !PLAIN.test(command)) return false;
  const words = command.split(" ");
  if (!words.every(staysInside)) return false;
  const runner = runnerWords(words);
  if (runner) return isCheckCommand(words.slice(runner).join(" "));
  const [program = "", sub = "", ...rest] = words;
  if (PACKAGE_MANAGERS.has(program)) {
    if (sub === "test") return rest.length === 0;
    return sub === "run" && rest.length === 1 && CHECK_SCRIPT.test(rest[0]!) && !FILE_LIKE.test(rest[0]!) && !riskyScript(rest[0]!);
  }
  switch (program) {
    case "pytest":
    case "py.test":
      return argsAllowed(words.slice(1), PYTEST);
    case "python":
    case "python3":
      if (sub === "-m") return rest[0] === "pytest" && argsAllowed(rest.slice(1), PYTEST);
      return words.length === 2 && /^[\w./-]+\.py$/.test(sub) && checkFile(sub);
    case "node":
      return words.length === 2 && /^[\w./-]+\.(?:js|mjs|cjs)$/.test(sub) && checkFile(sub);
    case "cargo":
      return ["test", "build", "check", "clippy"].includes(sub) && argsAllowed(rest, CARGO);
    case "go":
      return ["test", "vet", "build"].includes(sub) && argsAllowed(rest, GO);
    case "vitest":
      return argsAllowed(sub === "run" ? rest : words.slice(1), JS_RUNNER);
    case "jest":
      return argsAllowed(words.slice(1), JS_RUNNER);
    case "mocha":
      return argsAllowed(words.slice(1), MOCHA);
    case "tsc":
      return words.includes("--noEmit") && argsAllowed(words.slice(1), TSC);
    case "eslint":
      return argsAllowed(words.slice(1), ESLINT);
    case "ruff":
      return (sub === "check" || (sub === "format" && rest.includes("--check"))) && argsAllowed(rest, RUFF);
    case "mypy":
      return argsAllowed(words.slice(1), MYPY);
    case "git":
      return gitReadsOnly(words);
    case "make":
      return makeTarget(command) !== null;
    default:
      return false;
  }
}

/**
 * Where in a check command's words the files and test folders it runs are (node's or python's file, pytest's and
 * mocha's paths), and whether a word may end in `::` and a test's name (pytest's). None when it names none.
 */
function fileWords(command: string): { at: number[]; tests: boolean } {
  if (!isCheckCommand(command)) return { at: [], tests: false };
  const words = command.split(" ");
  const runner = runnerWords(words);
  if (runner) {
    const inner = fileWords(words.slice(runner).join(" "));
    return { at: inner.at.map((index) => index + runner), tests: inner.tests };
  }
  const [program = "", sub = ""] = words;
  const after = (offset: number, spec: Args) => ({ at: (positionalsAt(words.slice(offset), spec) ?? []).map((index) => index + offset), tests: spec === PYTEST });
  if (program === "node") return { at: [1], tests: false };
  if (program === "python" || program === "python3") return sub === "-m" ? after(3, PYTEST) : { at: [1], tests: false };
  if (program === "pytest" || program === "py.test") return after(1, PYTEST);
  if (program === "mocha") return after(1, MOCHA);
  return { at: [], tests: false };
}

/** The files and test folders a check command runs, as it names them (pytest's without a test's name); empty when it names none. */
export function checkFiles(command: string): string[] {
  const words = command.split(" ");
  const { at, tests } = fileWords(command);
  return at.map((index) => (tests ? words[index]!.split("::")[0]! : words[index]!));
}

/**
 * The package script a check command runs: `npm|pnpm|yarn|bun run <name>`, and `yarn test` (yarn's `run test`); null for
 * any other. yarn and bun run an installed program of that name (`node_modules/.bin`) when the package has no such script.
 */
function packageScript(command: string): string | null {
  const [program = "", sub = "", ...rest] = command.split(" ");
  if (!PACKAGE_MANAGERS.has(program)) return null;
  if (sub === "run" && rest.length === 1) return rest[0]!;
  return program === "yarn" && sub === "test" && !rest.length ? "test" : null;
}

/** A package.json larger than this is not read. */
const PACKAGE_JSON_MAX = 1024 * 1024;

/** Why a package script cannot run as a check in `cwd`: the package.json there (in the run's folder) has no script of that name. */
async function scriptProblem(root: string, cwd: string, name: string): Promise<string | null> {
  const missing = `"${name}" is not a script in the package.json where it runs: Ensemble runs only a package's own scripts as checks.`;
  const path = await realpath(join(cwd, "package.json")).catch(() => null);
  if (!path) return missing;
  if (!within(root, path)) return "package.json is not in the run's folder.";
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size > PACKAGE_JSON_MAX) return missing;
  try {
    const scripts = (JSON.parse(await readFile(path, "utf8")) as { scripts?: unknown } | null)?.scripts;
    return scripts && typeof scripts === "object" && Object.hasOwn(scripts, name) && typeof (scripts as Record<string, unknown>)[name] === "string" ? null : missing;
  } catch {
    return missing;
  }
}

/**
 * Why a checker a package runner starts (`npx tsc`) cannot run in `cwd`: the package it runs in (the nearest folder, up to
 * the run's folder, with a package.json or node_modules, where npx looks) has no such program installed inside the run's
 * folder. npx would otherwise fetch a package of that name from the registry.
 */
async function localToolProblem(root: string, cwd: string, tool: string): Promise<string | null> {
  const missing = `${tool} is not installed where it runs: Ensemble runs a package runner's program only from the run's own node_modules.`;
  for (let dir = await realpath(cwd).catch(() => cwd); within(root, dir); ) {
    const found = await Promise.all(["package.json", "node_modules"].map((name) => lstat(join(dir, name)).then(() => true, () => false)));
    if (found.some(Boolean)) {
      const bin = await realpath(join(dir, "node_modules", ".bin", tool)).catch(() => null);
      if (!bin) return missing;
      return within(root, bin) ? null : `${tool} where it runs links out of the run's folder.`;
    }
    const parent = resolve(dir, "..");
    if (dir === root || parent === dir) break;
    dir = parent;
  }
  return missing;
}

/** The file make reads in `cwd`, in make's own order; null when there is none. */
export async function makefileAt(cwd: string): Promise<string | null> {
  for (const name of ["GNUmakefile", "makefile", "Makefile"]) {
    const path = join(cwd, name);
    if (await lstat(path).then(() => true, () => false)) return path;
  }
  return null;
}

/** Whether a Makefile has a rule for `target` (`test:`, `lint test: deps`), not a variable set with `:=`. */
export function definesTarget(text: string, target: string): boolean {
  const name = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^(?:[^\\s:#=]+[ \\t]+)*${name}(?:[ \\t]+[^\\s:#=]+)*[ \\t]*::?(?!=)`, "m").test(text);
}

/** Why `make <target>` cannot run as a check in `cwd`: the Makefile there (in the run's folder) has no rule of that name. */
async function makeProblem(root: string, cwd: string, target: string): Promise<string | null> {
  const missing = `"${target}" is not a target in the Makefile where it runs: Ensemble runs only a Makefile's own targets as checks.`;
  const file = await makefileAt(cwd);
  const path = file ? await realpath(file).catch(() => null) : null;
  if (!path) return missing;
  if (!within(root, path)) return "The Makefile is not in the run's folder.";
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size > PACKAGE_JSON_MAX) return missing;
  return definesTarget(await readFile(path, "utf8").catch(() => ""), target) ? null : missing;
}

/** A word for the shell completion.ts runs checks in (sh, PowerShell on Windows), taken as it is. */
function shellWord(text: string): string {
  return process.platform === "win32" ? `'${text.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'` : `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * A check command as it may run where it runs (`cwd`), checked just before: each file and test folder it runs must be in
 * the run's folder (not missing, nor a link out of it), and goes in the command as the real path checked, absolute and
 * quoted, so a link put in its place after the check is not followed; a package script must be one the package.json there
 * has (`packageScript`), a make target one the Makefile there has, and a program `npx` or `pnpm exec` starts one installed
 * there (`npx` runs with `--no-install`, so it never fetches one). Else why it cannot run.
 */
export async function checkCommandAt(root: string, cwd: string, command: string): Promise<{ command: string } | { problem: string }> {
  const real = await realpath(root).catch(() => null);
  if (!real) return { problem: "The run's folder is gone." };
  const words = command.split(" ");
  const { at, tests } = fileWords(command);
  for (const index of at) {
    const word = words[index]!;
    const cut = tests ? word.indexOf("::") : -1;
    const file = cut >= 0 ? word.slice(0, cut) : word;
    const found = await realpath(resolve(cwd, file)).catch(() => null);
    if (!found || !within(real, found)) return { problem: `${file} is not in the run's folder.` };
    words[index] = shellWord(cut >= 0 ? `${found}${word.slice(cut)}` : found);
  }
  const script = packageScript(command);
  const target = makeTarget(command);
  const runner = runnerWords(command.split(" "));
  const problem =
    script !== null ? await scriptProblem(real, cwd, script) : target !== null ? await makeProblem(real, cwd, target) : runner ? await localToolProblem(real, cwd, words[runner]!) : null;
  if (problem) return { problem };
  if (words[0] === "npx") words.splice(1, 0, "--no-install");
  return { command: words.join(" ") };
}

/** Why a check command cannot run where it runs (`checkCommandAt`); null when it can. */
export async function checkFilesProblem(root: string, cwd: string, command: string): Promise<string | null> {
  const checked = await checkCommandAt(root, cwd, command);
  return "problem" in checked ? checked.problem : null;
}

function folderOf(text: string): string | null {
  const named = (FOLDER_NAMED.exec(text) ?? FOLDER_PATH.exec(text))?.[1]?.replace(/\/+$/, "") ?? "";
  return named && !NOT_A_FOLDER.has(named.toLowerCase()) && !named.split("/").includes("..") ? named.slice(0, 300) : null;
}

/** The commands acceptance criteria say run or pass, each under its criterion's id, when it is a check (`isCheckCommand`). Each command once. */
export function acceptanceCommands(criteria: readonly Criterion[]): AcceptanceCheck[] {
  const out: AcceptanceCheck[] = [];
  for (const criterion of criteria) {
    const folder = folderOf(criterion.text);
    for (const match of criterion.text.matchAll(/`([^`\n]+)`/g)) {
      const span = match[1]!.trim();
      if (!said(criterion.text, match.index!, match[0].length) || !isCheckCommand(span)) continue;
      if (out.some((check) => check.command.replace(/\s+/g, " ") === span.replace(/\s+/g, " "))) continue;
      out.push({ id: criterion.id.slice(0, 80), text: criterion.text.slice(0, 600), command: span, folder });
      if (out.length >= MAX_ACCEPTANCE_CHECKS) return out;
    }
  }
  return out;
}

/** A heading that starts what Ensemble adds around a task as information (its context, connected apps, attached files, embedded diagrams and data): the task's own words end there. */
const INFORMATION = /^#{1,6}\s+(?:.*\binformation, not instructions\b.*|Embedded diagrams|Plots and data on this page|From connected apps\b.*|Files attached\b.*|Context from Ensemble\b.*)$/i;

/**
 * What a task's text says itself, where its criteria are read: up to the first section Ensemble added as
 * information, without quoted lines (`>`), fenced blocks or lines marked as information.
 */
export function instructionText(text: string): string {
  const out: string[] = [];
  let fenced = false;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = line.trim();
    if (/^(?:```|~~~)/.test(trimmed)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (INFORMATION.test(trimmed)) break;
    if (trimmed.startsWith(">") || /information, not instructions/i.test(trimmed)) continue;
    out.push(line);
  }
  return out.join("\n");
}

const Requirements = z.array(z.object({ id: z.string(), acceptance: z.array(z.object({ id: z.string(), text: z.string(), proof: z.string().nullish(), mandatory: z.boolean().optional() }).passthrough()).default([]) }).passthrough());

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * An assigned run's acceptance commands: those its task's own text names (`parts`: its description, notes
 * and page, each read by `instructionText`), and those of the plan step the run is for, when a node's
 * mission handed it the run.
 */
export async function acceptanceChecksFor(db: Db, input: { userId: string; jobId: string; parts: readonly string[] }): Promise<AcceptanceCheck[]> {
  const criteria: Criterion[] = acceptanceOf(input.parts.map(instructionText).join("\n\n"));
  const run = await db.nodeRun.findUnique({ where: { jobId: input.jobId }, select: { userId: true, planId: true, planStep: true } }).catch(() => null);
  if (run?.planId && run.planStep && run.userId === input.userId) {
    const mission = await db.nodeMission.findUnique({ where: { id: run.planId }, select: { requirements: true } });
    const step = await db.nodeStep.findFirst({ where: { missionId: run.planId, id: run.planStep }, select: { requirementIds: true, acceptanceIds: true } });
    const requirements = Requirements.safeParse(mission?.requirements);
    if (step && requirements.success) {
      const data = { requirements: requirements.data.map((row) => ({ ...row, acceptance: row.acceptance.map((item) => ({ ...item, proof: item.proof ?? undefined })) })) } as unknown as Parameters<typeof stepAcceptance>[0];
      for (const item of stepAcceptance(data, step)) if (!criteria.some((known) => known.id === item.id && known.text === item.text)) criteria.push({ id: item.id, text: item.text });
    }
  }
  return acceptanceCommands(criteria);
}

/** The acceptance commands a run from the web came with (the claim's `acceptance`); null when it came with none. */
export function acceptanceInContext(context: unknown): AcceptanceCheck[] | null {
  const value = typeof context === "object" && context !== null ? (context as { acceptance?: unknown }).acceptance : undefined;
  if (!Array.isArray(value)) return null;
  return value.map((row) => AcceptanceCheck.safeParse(row)).flatMap((row) => (row.success ? [row.data] : [])).slice(0, MAX_ACCEPTANCE_CHECKS);
}

/** Where an acceptance command runs: the folder its criterion names when it is a real folder inside the run's folder, else the run's folder (null). */
export async function acceptanceFolder(root: string, folder: string | null): Promise<string | null> {
  if (!folder) return null;
  const real = await realpath(root).catch(() => null);
  if (!real) return null;
  const candidate = join(real, folder);
  if (!within(real, candidate)) return null;
  const found = await realpath(candidate).catch(() => null);
  if (!found || !within(real, found)) return null;
  return (await lstat(found).then((info) => info.isDirectory(), () => false)) ? folder : null;
}
