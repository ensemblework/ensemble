/**
 * macOS Seatbelt profile for one command.
 *
 * `(allow default)` keeps system reads working (dyld, mach services, Xcode,
 * Homebrew, Rosetta). `$HOME` is then denied, and only the workspace, the
 * cache, explicit grants, and toolchain subfolders are opened again. Deny
 * rules for secrets and app data are more specific than those allows, so
 * they still win. The Never set is denied with `process-exec`, which the
 * child inherits, so `python -c` cannot start `open` or `ssh`.
 *
 * Unix-domain `connect` is `network-outbound` with a `unix-socket` filter.
 * An IP-only deny does not cover the Docker socket or the agent sockets.
 */
import { dirname, join, relative, sep } from "node:path";

/** Binaries the profile refuses to exec, whatever argv[0] the parent used. */
export const NEVER_EXECUTABLES = [
  "/usr/bin/open",
  "/bin/open",
  "/usr/bin/osascript",
  "/usr/bin/sudo",
  "/usr/bin/su",
  "/usr/bin/security",
  "/bin/launchctl",
  "/usr/bin/launchctl",
  "/usr/bin/defaults",
  "/usr/sbin/systemsetup",
  "/usr/sbin/networksetup",
  "/usr/sbin/scutil",
  "/usr/bin/dscl",
  "/usr/bin/crontab",
  "/usr/bin/killall",
  "/usr/bin/pkill",
  "/sbin/shutdown",
  "/sbin/reboot",
  "/sbin/halt",
  "/usr/sbin/diskutil",
  "/sbin/mount",
  "/sbin/umount",
  "/usr/sbin/chown",
  "/usr/bin/chflags",
  "/usr/bin/xattr",
  "/usr/sbin/spctl",
  "/usr/bin/csrutil",
  "/usr/bin/tccutil",
  "/usr/bin/pmset",
  "/usr/bin/ssh",
  "/usr/bin/scp",
  "/usr/bin/sftp",
  "/usr/bin/ssh-add",
  "/usr/bin/nc",
  "/usr/bin/telnet",
  "/usr/bin/docker",
  "/usr/local/bin/docker",
  "/opt/homebrew/bin/docker",
  "/Applications/Docker.app/Contents/Resources/bin/docker",
];

export const SECRET_HOME_PATHS = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".ensemble",
  ".netrc",
  ".git-credentials",
  ".config/gh",
  ".kube",
  ".docker",
  ".npmrc",
  "Library/Keychains",
  "Library/Cookies",
  "Library/Safari",
  "Library/Application Support/Google",
  "Library/Application Support/Firefox",
  "Library/Application Support/Cursor",
  "Library/Application Support/Code",
  "Library/Application Support/Arc",
  "Library/Application Support/BraveSoftware",
  "Library/Messages",
  "Library/Mail",
  "Library/LaunchAgents",
];

/** Read-only exceptions under `$HOME`. Writes stay denied. */
export const TOOLCHAIN_HOME_READS = [
  ".nvm",
  ".pyenv",
  ".asdf",
  ".local",
  ".rustup",
  ".cargo",
  ".volta",
  ".fnm",
  "Library/Caches",
  "miniconda3",
  "anaconda3",
  ".nix-profile",
  "Library/Developer",
];

const HUMAN_SIGN_IN = [".ssh", ".config/gh", "Library/Keychains"];

export interface SeatbeltPolicy {
  home: string;
  readWrite: string[];
  readOnly: string[];
  deny: string[];
  network: "none" | "loopback" | "outbound";
  who: "agent" | "human";
  ensembleSource: string;
  toolchainReads?: string[];
  askpassPath?: string;
  /** Extra binaries denied with process-exec. Plots deny shells so os.system cannot escape. */
  extraExecDeny?: string[];
}

function quote(path: string): string {
  if (path.includes('"') || path.includes("\n") || path.includes("\\")) {
    throw new Error(`Paths with quotes cannot be sandboxed: ${path}`);
  }
  return `"${path}"`;
}

/**
 * Node installed under the home directory (nvm, the GitHub runner's
 * hosted tool cache) has to be readable or `node -e` cannot start. The
 * allow is that install's top folder, never `$HOME` itself, and never
 * `Library/Application Support`.
 */
export function nodeToolchainRead(home: string, execPath = process.execPath): string | null {
  const dir = dirname(execPath);
  const rel = relative(home, dir);
  if (!rel || rel.startsWith("..") || rel === "") return null;
  const top = rel.split(sep)[0] ?? "";
  if (!top || top.startsWith(".")) return dir;
  if (top === "Library") return dir;
  if (["Documents", "Desktop", "Downloads", "Pictures", "Movies", "Music"].includes(top)) return null;
  return join(home, top);
}

export function compileSeatbeltProfile(policy: SeatbeltPolicy): string {
  const writes = [...policy.readWrite, "/private/var/folders", "/private/tmp", "/tmp"];
  const writeFilters = [
    ...writes.map((path) => `(subpath ${quote(path)})`),
    `(literal "/dev/null")`,
    `(literal "/dev/zero")`,
    `(regex #"^/dev/tty")`,
    `(regex #"^/dev/fd/")`,
    `(literal "/dev/stdout")`,
    `(literal "/dev/stderr")`,
  ];
  const secrets = SECRET_HOME_PATHS.filter((name) => policy.who === "agent" || !HUMAN_SIGN_IN.includes(name)).map((name) =>
    join(policy.home, name),
  );
  const hardDeny = [...policy.deny, ...secrets, policy.ensembleSource, ...(policy.askpassPath ? [policy.askpassPath] : [])];
  const reads = [
    ...policy.readWrite,
    ...policy.readOnly,
    ...TOOLCHAIN_HOME_READS.map((name) => join(policy.home, name)),
    ...(policy.toolchainReads ?? []),
  ];
  const network =
    policy.network === "none"
      ? "(deny network*)"
      : policy.network === "loopback"
        ? '(deny network-outbound (require-not (remote ip "localhost:*")))'
        : '(deny network-outbound (remote ip "localhost:*"))';
  const execDeny = [...NEVER_EXECUTABLES, ...(policy.extraExecDeny ?? [])];
  const lines = [
    "(version 1)",
    "(allow default)",
    ";; Writes only inside the grants and the system temp directories.",
    `(deny file-write* (require-not (require-any ${writeFilters.join(" ")})))`,
    ";; $HOME is denied by default. System paths stay allowed by (allow default).",
    `(deny file-read* (subpath ${quote(policy.home)}))`,
    ";; Re-allow the workspace, explicit grants, and toolchain subfolders.",
    `(allow file-read* ${reads.map((path) => `(subpath ${quote(path)})`).join(" ")})`,
    ";; More specific than the allows above: secrets, app data, Ensemble, askpass.",
    `(deny file-read* file-write* ${hardDeny.map((path) => `(subpath ${quote(path)})`).join(" ")})`,
    ";; The Never tier. Children of python, node, make, npm, and sh inherit this.",
    `(deny process-exec ${execDeny.map((path) => `(literal ${quote(path)})`).join(" ")})`,
    ";; open(1) hands the file to LaunchServices, which runs it outside the sandbox.",
    '(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd"))',
    '(deny mach-lookup (global-name "com.apple.lsd.mapdb"))',
    '(deny mach-lookup (global-name "com.apple.coreservices.appleevents"))',
    ";; (remote ip) does not match a Unix socket. Docker, ssh-agent, gpg-agent, 1Password.",
    "(deny network-outbound (remote unix-socket))",
    network,
  ];
  for (const root of policy.readWrite) {
    const hooks = join(root, ".git", "hooks").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    lines.push(`(deny file-write* (regex #"^${hooks}/.+"))`);
  }
  return lines.join("\n");
}
