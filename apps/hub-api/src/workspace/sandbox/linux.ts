/**
 * Linux sandboxes. Nothing to install, no Docker, no VM.
 *
 * 1. bubblewrap, when the distribution ships `bwrap` and unprivileged user
 *    namespaces work (Fedora, Debian and most desktops). The system is
 *    mounted read-only, the home folder is replaced by an empty one with only
 *    the grants and toolchain folders mounted back, `/tmp` is private, and
 *    the command gets its own PID namespace. With the network off it also
 *    gets an empty network namespace. Agent sockets under `/run/user` and the
 *    Docker socket are hidden.
 * 2. Landlock, through `landrun` (MIT, github.com/zouuup/landrun), which
 *    Ensemble ships as a static binary. Landlock is in the default kernel of
 *    every major distribution and needs no privileges, so it is the fallback
 *    where bubblewrap is missing or blocked (Ubuntu 24.04 restricts user
 *    namespaces with AppArmor). It only grants: anything not granted (the
 *    rest of the home folder, other projects, Ensemble's data) is denied. It
 *    turns the network off only on kernel 6.7 and later (Landlock TCP rules),
 *    and it does not hide Unix sockets before kernel 6.12-era ABIs.
 *
 * The probe runs once per runtime (`probeLinux`) and is cached.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, release, tmpdir } from "node:os";
import { posix } from "node:path";
import type { SandboxPolicy, SpawnCommand } from "./policy.js";
import { nodeToolchainRead } from "./seatbelt.js";

// Linux paths, whatever system builds the arguments (the unit tests run on Windows too).
const { dirname, isAbsolute, join, relative } = posix;
const delimiter = ":";

/** Folders the system's programs and libraries live in. Read and exec. */
export const LINUX_SYSTEM_EXEC = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/opt", "/nix", "/snap", "/home/linuxbrew"];
/** Read-only system data. `/run/systemd/resolve` and friends hold resolv.conf targets. */
export const LINUX_SYSTEM_READ = ["/etc", "/proc", "/sys", "/run/systemd/resolve", "/run/resolvconf", "/run/NetworkManager", "/var/lib/ca-certificates"];
/** Toolchains people install under their home folder. Read and exec, never write. */
export const LINUX_TOOLCHAIN_HOME = [
  ".nvm",
  ".pyenv",
  ".asdf",
  ".local/bin",
  ".local/lib",
  ".local/pipx",
  ".rustup",
  ".cargo",
  ".volta",
  ".fnm",
  ".bun",
  ".deno",
  ".sdkman",
  ".go",
  "go",
  ".npm-global",
  "miniconda3",
  "anaconda3",
  "miniforge3",
  ".nix-profile",
  ".linuxbrew",
];
/** Sockets that hand out a root-equivalent API. Hidden even though `/` is mounted. */
const ROOT_SOCKETS = ["/var/run/docker.sock", "/run/docker.sock", "/run/podman/podman.sock", "/run/containerd/containerd.sock"];

export type LinuxBackend =
  | { backend: "bubblewrap"; bwrap: string }
  | { backend: "landlock"; landrun: string; networkOff: boolean }
  | { backend: "none"; reason: string };

type Exists = (path: string) => boolean;

/** bubblewrap mounts over a path only through its real location: `/var/run` is a link to `/run` on most systems. */
function realPathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function covers(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function onPath(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

/** The distribution's bubblewrap. A copy elsewhere would not get Ubuntu's AppArmor profile, so only the system one is used. */
export function findBwrap(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.ENSEMBLE_BWRAP === "off") return null;
  for (const candidate of ["/usr/bin/bwrap", "/bin/bwrap"]) if (existsSync(candidate)) return candidate;
  return onPath("bwrap", env);
}

/** The bundled helper next to the sidecar's Node (`<sidecar>/bin/landrun`), or one named by ENSEMBLE_LANDRUN. */
export function findLandrun(env: NodeJS.ProcessEnv = process.env, execPath = process.execPath): string | null {
  if (env.ENSEMBLE_LANDRUN === "off") return null;
  const candidates = [env.ENSEMBLE_LANDRUN, join(dirname(execPath), "bin", "landrun"), join(dirname(execPath), "..", "bin", "landrun")].filter(
    (value): value is string => Boolean(value?.trim()),
  );
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // try the next
    }
  }
  return onPath("landrun", env);
}

/** Kernel 6.7 brought Landlock's TCP rules (ABI 4): before it, Landlock cannot turn the network off. */
export function kernelHasLandlockNetwork(kernel = release()): boolean {
  const match = kernel.match(/^(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 6 || (major === 6 && minor >= 7);
}

function noComma(path: string): string {
  if (path.includes(",")) throw new Error(`Paths with commas cannot be sandboxed on Linux: ${path}`);
  return path;
}

function toolchainReads(policy: SandboxPolicy, execPath: string, exists: Exists): string[] {
  const found = LINUX_TOOLCHAIN_HOME.map((name) => join(policy.home, name)).filter(exists);
  const node = nodeToolchainRead(policy.home, execPath);
  if (node) found.push(node);
  for (const extra of policy.toolchainReads ?? []) if (exists(extra)) found.push(extra);
  return [...new Set(found)];
}

/** Paths that must stay unreachable however the grants are drawn. */
function hardDenies(policy: SandboxPolicy): string[] {
  return [...new Set([...policy.deny, policy.appDataDir, policy.ensembleSource, ...(policy.askpassPath ? [policy.askpassPath] : [])])];
}

/** The program's own folder, when no grant covers it (a tool in ~/bin, say). Never a denied place. */
function programDir(cmd: SpawnCommand, roots: string[], denies: string[], home: string): string | null {
  if (!isAbsolute(cmd.program)) return null;
  const dir = dirname(cmd.program);
  if (roots.some((root) => covers(root, dir))) return null;
  if (dir === home || denies.some((deny) => covers(deny, dir) || covers(dir, deny))) return null;
  return dir;
}

export function bubblewrapArgs(
  policy: SandboxPolicy,
  cmd: SpawnCommand,
  options: { exists?: Exists; execPath?: string; real?: (path: string) => string } = {},
): string[] {
  const exists = options.exists ?? existsSync;
  const realOr = options.real ?? realPathOr;
  const execPath = options.execPath ?? process.execPath;
  const home = policy.home;
  const args = ["--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try"];
  if (policy.network !== "outbound") args.push("--unshare-net");
  args.push("--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp");
  // The home folder is empty except for what is mounted back below.
  args.push("--tmpfs", home);
  if (exists("/run/user")) args.push("--tmpfs", realOr("/run/user"));
  for (const socket of new Set(ROOT_SOCKETS.filter(exists).map(realOr))) args.push("--ro-bind", "/dev/null", socket);
  const toolchain = toolchainReads(policy, execPath, exists);
  const denies = hardDenies(policy);
  const extra = programDir(cmd, [...LINUX_SYSTEM_EXEC, ...toolchain, ...policy.readOnly, ...policy.readWrite], denies, home);
  for (const path of [...toolchain, ...(extra ? [extra] : [])]) args.push("--ro-bind", path, path);
  for (const path of policy.readOnly) args.push("--ro-bind-try", path, path);
  for (const path of policy.readWrite) args.push("--bind-try", path, path);
  // Deny wins: re-cover denied places that a grant reaches or that sit outside the home folder.
  const grants = [...toolchain, ...policy.readOnly, ...policy.readWrite];
  for (const listed of denies) {
    if (!exists(listed)) continue;
    const deny = realOr(listed);
    if (covers(home, deny) && !grants.some((grant) => covers(grant, deny))) continue;
    let directory = true;
    try {
      directory = statSync(deny).isDirectory();
    } catch {
      directory = true;
    }
    if (directory) args.push("--tmpfs", deny);
    else args.push("--ro-bind", "/dev/null", deny);
  }
  // A plot may not start a shell: the binary is covered by an empty device node.
  for (const path of policy.extraExecDeny ?? []) if (exists(path)) args.push("--ro-bind", "/dev/null", realOr(path));
  args.push("--chdir", policy.cwd, "--", cmd.program, ...cmd.args);
  return args;
}

export function landrunArgs(
  policy: SandboxPolicy,
  cmd: SpawnCommand,
  env: NodeJS.ProcessEnv,
  options: { exists?: Exists; execPath?: string } = {},
): string[] {
  const exists = options.exists ?? existsSync;
  const execPath = options.execPath ?? process.execPath;
  const denies = hardDenies(policy);
  const toolchain = toolchainReads(policy, execPath, exists);
  const grants = [...toolchain, ...policy.readOnly, ...policy.readWrite];
  // Landlock can only grant. A grant that contains a denied place would expose it, so refuse.
  for (const grant of grants) {
    if (grant === policy.home || covers(grant, policy.home)) throw new Error(`The sandbox will not grant ${grant}: it contains the home folder.`);
    for (const deny of denies) {
      if (covers(grant, deny)) throw new Error(`The sandbox will not grant ${grant}: it contains ${deny}.`);
    }
  }
  const extra = programDir(cmd, [...LINUX_SYSTEM_EXEC, ...grants], denies, policy.home);
  const args = ["--best-effort", "--ignore-missing", "--log-level", "error"];
  for (const path of [...LINUX_SYSTEM_EXEC.filter(exists), ...toolchain, ...(extra ? [extra] : []), ...policy.readOnly]) args.push("--rox", noComma(path));
  for (const path of LINUX_SYSTEM_READ.filter(exists)) args.push("--ro", noComma(path));
  args.push("--rw", "/dev", "--rwx", "/tmp");
  for (const path of policy.readWrite) args.push("--rwx", noComma(path));
  if (policy.network === "outbound") args.push("--unrestricted-network");
  for (const key of Object.keys(env)) if (env[key] !== undefined) args.push("--env", key);
  args.push("--", cmd.program, ...cmd.args);
  return args;
}

function run(program: string, args: string[], env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" }): number {
  const result = spawnSync(program, args, { env, stdio: "ignore", timeout: 8_000 });
  return result.status ?? 1;
}

/**
 * Which backend works here, proved by running it: bubblewrap must start a
 * command with a private network; Landlock must refuse a write outside its
 * grant and allow a rename between two granted folders (ABI 2, which `mv`
 * and `npm install` need).
 */
export function probeLinux(env: NodeJS.ProcessEnv = process.env): LinuxBackend {
  const shell = existsSync("/bin/sh") ? "/bin/sh" : "/usr/bin/sh";
  const bwrap = findBwrap(env);
  const reasons: string[] = [];
  if (bwrap) {
    // The same arguments a real command gets, so a quirk of this system (a socket behind a link, say) shows here, not on every command.
    const scratch = mkdtempSync(join(env.TMPDIR || tmpdir(), "ensemble-bwrap-"));
    let code = 1;
    try {
      const home = env.HOME || homedir();
      const policy: SandboxPolicy = {
        runId: "probe",
        cwd: scratch,
        readWrite: [scratch],
        readOnly: [],
        deny: [],
        network: "none",
        env: {},
        who: "agent",
        home,
        ensembleSource: join(scratch, "no-source"),
        appDataDir: join(scratch, "no-data"),
        confined: true,
      };
      code = run(bwrap, bubblewrapArgs(policy, { program: shell, args: ["-c", "exit 0"] }));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    if (code === 0) return { backend: "bubblewrap", bwrap };
    reasons.push("bubblewrap is installed but cannot start (user namespaces are restricted here)");
  } else {
    reasons.push("bubblewrap is not installed");
  }
  const landrun = findLandrun(env);
  if (!landrun) {
    reasons.push("the Landlock helper is not bundled with this install");
    return { backend: "none", reason: `No Linux sandbox: ${reasons.join("; ")}.` };
  }
  const scratch = mkdtempSync(join(env.TMPDIR || tmpdir(), "ensemble-landlock-"));
  const outside = mkdtempSync(join(env.TMPDIR || tmpdir(), "ensemble-landlock-out-"));
  try {
    const base = ["--best-effort", "--rox", "/usr,/bin,/lib", "--ignore-missing", "--rox", "/lib64", "--rwx", scratch];
    const leaked = run(landrun, [...base, "--", shell, "-c", `echo x > '${join(outside, "leak")}'`]);
    if (leaked === 0 || existsSync(join(outside, "leak"))) {
      reasons.push("Landlock is not enabled in this kernel");
      return { backend: "none", reason: `No Linux sandbox: ${reasons.join("; ")}.` };
    }
    writeFileSync(join(scratch, "probe"), "x");
    const moved = run(landrun, [...base, "--", shell, "-c", `mkdir -p '${scratch}/a' '${scratch}/b' && mv '${scratch}/probe' '${scratch}/a/p' && mv '${scratch}/a/p' '${scratch}/b/p'`]);
    if (moved !== 0) {
      reasons.push("this kernel's Landlock is too old to rename files between folders (needs Linux 5.19 or later)");
      return { backend: "none", reason: `No Linux sandbox: ${reasons.join("; ")}.` };
    }
    return { backend: "landlock", landrun, networkOff: kernelHasLandlockNetwork() };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
}
