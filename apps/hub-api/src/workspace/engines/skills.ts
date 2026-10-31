/**
 * The folders where coding agents keep the skills they load for the person: the shared
 * `~/.agents/skills`, each agent's own skill folder, and the plugins and marketplaces their skills
 * come from. A run reads them in every mode, as the agent itself does when it loads a skill, and a
 * script there runs without counting as a change to its folder (`judge.ts`). Writing there is judged
 * like writing any other folder outside the run's. Credential files (`.env`, keys) and git's own
 * files inside them are left to the run's usual rules. docs/30 §10.
 */
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { credentialPathReason } from "../../evidence/limits.js";
import { expandHome, within } from "../guard.js";
import { expandWord, type ShellSegment } from "../shell-parse.js";

const dir = (value: string | undefined, fallback: string) => (value?.trim() ? resolve(expandHome(value.trim())) : fallback);

/** Every agent's skill and plugin folders on this computer, as configured (whether or not they exist). */
export function agentSkillRoots(home = homedir(), env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const claude = dir(env.CLAUDE_CONFIG_DIR, join(home, ".claude"));
  const codex = dir(env.CODEX_HOME, join(home, ".codex"));
  const copilot = dir(env.COPILOT_HOME, join(home, ".copilot"));
  const config = dir(env.XDG_CONFIG_HOME, join(home, ".config"));
  const cache = platform === "darwin" ? join(home, "Library", "Caches") : platform === "win32" ? dir(env.LOCALAPPDATA, join(home, "AppData", "Local")) : dir(env.XDG_CACHE_HOME, join(home, ".cache"));
  return [
    // The shared folder of the agent skills standard: Claude Code, Codex, Copilot, Gemini CLI and OpenCode read it.
    join(home, ".agents", "skills"),
    join(claude, "skills"),
    // Plugins from marketplaces, where ${CLAUDE_PLUGIN_ROOT} points; never their data folders.
    join(claude, "plugins", "marketplaces"),
    join(claude, "plugins", "cache"),
    // Codex's own skills (with its built-in `.system` ones) and its plugins.
    join(codex, "skills"),
    join(codex, "plugins", "cache"),
    join(copilot, "skills"),
    join(copilot, "installed-plugins"),
    // Copilot's built-in skills ship in its package.
    join(cache, "copilot", "pkg"),
    join(home, ".cursor", "skills"),
    join(home, ".cursor", "skills-cursor"),
    join(home, ".gemini", "skills"),
    join(home, ".gemini", "extensions"),
    join(home, ".gemini", "antigravity", "skills"),
    join(config, "opencode", "skill"),
    join(config, "opencode", "skills"),
  ];
}

function real(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** The roots and, for a root that is a link (`~/.claude/skills` to `~/.agents/skills`), where it leads. */
export function skillRootsHere(home = homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = agentSkillRoots(home, env);
  return [...new Set([...roots, ...roots.map(real).filter((path): path is string => Boolean(path))])];
}

/** A path (already followed through links) in an agent's skill folder, not a credential or git file there. */
export function inSkillFolder(realPath: string, roots: readonly string[] = skillRootsHere()): boolean {
  return roots.some((root) => within(root, realPath, false)) && !credentialPathReason(realPath);
}

/** Programs that run a script file given as their first operand. */
const INTERPRETERS = new Set([
  "python", "python3", "python2", "py", "pypy", "pypy3", "node", "nodejs", "bun", "deno", "tsx", "ts-node", "ruby", "perl", "php",
  "bash", "sh", "zsh", "dash", "fish", "ksh", "pwsh", "powershell", "lua", "luajit", "Rscript", "julia", "osascript", "uv",
]);
/** Options after which the program runs code or a module given inline, not a script file. */
const INLINE = new Set(["-c", "-e", "--eval", "-p", "--print", "-m", "-Command", "-EncodedCommand", "-r", "--require", "--import", "--loader"]);
/** Words a runner takes before the script (`deno run x.ts`, `uv run x.py`, `bun run x.ts`). */
const RUN_WORDS = new Set(["run", "exec"]);

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * The script a shell segment runs from an agent's skill folder, followed through links: the program
 * itself (`~/.agents/skills/x/scripts/run.sh`), or the script an interpreter is given
 * (`python3 ~/.agents/skills/x/scripts/search.py "query"`, `cd ~/.agents/skills/x && node scripts/a.mjs`).
 * Null when it runs anything else, or code given inline (`python3 -c …`).
 */
export function skillScript(segment: Pick<ShellSegment, "argv" | "cwd">, roots: readonly string[] = skillRootsHere(), home = homedir()): string | null {
  const [program, ...args] = segment.argv;
  if (!program) return null;
  const at = (word: string) => real(resolve(segment.cwd, expandWord(word, home)));
  if (/[\\/]/.test(program)) {
    const path = at(program);
    return path && isFile(path) && inSkillFolder(path, roots) ? path : null;
  }
  const name = basename(program).replace(/\.exe$/i, "");
  if (!INTERPRETERS.has(name)) return null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (INLINE.has(arg)) return null;
    if (arg.startsWith("-")) continue;
    if (index === 0 && RUN_WORDS.has(arg) && ["deno", "bun", "uv"].includes(name)) continue;
    const path = at(arg);
    // The first operand that is a file is the script: one in a skill folder counts, any other does not.
    if (path && isFile(path)) return inSkillFolder(path, roots) ? path : null;
  }
  return null;
}
