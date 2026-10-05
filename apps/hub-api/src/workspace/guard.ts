/**
 * Guard rails shared by agent jobs and the human terminal.
 *
 * Nothing here trusts the model or the browser. Every path is resolved through
 * symlinks and measured against one root; every command is an argv checked
 * against an allow-list; every git call is checked against the job's ceiling.
 * On macOS, commands additionally run under a Seatbelt profile, so a script
 * the agent writes cannot reach outside its folder either.
 */
import { lstat, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopDataDir } from "@ensemble/shared-types/desktop-discovery";
import { env } from "../config.js";
import { compileSeatbeltProfile } from "./sandbox/seatbelt.js";

export class GuardError extends Error {
  readonly statusCode = 403;
  readonly expose = true;
  constructor(message: string) {
    super(message);
    this.name = "GuardError";
  }
}

const HOME = homedir();
/** This checkout: an agent that can edit Ensemble can remove its own guard rails. */
export const ENSEMBLE_SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** `~`, `~/…`, and `~\…` become the account home. Other paths are unchanged. */
export function expandHome(input: string): string {
  if (input === "~") return HOME;
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    const rest = input.slice(2).split(/[/\\]/).filter((part) => part.length > 0);
    return join(HOME, ...rest);
  }
  return input;
}

export async function workspaceRoot(): Promise<string> {
  const root = resolve(expandHome(env.ENSEMBLE_WORKSPACE_ROOT || join(HOME, "ensemble-workspace")));
  await mkdir(root, { recursive: true });
  return realpath(root);
}

export function within(root: string, candidate: string, allowEqual = true): boolean {
  const rel = relative(root, candidate);
  if (rel === "") return allowEqual;
  return !rel.startsWith("..") && !isAbsolute(rel);
}

const SYSTEM_ROOTS = [
  "/System",
  "/Library",
  "/Applications",
  "/usr",
  "/bin",
  "/sbin",
  "/etc",
  "/var",
  "/opt",
  "/cores",
  "/private/etc",
  "/private/var",
  "/dev",
  "/Network",
];

/** Folders the engineer can never hand to an agent or open in the terminal. */
const HOME_BLOCKED = [
  "Library",
  ".ssh",
  ".aws",
  ".gnupg",
  ".config",
  ".kube",
  ".docker",
  ".ensemble",
  ".cursor",
  ".vscode",
  ".npmrc",
  ".netrc",
  ".git-credentials",
  "Applications",
];

/** Too broad to be "a project folder": a project inside them is fine. */
const HOME_TOO_BROAD = ["Desktop", "Documents", "Downloads", "Pictures", "Movies", "Music", "Public", "Sites"];

/** Why a folder may not be a work root, or null when it may. */
export function blockedReason(real: string): string | null {
  if (real === "/" || real === "/Users" || real === "/Volumes") return "A disk or top-level system folder is too broad.";
  for (const root of SYSTEM_ROOTS) {
    if (within(root, real)) return `${root} holds the operating system or installed apps.`;
  }
  if (/^\/Volumes\/[^/]+$/.test(real)) return "A whole disk is too broad. Pick a project folder on it.";
  if (real === HOME) return "Your home folder is too broad. Pick a project folder inside it.";
  if (dirname(real) === "/Users") return "Another account's home folder is off limits.";
  for (const name of HOME_BLOCKED) {
    if (within(join(HOME, name), real)) return `~/${name} holds settings, keys or app data.`;
  }
  for (const name of HOME_TOO_BROAD) {
    if (real === join(HOME, name)) return `~/${name} is too broad. Pick a project folder inside it.`;
  }
  if (within(ENSEMBLE_SOURCE, real) || within(real, ENSEMBLE_SOURCE)) {
    return "This is Ensemble's own code. An agent that can edit it could remove its own guard rails.";
  }
  return null;
}

/**
 * Resolves a folder the engineer chose and refuses anything unsafe.
 * The folder itself may not be a link: the real directory has to be named.
 */
export async function resolveWorkFolder(input: string): Promise<string> {
  const raw = input.trim().replace(/^~(?=\/|$)/, HOME);
  if (!raw || !isAbsolute(raw)) throw new GuardError("Give the full path, starting with / or ~.");
  if (raw.includes('"') || raw.includes("\n")) throw new GuardError("That path has characters Ensemble will not use.");
  let info;
  try {
    info = await lstat(raw);
  } catch {
    throw new GuardError("That folder does not exist.");
  }
  if (info.isSymbolicLink()) throw new GuardError("That is a link. Choose the real folder it points to.");
  if (!info.isDirectory()) throw new GuardError("That is a file, not a folder.");
  const real = await realpath(raw);
  const reason = blockedReason(real);
  if (reason) throw new GuardError(reason);
  return real;
}

/** A path the agent or terminal named, resolved inside root. Links that leave root are refused. */
export async function jailPath(root: string, candidate: string, mustExist = false): Promise<string> {
  const full = resolve(root, candidate || ".");
  if (!within(root, full)) throw new GuardError(`${candidate} is outside ${root}.`);
  let probe = full;
  while (true) {
    try {
      const real = await realpath(probe);
      if (!within(root, real)) throw new GuardError(`${candidate} leads outside the allowed folder through a link.`);
      if (probe === full) return real;
      return join(real, relative(probe, full));
    } catch (error) {
      if (error instanceof GuardError) throw error;
      if (mustExist) throw new GuardError(`${candidate} does not exist.`);
      const parent = dirname(probe);
      if (parent === probe) throw new GuardError(`${candidate} is outside ${root}.`);
      probe = parent;
    }
  }
}

// ── commands ──────────────────────────────────────────────────────────────

/** Splits a command line like a shell would, and refuses everything a shell would do beyond that. */
export function parseCommand(line: string): string[] {
  const argv: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && i + 1 < line.length) current += line[++i];
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (char === "\\" && i + 1 < line.length) {
      current += line[++i];
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) argv.push(current);
      current = "";
      started = false;
      continue;
    }
    if ("|&;<>`".includes(char) || (char === "$" && (line[i + 1] === "(" || line[i + 1] === "{"))) {
      throw new GuardError(`"${char}" is not supported. Run one command at a time, without pipes, redirects or chaining.`);
    }
    current += char;
    started = true;
  }
  if (quote) throw new GuardError("A quote is not closed.");
  if (started) argv.push(current);
  if (!argv.length) throw new GuardError("Type a command.");
  return argv;
}

const DEV_TOOLS = [
  "python", "python3", "pip", "pip3", "uv", "uvx", "conda", "jupyter",
  "node", "npm", "npx", "pnpm", "yarn", "bun", "deno", "tsc",
  "pytest", "make", "cmake", "cargo", "rustc", "go", "java", "javac", "mvn", "gradle", "ruby", "bundle",
];
const FILE_TOOLS = [
  "ls", "cat", "head", "tail", "wc", "grep", "rg", "find", "tree", "mkdir", "touch", "cp", "mv", "rm", "echo",
  "sort", "uniq", "diff", "cut", "tr", "sed", "awk", "tar", "unzip", "zip", "gzip", "gunzip", "file", "stat", "du",
  "which", "date", "basename", "dirname", "realpath", "chmod",
];
const NETWORK_TOOLS = ["curl", "wget"];

/** Never, in either mode: privilege, persistence, desktop control, keychain. */
const NEVER = new Set([
  "sudo", "su", "doas", "osascript", "open", "launchctl", "defaults", "security", "systemsetup", "networksetup",
  "scutil", "dscl", "crontab", "kill", "killall", "pkill", "shutdown", "reboot", "halt", "diskutil", "mount",
  "umount", "chown", "chflags", "xattr", "spctl", "csrutil", "tccutil", "pmset", "ssh", "scp", "sftp", "nc", "ncat",
  "telnet", "docker", "env", "printenv", "export", "xargs", "eval", "exec", "source", "nohup", "screen", "tmux",
]);

export interface CommandPolicy {
  who: "agent" | "human";
  sandboxed: boolean;
  network: boolean;
}

/** Throws unless argv[0] is allowed. Returns the program name. */
export function checkProgram(argv: string[], policy: CommandPolicy): string {
  const program = argv[0]!;
  if (program.includes("/")) {
    throw new GuardError("Run programs by name (python, node, git…). Scripts run through their interpreter: python script.py.");
  }
  if (NEVER.has(program)) throw new GuardError(`${program} is not allowed here.`);
  if (program === "git") return program;
  if (DEV_TOOLS.includes(program) || FILE_TOOLS.includes(program)) return program;
  if (NETWORK_TOOLS.includes(program)) {
    if (!policy.network) throw new GuardError(`${program} needs network access, which is off for this job.`);
    return program;
  }
  if (["bash", "sh", "zsh"].includes(program)) {
    if (!policy.sandboxed) throw new GuardError("Shell scripts only run in the sandbox.");
    if (argv.includes("-c")) throw new GuardError(`${program} -c is not allowed. Write the script to a file and run it.`);
    return program;
  }
  throw new GuardError(`${program} is not on the allow-list. Allowed: git, ${DEV_TOOLS.slice(0, 10).join(", ")}, and common file tools.`);
}

export interface GitLimits {
  delivery: "local" | "commit" | "push";
  branch?: string;
  /** The only branch an agent push may name. Fast-forward of that branch is done by the app. */
  runBranch?: string;
  who: "agent" | "human";
}

const GIT_READ = new Set([
  "status", "log", "diff", "show", "rev-parse", "ls-files", "ls-tree", "blame", "describe", "shortlog", "grep",
  "reflog", "cat-file", "merge-base", "rev-list", "whatchanged", "version", "help",
]);
const GIT_LOCAL = new Set([
  "add", "restore", "checkout", "switch", "stash", "rm", "mv", "reset", "merge", "rebase", "cherry-pick", "revert",
  "init", "clean", "fetch", "pull", "clone", "tag", "branch", "remote", "config", "apply", "am", "notes", "worktree",
]);
const PROTECTED = new Set(["main", "master", "trunk", "develop", "production", "release"]);

export type GitAction = "read" | "local" | "commit" | "push" | "network";

/** Classifies and checks a git argv. Throws with the reason when the job may not do it. */
export function checkGit(argv: string[], limits: GitLimits): { sub: string; action: GitAction } {
  const args = argv.slice(1);
  let index = 0;
  while (args[index]?.startsWith("-")) {
    if (args[index] === "--no-pager") {
      index += 1;
      continue;
    }
    throw new GuardError(`git ${args[index]} is not allowed. Run git commands without global options.`);
  }
  const sub = args[index] ?? "";
  const rest = args.slice(index + 1);
  const has = (...flags: string[]) => rest.some((arg) => flags.includes(arg) || flags.some((flag) => flag.endsWith("=") && arg.startsWith(flag)));
  if (!sub) throw new GuardError("Which git command?");
  if (["filter-branch", "filter-repo", "update-ref", "replace", "gc", "prune", "submodule", "daemon", "credential", "config-set"].includes(sub)) {
    throw new GuardError(`git ${sub} is not allowed.`);
  }
  if (GIT_READ.has(sub)) return { sub, action: "read" };
  if (sub === "config") {
    if (has("--get", "--get-all", "--list", "-l", "--get-regexp")) return { sub, action: "read" };
    throw new GuardError("Changing git config is not allowed.");
  }
  if (sub === "remote") {
    if (!rest.length || has("-v", "--verbose") || rest[0] === "show" || rest[0] === "get-url") return { sub, action: "read" };
    throw new GuardError("Changing git remotes is not allowed.");
  }
  if (sub === "branch") {
    if (has("-D", "--delete", "-d", "-M", "-m", "--move", "-f", "--force", "--set-upstream-to", "-u")) {
      if (limits.who === "agent") throw new GuardError("Deleting, renaming or forcing branches is not allowed for the agent.");
    }
    return { sub, action: rest.some((arg) => !arg.startsWith("-")) ? "local" : "read" };
  }
  if (sub === "worktree" && rest[0] !== "list") throw new GuardError("git worktree can place files outside the folder. Not allowed.");
  if (sub === "commit") {
    if (limits.delivery === "local") throw new GuardError("This job may not commit. It was assigned with “Local files only”.");
    return { sub, action: "commit" };
  }
  if (sub === "push") {
    if (limits.delivery !== "push") throw new GuardError("This job may not push. Pushing was not allowed when it was assigned.");
    if (has("--force", "-f", "--mirror", "--all", "--delete", "-d", "--prune")) {
      throw new GuardError(limits.who === "human" ? "Force-push and deletes are refused. Use --force-with-lease if you must rewrite." : "Force-push, mirror and branch deletes are not allowed.");
    }
    if (limits.who === "agent" && has("--force-with-lease", "--force-with-lease=", "--force-if-includes")) {
      throw new GuardError("The agent may not rewrite remote history.");
    }
    const refs = rest.filter((arg) => !arg.startsWith("-")).slice(1);
    for (const ref of refs) {
      if (ref.startsWith(":") || ref.startsWith("+")) throw new GuardError("Deleting or force-updating a remote branch is not allowed.");
      const target = ref.includes(":") ? ref.split(":").pop()! : ref;
      const name = target.replace(/^refs\/heads\//, "");
      if (limits.who === "agent" && limits.runBranch && name !== limits.runBranch && name !== "HEAD") {
        throw new GuardError(`The agent may only push ${limits.runBranch}. Push is fast-forward and is done by Ensemble, not inside the sandbox.`);
      }
      if (limits.who === "agent" && PROTECTED.has(name) && name !== limits.branch) {
        throw new GuardError(`The agent may not push to ${name}. It works on ${limits.branch || "its own branch"}.`);
      }
    }
    return { sub, action: "push" };
  }
  if (["clone", "fetch", "pull"].includes(sub)) return { sub, action: "network" };
  if (GIT_LOCAL.has(sub)) return { sub, action: "local" };
  throw new GuardError(`git ${sub} is not on the allow-list.`);
}

/** Options Ensemble puts in front of every git call it runs. */
export function gitHardening(useCredentials: boolean, author?: string): string[] {
  const identity = author?.match(/^(.+?)\s*<(.+)>$/);
  return [
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "-c", "protocol.ext.allow=never",
    "-c", "protocol.file.allow=user",
    ...(useCredentials ? [] : ["-c", "credential.helper="]),
    ...(identity ? ["-c", `user.name=${identity[1]}`, "-c", `user.email=${identity[2]}`] : []),
  ];
}

// ── environment & sandbox ─────────────────────────────────────────────────

export async function cacheDir(): Promise<string> {
  const dir = join(await workspaceRoot(), ".cache");
  await mkdir(dir, { recursive: true });
  return dir;
}

/** The only variables a child sees. Ensemble's own secrets never reach a command. */
export async function childEnv(root: string, options: { useCredentials: boolean; who: "agent" | "human" }): Promise<NodeJS.ProcessEnv> {
  const cache = await cacheDir();
  const safeHome = join(cache, "home");
  await mkdir(safeHome, { recursive: true });
  const nodeDir = dirname(process.execPath);
  const path = [nodeDir, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin", join(HOME, ".local/bin"), join(HOME, "miniconda3/bin"), join(HOME, "anaconda3/bin")]
    .filter((dir) => !within(root, dir))
    .join(":");
  // Agents never see the real home. useCredentials used to open it, which also
  // exposed ~/.ssh and the git token's askpass script. The app's own git holds
  // credentials. The human terminal still uses the real home.
  const home = options.who === "human" ? HOME : safeHome;
  return {
    PATH: path,
    HOME: home,
    USER: process.env.USER ?? "",
    LOGNAME: process.env.USER ?? "",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    TERM: "dumb",
    TMPDIR: join(cache, "tmp"),
    CI: "1",
    NO_COLOR: "1",
    PAGER: "cat",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    ...(options.who === "human"
      ? {}
      : { GIT_ASKPASS: "/usr/bin/false", SSH_ASKPASS: "/usr/bin/false", GIT_SSH_COMMAND: "ssh -o BatchMode=yes -F /dev/null" }),
    PIP_CACHE_DIR: join(cache, "pip"),
    UV_CACHE_DIR: join(cache, "uv"),
    npm_config_cache: join(cache, "npm"),
    XDG_CACHE_HOME: join(cache, "xdg"),
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONUNBUFFERED: "1",
  };
}

/**
 * Seatbelt profile for one command. Agents are denied `$HOME`, Unix sockets,
 * LaunchServices, the Never binaries, and the desktop app-data folder.
 * `useCredentials` does not open secret paths for an agent; the app's git
 * holds the token outside the sandbox.
 */
export async function seatbeltProfile(
  root: string,
  options: { network: boolean; useCredentials: boolean; who: "agent" | "human"; readOnly?: string[]; readWrite?: string[] },
): Promise<string> {
  const cache = await cacheDir();
  const readWrite = options.readWrite ?? [root, cache];
  if (!readWrite.includes(cache)) readWrite.push(cache);
  return compileSeatbeltProfile({
    home: HOME,
    readWrite,
    readOnly: options.readOnly ?? [],
    deny: [desktopDataDir({ platform: "darwin", home: HOME })],
    network: options.network ? "outbound" : "none",
    who: options.who,
    ensembleSource: ENSEMBLE_SOURCE,
    askpassPath: join(cache, "git-askpass.sh"),
  });
}

export const sandboxAvailable = process.platform === "darwin";

export function relativeTo(root: string, path: string): string {
  const rel = relative(root, path);
  return rel === "" ? "." : rel.split(sep).join("/");
}
