/**
 * A coding agent's shell command read the way a shell reads it, closely enough to judge it: the
 * programs it runs, the folder each one runs in (`cd dir && …`), and the files it redirects to.
 * Quotes are honoured before anything is split, so `node -e 'a; b'` is one program and the code
 * inside it is not read as paths. Heredoc bodies, comments and fd duplications (`2>&1`) are skipped;
 * `$(…)` and backtick commands are read as commands of their own.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";

export type ShellSegment = {
  argv: string[];
  /** The folder the program runs in, after any `cd` earlier in the command. */
  cwd: string;
  redirects: Array<{ path: string; write: boolean }>;
  /** `VAR=value` or `env` before the program (or alone): it changes what the program loads or runs (`LD_PRELOAD`, `PAGER`). */
  assigned?: boolean;
};

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Words in front of the real program that only change how it runs. */
const WRAPPERS = new Set(["time", "nice", "nohup", "command", "builtin", "exec", "stdbuf", "timeout", "caffeinate", "xargs", "setsid", "ionice", "chrt", "taskset", "unbuffer"]);
/** A wrapper's options that take the next word as their value. */
const VALUE_OPTIONS: Record<string, ReadonlySet<string>> = {
  env: new Set(["-u", "--unset", "-C", "--chdir"]),
  timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
  nice: new Set(["-n", "--adjustment"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  ionice: new Set(["-c", "--class", "-n", "--classdata"]),
  xargs: new Set(["-I", "-L", "-n", "-P", "-s", "-d", "-E", "-a", "--arg-file", "--delimiter", "--max-args", "--max-lines", "--max-procs", "--max-chars", "--eof"]),
};
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

/** The index of the `)` that closes the `(` at `open`, quotes respected; the end of the text when there is none. */
function closing(text: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote) {
      if (char === "\\" && quote === '"') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return text.length;
}

/** `$HOME`, `${HOME}` and a leading `~` as the home folder; other variables stay as written. */
export function expandWord(word: string, home = homedir()): string {
  const expanded = word.replace(/^\$\{HOME\}|^\$HOME(?![A-Za-z0-9_])/, home);
  if (expanded === "~") return home;
  if (expanded.startsWith("~/")) return `${home}${expanded.slice(1)}`;
  return expanded;
}

/** The program and its arguments without leading `VAR=value` assignments and wrappers like `env` or `nohup`. */
export function programArgv(words: string[]): string[] {
  let start = 0;
  for (;;) {
    while (start < words.length && ASSIGNMENT.test(words[start]!)) start += 1;
    const word = words[start];
    if (word === undefined) return [];
    const name = word.split(/[\\/]/).pop()!;
    if (name !== "env" && !WRAPPERS.has(name)) return words.slice(start);
    const takesValue = VALUE_OPTIONS[name] ?? new Set<string>();
    start += 1;
    // env -u X cmd, env -S 'cmd args', timeout -s KILL 30 cmd, nice -n 5 cmd, stdbuf -oL cmd, xargs -n 1 cmd
    while (start < words.length) {
      const option = words[start]!;
      if (name === "env" && (option === "-S" || option.startsWith("--split-string"))) {
        const value = option.includes("=") ? option.slice(option.indexOf("=") + 1) : (words[start + 1] ?? "");
        return programArgv([...value.split(/\s+/).filter(Boolean), ...words.slice(start + (option.includes("=") ? 1 : 2))]);
      }
      if (name === "env" && /^-S./.test(option)) return programArgv([...option.slice(2).split(/\s+/).filter(Boolean), ...words.slice(start + 1)]);
      if (takesValue.has(option)) start += 2;
      else if (option.startsWith("-") || (name === "env" && ASSIGNMENT.test(option)) || /^\d+(\.\d+)?[smhd]?$/.test(option)) start += 1;
      else break;
    }
  }
}

export function parseShell(command: string, root: string, home = homedir()): ShellSegment[] {
  const segments: ShellSegment[] = [];
  const nested: Array<{ text: string; cwd: string }> = [];
  let cwd = root;
  let words: string[] = [];
  let redirects: ShellSegment["redirects"] = [];
  let word = "";
  let inWord = false;
  let redirect: { write: boolean } | "skip" | "heredoc" | null = null;
  const heredocs: Array<{ end: string; tabs: boolean }> = [];
  let heredocTabs = false;

  const pushWord = () => {
    if (!inWord) return;
    if (redirect === "heredoc") heredocs.push({ end: word, tabs: heredocTabs });
    else if (redirect && redirect !== "skip") redirects.push({ path: expandWord(word, home), write: redirect.write });
    else if (!redirect) words.push(word);
    redirect = null;
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    pushWord();
    redirect = null;
    const argv = programArgv(words);
    const assigned = words.slice(0, words.length - argv.length).some((word) => ASSIGNMENT.test(word) || word.split(/[\\/]/).pop() === "env");
    if (argv.length || redirects.length || assigned) {
      segments.push({ argv, cwd, redirects, ...(assigned ? { assigned: true } : {}) });
      const name = argv[0]?.split(/[\\/]/).pop();
      // `bash -c '…'` (or -lc, sh, zsh): the script is shell too, read as commands of its own.
      if (name && SHELLS.has(name)) {
        const flag = argv.findIndex((arg, index) => index > 0 && /^-[a-z]*c[a-z]*$/.test(arg));
        if (flag > 0 && argv[flag + 1]) nested.push({ text: argv[flag + 1]!, cwd });
      }
      if (name === "cd" || name === "pushd") {
        const target = argv.slice(1).find((arg) => !arg.startsWith("-"));
        if (!target) cwd = home;
        else if (target !== "-") cwd = resolve(cwd, expandWord(target, home));
      } else if (name === "popd") cwd = root;
    }
    words = [];
    redirects = [];
  };
  const skipHeredocs = (from: number): number => {
    let index = from;
    for (const doc of heredocs) {
      for (;;) {
        if (index >= command.length) return index;
        const end = command.indexOf("\n", index);
        const line = command.slice(index, end < 0 ? command.length : end);
        index = end < 0 ? command.length : end + 1;
        if ((doc.tabs ? line.replace(/^\t+/, "") : line) === doc.end) break;
      }
    }
    heredocs.length = 0;
    return index - 1;
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (char === "'") {
      const end = command.indexOf("'", index + 1);
      word += command.slice(index + 1, end < 0 ? command.length : end);
      inWord = true;
      index = end < 0 ? command.length : end;
      continue;
    }
    if (char === '"') {
      let cursor = index + 1;
      while (cursor < command.length && command[cursor] !== '"') {
        const here = command[cursor]!;
        if (here === "\\" && cursor + 1 < command.length && '"\\$`\n'.includes(command[cursor + 1]!)) {
          word += command[cursor + 1];
          cursor += 2;
          continue;
        }
        if (here === "$" && command[cursor + 1] === "(") {
          const close = closing(command, cursor + 1);
          nested.push({ text: command.slice(cursor + 2, close), cwd });
          word += command.slice(cursor, close + 1);
          cursor = close + 1;
          continue;
        }
        word += here;
        cursor += 1;
      }
      inWord = true;
      index = cursor;
      continue;
    }
    if (char === "\\" && index + 1 < command.length) {
      if (command[index + 1] !== "\n") {
        word += command[index + 1];
        inWord = true;
      }
      index += 1;
      continue;
    }
    if (char === "$" && command[index + 1] === "(") {
      const close = closing(command, index + 1);
      // $((arithmetic)) is not a command.
      if (command[index + 2] !== "(") nested.push({ text: command.slice(index + 2, close), cwd });
      word += command.slice(index, close + 1);
      inWord = true;
      index = close;
      continue;
    }
    if (char === "`") {
      const end = command.indexOf("`", index + 1);
      nested.push({ text: command.slice(index + 1, end < 0 ? command.length : end), cwd });
      word += "`…`";
      inWord = true;
      index = end < 0 ? command.length : end;
      continue;
    }
    if (char === "#" && !inWord) {
      const end = command.indexOf("\n", index);
      index = (end < 0 ? command.length : end) - 1;
      continue;
    }
    if (char === "\n") {
      endSegment();
      if (heredocs.length) index = skipHeredocs(index + 1);
      continue;
    }
    if (char === " " || char === "\t" || char === "\r") {
      pushWord();
      continue;
    }
    if (char === ">" || char === "<") {
      // A word of digits right before it is a file descriptor: `2>`.
      if (inWord && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      } else pushWord();
      if (char === "<" && command[index + 1] === "<") {
        if (command[index + 2] === "<") {
          index += 2;
          redirect = "skip";
        } else {
          index += 1;
          heredocTabs = command[index + 1] === "-";
          if (heredocTabs) index += 1;
          redirect = "heredoc";
        }
        continue;
      }
      const write = char === ">";
      if (command[index + 1] === ">" || command[index + 1] === "|") index += 1;
      // `>&2`, `2>&1`, `<&0`: a descriptor, not a file.
      if (command[index + 1] === "&") {
        index += 1;
        redirect = "skip";
        continue;
      }
      redirect = { write };
      continue;
    }
    if (char === "&" && command[index + 1] === ">") {
      pushWord();
      index += command[index + 2] === ">" ? 2 : 1;
      redirect = { write: true };
      continue;
    }
    if (char === ";" || char === "|" || char === "&" || char === "(" || char === ")") {
      endSegment();
      if ((char === "&" || char === "|" || char === ";") && command[index + 1] === char) index += 1;
      else if (char === "|" && command[index + 1] === "&") index += 1;
      continue;
    }
    if ((char === "{" || char === "}") && !inWord && (index + 1 >= command.length || /\s/.test(command[index + 1]!))) {
      endSegment();
      continue;
    }
    word += char;
    inWord = true;
  }
  endSegment();
  for (const inner of nested) segments.push(...parseShell(inner.text, inner.cwd, home));
  return segments;
}
