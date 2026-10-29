/**
 * Guard rails shared by agent jobs and the human terminal.
 *
 * Nothing here trusts the model or the browser. Every path is resolved through
 * symlinks and measured against one root; every command is an argv checked
 * against an allow-list; every git call is checked against the job's ceiling.
 * Commands additionally run under the computer's OS sandbox (Seatbelt,
 * bubblewrap, Landlock or the Windows sandbox account), so a script the agent
 * writes cannot reach outside its folder either.
 */
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopDataDir } from "@ensemble/shared-types/desktop-discovery";
import { env } from "../config.js";
import { compileSeatbeltProfile, SECRET_HOME_PATHS } from "./sandbox/seatbelt.js";
import { programArgv } from "./shell-parse.js";
import { capabilities } from "./sandbox/spawn.js";
import { ensembleDataDenies, isEnsembleData } from "./data-denies.js";

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

/** The workspace folder as configured, without creating it or following links. */
export function configuredWorkspace(): string {
  return resolve(expandHome(env.ENSEMBLE_WORKSPACE_ROOT || join(HOME, "ensemble-workspace")));
}

let realWorkspace: string | null = null;

export async function workspaceRoot(): Promise<string> {
  const root = configuredWorkspace();
  await mkdir(root, { recursive: true });
  realWorkspace = await realpath(root);
  return realWorkspace;
}

/** The workspace folder for checks that cannot wait: the real path once it was resolved, else the configured one. */
export function knownWorkspace(): string {
  return realWorkspace ?? configuredWorkspace();
}

/**
 * The workspace's own folders a run may write beside its own: `runs` and every folder the person or
 * an agent made there, never Ensemble's dot-folders (`.askpass`, `.cache`) or the attachment copies in `files`.
 */
export async function workspaceFolders(): Promise<string[]> {
  const root = await workspaceRoot();
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "files").map((entry) => join(root, entry.name));
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
  "AppData",
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
  if (process.platform === "win32") {
    if (/^[A-Za-z]:\\?$/.test(real)) return "A whole disk is too broad. Pick a project folder on it.";
    if (/^\\\\/.test(real)) return "Network folders (\\\\server\\share) cannot be sandboxed. Copy the project to this computer.";
    for (const root of windowsSystemRoots()) {
      if (within(root, real)) return `${root} holds the operating system or installed apps.`;
    }
    if (dirname(HOME) !== HOME && real === dirname(HOME)) return "The folder of all accounts is too broad.";
  }
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

/** Keys, sign-ins and browser data in the home folder: never read or written by a run. */
export const SECRET_PATHS = [
  ...SECRET_HOME_PATHS,
  ".azure",
  ".config/gcloud",
  ".config/hub",
  ".password-store",
  ".pypirc",
  ".pgpass",
  ".vault-token",
  ".terraform.d/credentials.tfrc.json",
  ".mozilla",
  ".config/google-chrome",
  ".config/chromium",
  ".config/BraveSoftware",
  ".local/share/keyrings",
  ".claude/.credentials.json",
  ".codex/auth.json",
  "AppData/Roaming/Microsoft/Credentials",
  "AppData/Local/Microsoft/Credentials",
  "AppData/Local/Google/Chrome",
  "AppData/Roaming/Mozilla",
];

/** Files that run at sign-in or start-up: a write there runs code later, outside the run. Reading them is fine. */
const STARTUP_PATHS = [
  ".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".profile", ".zshrc", ".zprofile", ".zshenv", ".zlogin", ".zlogout",
  ".config/fish", ".config/autostart", ".config/systemd", ".config/git", ".gitconfig",
  "Library/LaunchAgents", "Library/LaunchDaemons", "AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup",
];

/** Device files every program uses (`> /dev/null`, `/dev/stdout`, Chrome's `/dev/shm`): never a path to judge. */
export function harmlessPath(real: string): boolean {
  return /^\/dev\/(null|zero|full|u?random|tty|stdin|stdout|stderr|fd\/\d+|shm(\/.*)?)$/.test(real) || /^\/proc\/self(\/|$)/.test(real) || /^nul$/i.test(real);
}

/** The computer's temporary folders, where tools write scratch files. */
export function inTemp(real: string): boolean {
  return ["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", "/var/folders", "/private/var/folders", tmpdir()].some((root) => within(root, real));
}

function underHome(home: string, real: string, names: string[]): string | undefined {
  const rel = relative(home, real).split(/[\\/]/).join("/");
  return names.find((name) => rel === name || rel.startsWith(`${name}/`));
}

/**
 * A path outside the work folder that a run is about to use (doc 24 §3). Whatever the mode and
 * whether or not the sandbox is on, an agent never reaches Ensemble's own data, keys and sign-ins
 * (`SECRET_PATHS`) or another account's files, and never writes start-up files, system folders,
 * Ensemble's own code or the home folder itself. Everything else is the run's mode to decide:
 * tool caches, other projects, temporary folders and device files like /dev/null included.
 */
export function outsideRefusal(real: string, write: boolean, home = HOME): string | null {
  if (harmlessPath(real)) return null;
  // The desktop app's data folder and this runtime's own (the testing CLI's, ENSEMBLE_DATA_HOME's): keys, database, browser profiles.
  if (isEnsembleData(real, { home })) return "Ensemble's own data is off limits.";
  // Ensemble's git helper runs with the person's GitHub token: nothing a run starts may touch it.
  if ([knownWorkspace(), configuredWorkspace()].some((workspace) => within(join(workspace, ".askpass"), real))) return "Ensemble's git sign-in helper is off limits.";
  // Copies of the files attached to tasks, made for the run to read.
  if (write && [knownWorkspace(), configuredWorkspace()].some((workspace) => within(join(workspace, "files"), real))) return "Attached files are read-only copies. Save your work in your own folder.";
  if (write && (within(ENSEMBLE_SOURCE, real) || within(real, ENSEMBLE_SOURCE))) return "This is Ensemble's own code: a run does not change it.";
  if (within(home, real, false)) {
    const secret = underHome(home, real, SECRET_PATHS);
    if (secret) return `~/${secret} holds keys, sign-ins or browser data.`;
    const startup = write ? underHome(home, real, STARTUP_PATHS) : undefined;
    if (startup) return `~/${startup} runs at sign-in or start-up, so a run does not change it.`;
    return null;
  }
  if (real === home) return write ? "Writing the home folder itself is refused." : null;
  if (inTemp(real)) return null;
  if (write) {
    for (const root of [...SYSTEM_ROOTS, ...windowsSystemRoots()]) {
      if (within(root, real)) return `${root} holds the operating system or installed apps.`;
    }
  }
  // Homebrew on Linux lives in its own account's folder; reading its programs is fine.
  if (!write && within("/home/linuxbrew", real)) return null;
  if (dirname(real) === "/Users" || dirname(real) === "/home" || (dirname(home) !== home && within(dirname(home), real) && !within(home, real) && !within("/Users/Shared", real))) {
    return "Another account's files are off limits.";
  }
  if (write && (real === "/" || real === dirname(home))) return "Writing at the top of the disk is refused.";
  return null;
}

/**
 * A folder that holds something no run may reach (keys and sign-ins, Ensemble's data, its git
 * helper, its own code): reading or writing inside it may be fine, but it is never handed to a run
 * as a whole folder, and never opened for writing in a sandbox.
 */
export function holdsProtected(real: string, home = HOME): boolean {
  const protectedPaths = [
    ...ensembleDataDenies({ home }),
    join(knownWorkspace(), ".askpass"),
    join(configuredWorkspace(), ".askpass"),
    ENSEMBLE_SOURCE,
    ...SECRET_PATHS.map((name) => join(home, name)),
  ];
  return protectedPaths.some((path) => within(real, path));
}

function windowsSystemRoots(): string[] {
  if (process.platform !== "win32") return [];
  return [process.env.SystemRoot, process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramData].filter((value): value is string => Boolean(value));
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
    // Windows paths use backslashes, so there a backslash is a character, not an escape.
    if (char === "\\" && i + 1 < line.length && process.platform !== "win32") {
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

/**
 * What a coding agent's command never starts: privilege, persistence, the keychain, the machine's
 * power, disks and system settings, and killing programs by name (`pkill node` would stop Ensemble
 * itself). Everyday developer tools (docker, nohup, tmux, open, kill with a process id) are the run's.
 */
const AGENT_NEVER = new Set([
  "sudo", "su", "doas", "launchctl", "defaults", "security", "systemsetup", "networksetup", "scutil", "dscl", "crontab",
  "shutdown", "reboot", "halt", "poweroff", "diskutil", "mount", "umount", "csrutil", "tccutil", "spctl", "pmset", "osascript",
  "killall", "pkill",
]);

/** Programs that reach another computer: the run's mode decides (asked in Ask and Review only, allowed unattended). */
const REMOTE_PROGRAMS = new Set(["ssh", "scp", "sftp", "ssh-add", "telnet", "nc", "ncat"]);

const programName = (program: string) => program.split(/[\\/]/).pop()!.replace(/\.exe$/i, "");

/** A program a coding agent's command may never start, by name or path (sudo, crontab, shutdown, …). */
export function isNeverProgram(program: string): boolean {
  return AGENT_NEVER.has(programName(program));
}

/** A program that opens a session on another computer (ssh, scp, nc, …). */
export function isRemoteProgram(program: string): boolean {
  return REMOTE_PROGRAMS.has(programName(program));
}

export interface CommandPolicy {
  who: "agent" | "human";
  sandboxed: boolean;
  network: boolean;
}

/**
 * Throws unless argv[0] may start. Returns the program name. An agent may start any program on the
 * PATH except the never-list (privilege, persistence, system settings); the person's terminal keeps
 * its allow-list.
 */
export function checkProgram(argv: string[], policy: CommandPolicy): string {
  const program = argv[0]!;
  if (program.includes("/") || program.includes("\\")) {
    throw new GuardError("Run programs by name (python, node, git…). Scripts run through their interpreter: python script.py, bash run.sh.");
  }
  if (policy.who === "agent") return checkAgentProgram(argv, policy);
  if (NEVER.has(program)) throw new GuardError(`${program} is not allowed here.`);
  if (program === "git") return program;
  if (program === "gh") {
    if (!policy.network) throw new GuardError("gh needs network access, which is off for this job.");
    return program;
  }
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

function checkAgentProgram(argv: string[], policy: CommandPolicy): string {
  // `env sudo …`, `nohup pkill …`, `timeout 5 ssh …`: the program that actually runs is judged.
  const inner = programArgv(argv);
  if (inner.length && inner[0] !== argv[0]) checkAgentProgram(inner, policy);
  const program = argv[0]!;
  if (isNeverProgram(program)) throw new GuardError(`${program} is not run by agents in Ensemble (privilege, persistence or system settings).${/pkill|killall/.test(program) ? " Stop a process with kill and its process id instead." : ""}`);
  if ((program === "gh" || NETWORK_TOOLS.includes(program) || isRemoteProgram(program)) && !policy.network) {
    throw new GuardError(`${program} needs network access, which is off for this job.`);
  }
  if (["bash", "sh", "zsh", "dash", "fish"].includes(program) && !policy.sandboxed) {
    throw new GuardError("Shell scripts and shell -c run in the sandbox. Run the programs one at a time, or turn the sandbox on for this run.");
  }
  return program;
}

export interface GitLimits {
  /** The person's git choice for the run: `local` (no commits) and `commit` (no push) are limits they picked; `push` has none. */
  delivery: "local" | "commit" | "push";
  /** In the OS sandbox: git config the person's own git would later run as a program is refused (it would run outside the sandbox). */
  sandboxed?: boolean;
}

const GIT_READ = new Set([
  "status", "log", "diff", "show", "rev-parse", "ls-files", "ls-tree", "blame", "describe", "shortlog", "grep",
  "reflog", "cat-file", "merge-base", "rev-list", "whatchanged", "version", "help",
]);
const GIT_NETWORK = new Set(["clone", "fetch", "pull", "ls-remote"]);

export type GitAction = "read" | "local" | "commit" | "push" | "network";

/** Subcommands that create, rewrite or move commits and tags. They count as commits for the run's git choice. */
const MAKES_COMMITS = new Set(["merge", "cherry-pick", "revert", "am", "rebase", "pull", "tag", "notes"]);
/** Stops an operation already in progress without creating a commit. */
const STOPS = ["--abort", "--quit", "--show-current-patch"];
/** Global options that take the next argument as their value. */
const GLOBAL_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path"]);
/**
 * Config keys a sandboxed run may write. Other keys can name a program (hooks, fsmonitor, filters,
 * ssh, editors, credential helpers, aliases) that git outside the sandbox would run later.
 */
const SANDBOX_CONFIG = /^(user\.(name|email|signingkey)|branch\.[^.]+\.(remote|merge|rebase|description|pushremote)|remote\.[^.]+\.(url|pushurl|fetch|push|tagopt|prune)|push\.(default|autosetupremote|followtags)|pull\.(rebase|ff)|fetch\.prune|init\.defaultbranch|core\.(autocrlf|eol|ignorecase|filemode|quotepath)|merge\.(ff|conflictstyle)|rebase\.(autostash|autosquash)|commit\.gpgsign|tag\.gpgsign|color\..+|log\..+|diff\.(renames|algorithm|colormoved))$/i;

function makesCommits(sub: string, rest: string[]): boolean {
  if (!MAKES_COMMITS.has(sub)) return false;
  const flags = new Set(rest.filter((arg) => arg.startsWith("-")));
  if (STOPS.some((flag) => flags.has(flag))) return false;
  if (sub === "tag") return rest.some((arg) => !arg.startsWith("-")) && !flags.has("-l") && !flags.has("--list") && !flags.has("--contains") && !flags.has("--points-at");
  if (sub === "notes") return !["list", "show"].includes(rest[0] ?? "list");
  if (sub === "pull" || sub === "merge") return !flags.has("--ff-only") && !flags.has("--no-commit") && !flags.has("--squash");
  if (sub === "cherry-pick" || sub === "revert") return !flags.has("-n") && !flags.has("--no-commit");
  return true;
}

/** The subcommand and its arguments, after git's global options (`-C dir`, `-c key=value`, `--no-pager`…). */
export function gitCommand(argv: string[]): { globals: string[]; sub: string; rest: string[] } {
  const args = argv.slice(1);
  let index = 0;
  while (args[index]?.startsWith("-")) index += GLOBAL_WITH_VALUE.has(args[index]!) ? 2 : 1;
  return { globals: args.slice(0, index), sub: args[index] ?? "", rest: args.slice(index + 1) };
}

/** The key a `git config` call writes, or null when it only reads. A write to another file counts as unknown. */
function configWrite(rest: string[]): string | null {
  const flags = rest.filter((arg) => arg.startsWith("-"));
  const words = rest.filter((arg) => !arg.startsWith("-"));
  if (["get", "list"].includes(words[0] ?? "")) return null;
  if (flags.some((flag) => ["--get", "--get-all", "--list", "-l", "--get-regexp", "--get-urlmatch"].includes(flag))) return null;
  if (flags.some((flag) => flag === "-f" || flag.startsWith("--file") || flag.startsWith("--blob"))) return "--file";
  if (["set", "unset", "replace-all", "rename-section", "remove-section"].includes(words[0] ?? "")) return words[1] ?? null;
  if (flags.some((flag) => /^--(unset|unset-all|add|replace-all|rename-section|remove-section)$/.test(flag))) return words[0] ?? null;
  return words.length >= 2 ? words[0]! : null;
}

/**
 * Classifies a git argv for the run's mode and internet setting. It refuses only what the person chose
 * against (commits with “Local only”, pushes with “Commit”) and, in the sandbox, config that would run a
 * program outside it. Any branch, push, force-push, delete, rebase or history change is otherwise the
 * person's and their agent's call.
 */
export function checkGit(argv: string[], limits: GitLimits): { sub: string; action: GitAction } {
  const { globals, sub, rest } = gitCommand(argv);
  if (!sub) throw new GuardError("Which git command?");
  if (limits.sandboxed) {
    for (let index = 0; index < globals.length; index += 1) {
      if (globals[index] === "-c" && !SANDBOX_CONFIG.test((globals[index + 1] ?? "").split("=")[0]!)) {
        throw new GuardError(`git -c ${(globals[index + 1] ?? "").split("=")[0]} is not run in the sandbox: that setting can start a program outside it. Turn the sandbox off for this run if you need it.`);
      }
    }
  }
  if (GIT_READ.has(sub)) return { sub, action: "read" };
  if (sub === "config") {
    const key = configWrite(rest);
    if (!key) return { sub, action: "read" };
    if (limits.sandboxed && !SANDBOX_CONFIG.test(key)) {
      throw new GuardError(`git config ${key} is not changed in the sandbox: git outside it would run what that setting names. Turn the sandbox off for this run if you need it.`);
    }
    return { sub, action: "local" };
  }
  if (sub === "commit" || makesCommits(sub, rest)) {
    if (limits.delivery === "local") {
      throw new GuardError(
        sub === "pull"
          ? "This run may not commit, and git pull can create a merge commit. Use git fetch, or git pull --ff-only. It was assigned with “Local only”."
          : `This run may not commit, and git ${sub} creates or rewrites commits. Leave your changes uncommitted. It was assigned with “Local only”.`,
      );
    }
    return { sub, action: sub === "pull" ? "network" : "commit" };
  }
  if (sub === "push") {
    if (limits.delivery !== "push") throw new GuardError("This run may not push: it was assigned with “Local only” or “Commit”. Finish without pushing.");
    return { sub, action: "push" };
  }
  if (GIT_NETWORK.has(sub) || (sub === "remote" && ["update", "prune"].includes(rest[0] ?? "")) || (sub === "submodule" && ["update", "add", "sync"].includes(rest[0] ?? ""))) return { sub, action: "network" };
  if (sub === "remote" && (!rest.length || rest[0] === "-v" || rest[0] === "--verbose" || rest[0] === "show" || rest[0] === "get-url")) return { sub, action: "read" };
  if (sub === "branch" && !rest.some((arg) => !arg.startsWith("-"))) return { sub, action: "read" };
  return { sub, action: "local" };
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

/**
 * Ensemble's own git askpass helper. It holds no token (the token is only in
 * the environment of Ensemble's git process), but a command that could rewrite
 * it would run with that token the next time. So it lives beside the cache,
 * never in it: no sandbox grant ever covers `<workspace>/.askpass`.
 */
export async function askpassPath(): Promise<string> {
  const dir = join(await workspaceRoot(), ".askpass");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return join(dir, "git-askpass.sh");
}

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
  if (process.platform === "win32") return windowsChildEnv(root, cache, safeHome, nodeDir, options.who);
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
 * Windows needs its system variables to start anything (SystemRoot, ComSpec,
 * PATHEXT). PATH is the person's own, minus anything inside the work folder.
 * Agents get the cache's home, AppData and temp folders, never the real ones,
 * and Git Credential Manager may not open a sign-in window.
 */
function windowsChildEnv(root: string, cache: string, safeHome: string, nodeDir: string, who: "agent" | "human"): NodeJS.ProcessEnv {
  const source = process.env;
  const pick = (name: string) => source[name] ?? source[name.toUpperCase()];
  const path = [nodeDir, ...(pick("Path") ?? pick("PATH") ?? "").split(";")]
    .filter((dir) => dir && !within(root, dir))
    .filter((dir, index, all) => all.indexOf(dir) === index)
    .join(";");
  const home = who === "human" ? HOME : safeHome;
  const temp = join(cache, "tmp");
  const env: NodeJS.ProcessEnv = {
    PATH: path,
    PATHEXT: pick("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD",
    SystemRoot: pick("SystemRoot") ?? "C:\\Windows",
    SystemDrive: pick("SystemDrive") ?? "C:",
    windir: pick("windir") ?? pick("SystemRoot") ?? "C:\\Windows",
    ComSpec: pick("ComSpec") ?? "C:\\Windows\\System32\\cmd.exe",
    ProgramData: pick("ProgramData"),
    ProgramFiles: pick("ProgramFiles"),
    "ProgramFiles(x86)": source["ProgramFiles(x86)"],
    NUMBER_OF_PROCESSORS: pick("NUMBER_OF_PROCESSORS"),
    PROCESSOR_ARCHITECTURE: pick("PROCESSOR_ARCHITECTURE"),
    OS: pick("OS"),
    USERNAME: pick("USERNAME"),
    HOME: home,
    USERPROFILE: home,
    APPDATA: who === "human" ? pick("APPDATA") : join(safeHome, "AppData", "Roaming"),
    LOCALAPPDATA: who === "human" ? pick("LOCALAPPDATA") : join(safeHome, "AppData", "Local"),
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    LANG: "en_US.UTF-8",
    CI: "1",
    NO_COLOR: "1",
    PAGER: "cat",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GCM_INTERACTIVE: "never",
    PIP_CACHE_DIR: join(cache, "pip"),
    UV_CACHE_DIR: join(cache, "uv"),
    npm_config_cache: join(cache, "npm"),
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONUNBUFFERED: "1",
    PYTHONUTF8: "1",
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return env;
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
    deny: [desktopDataDir({ platform: "darwin", home: HOME }), ...ensembleDataDenies()],
    network: options.network ? "outbound" : "none",
    who: options.who,
    ensembleSource: ENSEMBLE_SOURCE,
    askpassPath: await askpassPath(),
  });
}

/** This computer has a working OS sandbox (see `sandbox/spawn.ts`). Checked once at start; `prepareSandbox()` refreshes it. */
export function sandboxAvailable(): boolean {
  return capabilities().osSandbox;
}

/** Why a sandboxed run cannot start here, with the one step that would fix it. */
export function sandboxRefusal(): string {
  const caps = capabilities();
  const fix = caps.setup?.needed ? ` ${caps.setup.how}` : "";
  return `${caps.reason}${fix} Or turn off the sandbox for this run to work directly on the computer.`;
}

export function relativeTo(root: string, path: string): string {
  const rel = relative(root, path);
  return rel === "" ? "." : rel.split(sep).join("/");
}
