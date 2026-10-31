/**
 * What an "Allow for this run" answer covers. The person allowed one command; the same program doing
 * the same thing with other arguments is not asked about again in that run, as Claude Code's
 * `Bash(npm run build:*)` rules work: `python3 <script>` with any query, `npm run build` with any
 * flags, `git commit` with any message. Anything that does something else asks again. docs/30 §10.
 */
import { statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { expandWord, parseShell } from "./shell-parse.js";

/** Programs whose first operand is the script they run. */
const INTERPRETERS = new Set(["python", "python3", "python2", "py", "pypy", "pypy3", "node", "nodejs", "tsx", "ts-node", "ruby", "perl", "php", "bash", "sh", "zsh", "dash", "fish", "ksh", "pwsh", "lua", "Rscript", "julia"]);
/** Programs whose first operand is a package or tool and the second what it does (`npx playwright test`). */
const RUNNERS = new Set(["npx", "pnpx", "bunx", "uvx"]);
/** Operands that name the real action in the one after them (`npm run build`, `docker compose up`, `uv run x.py`). */
const VERBS = new Set(["run", "exec", "x", "dlx", "compose"]);
/** Programs that reach another computer: each connection is its own question. */
const REMOTE = new Set(["ssh", "scp", "sftp", "rsync", "nc", "ncat", "netcat", "telnet", "mosh"]);
const EXPANDS = /\$|`/;

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** One program's kind; "" for a `cd`, which only sets the folder later words resolve in. */
function segmentKind(argv: string[], cwd: string): string | null {
  const [program, ...args] = argv;
  if (!program || EXPANDS.test(program)) return null;
  const name = basename(program).replace(/\.exe$/i, "");
  if (REMOTE.has(name)) return null;
  if (name === "cd" || name === "pushd" || name === "popd") return "";
  if (INTERPRETERS.has(name)) {
    // `python3 -m pytest …` is the module; inline code (`-c`, `-e`) is never covered.
    if (args[0] === "-m" && args[1] && !EXPANDS.test(args[1])) return `${name} -m ${args[1]}`;
    for (const arg of args) {
      if (/^-(c|e|p|m|-eval|-print|Command)$/.test(arg)) return null;
      if (arg.startsWith("-")) continue;
      if (EXPANDS.test(arg)) return null;
      const path = resolve(cwd, expandWord(arg));
      return isFile(path) ? `${name} ${path}` : null;
    }
    return null;
  }
  const operands: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("-")) {
      // An option before what the program does (`git -C x …`, `rm -rf x`): only the very same command is covered.
      if (!operands.length) return null;
      continue;
    }
    if (EXPANDS.test(arg)) return null;
    operands.push(arg);
    if (operands.length >= (RUNNERS.has(name) || VERBS.has(operands[0]!) ? 2 : 1)) break;
  }
  return operands.length ? [name, ...operands].join(" ") : null;
}

/** The command's kind, or null when only the very same command is covered (inline code, a variable, another computer). */
export function commandKind(command: string, root: string): string | null {
  const segments = parseShell(command, root).filter((segment) => segment.argv.length);
  if (!segments.length || segments.some((segment) => segment.assigned)) return null;
  const kinds: string[] = [];
  for (const segment of segments) {
    const kind = segmentKind(segment.argv, segment.cwd);
    if (kind === null) return null;
    if (kind) kinds.push(kind);
  }
  return kinds.length ? kinds.join(" && ") : null;
}

/** A web address's kind: its site. */
export function urlKind(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}
