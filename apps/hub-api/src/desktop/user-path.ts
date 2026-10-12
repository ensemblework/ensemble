/**
 * The PATH this computer's runtime gives agents and the commands they run. Started by the login
 * service or by the desktop app (a GUI app), the runtime inherits the system's minimal PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin` on macOS), which misses the person's own tools: Claude Code and
 * Cursor's agent in ~/.local/bin, Homebrew, npm's global folder, nvm. So at start the runtime asks
 * the person's login shell for its PATH once, as VS Code does, and adds the usual install folders.
 * A folder inside the workspace never counts: a repository must not be able to plant a `git`.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve, sep } from "node:path";

const MARK = "__ENSEMBLE_PATH__";
const SHELL_TIMEOUT_MS = 4000;

/** Where agent CLIs and toolchains usually install, for this system. */
export function knownToolDirs(platform: NodeJS.Platform = process.platform, home = homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === "win32") {
    // Claude Code's native installer and npm's global folder.
    return [join(home, ".local", "bin"), join(env.APPDATA ?? join(home, "AppData", "Roaming"), "npm")];
  }
  return [
    // Claude Code's and Cursor's installers; an older Claude Code local install.
    join(home, ".local", "bin"),
    join(home, ".claude", "local"),
    ...(platform === "darwin" ? ["/opt/homebrew/bin", "/opt/homebrew/sbin"] : ["/home/linuxbrew/.linuxbrew/bin", "/snap/bin"]),
    "/usr/local/bin",
    join(home, ".npm-global", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".volta", "bin"),
    ...nvmBins(home),
  ];
}

/** nvm's Node versions, newest first. */
function nvmBins(home: string): string[] {
  const root = join(home, ".nvm", "versions", "node");
  try {
    const versions = readdirSync(root).filter((name) => /^v\d+/.test(name));
    const number = (name: string) => name.slice(1).split(".").map((part) => Number.parseInt(part, 10) || 0);
    versions.sort((a, b) => {
      const [x, y] = [number(a), number(b)];
      for (let index = 0; index < 3; index += 1) if ((x[index] ?? 0) !== (y[index] ?? 0)) return (y[index] ?? 0) - (x[index] ?? 0);
      return 0;
    });
    return versions.map((name) => join(root, name, "bin"));
  } catch {
    return [];
  }
}

/** The PATH a login shell printed between our markers, or null. */
export function pathFromShellOutput(output: string): string | null {
  const start = output.indexOf(MARK);
  const end = start >= 0 ? output.indexOf(MARK, start + MARK.length) : -1;
  if (start < 0 || end < 0) return null;
  const path = output.slice(start + MARK.length, end).trim();
  return path || null;
}

/** The person's login shell's PATH (their rc files run, as in their terminal), or null after a few seconds. */
export function loginShellPath(shell: string, timeoutMs = SHELL_TIMEOUT_MS): Promise<string | null> {
  return new Promise((done) => {
    let output = "";
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      // printenv prints the exported PATH, joined with ":", in fish as in zsh and bash.
      child = spawn(shell, ["-ilc", `echo ${MARK}; printenv PATH; echo ${MARK}`], {
        stdio: ["ignore", "pipe", "ignore"],
        detached: true,
        env: { ...process.env, ENSEMBLE_RESOLVING_SHELL: "1" },
      });
    } catch {
      finish(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      finish(pathFromShellOutput(output));
    }, timeoutMs);
    timer.unref();
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const found = pathFromShellOutput(output);
      if (found) finish(found);
    });
    child.once("error", () => finish(null));
    child.once("close", () => finish(pathFromShellOutput(output)));
  });
}

/** Absolute folders, each once, in order; none inside the workspace. Known install folders only if they exist. */
export function mergePath(sources: { entries: string[]; mustExist?: boolean }[], workspaceRoot: string | undefined, separator = delimiter): string {
  const root = workspaceRoot ? resolve(workspaceRoot) : null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const source of sources) {
    for (const raw of source.entries) {
      const entry = raw.trim();
      if (!entry || !isAbsolute(entry)) continue;
      const normal = resolve(entry);
      if (root && (normal === root || normal.startsWith(root.endsWith(sep) ? root : root + sep))) continue;
      if (seen.has(normal)) continue;
      if (source.mustExist && !existsSync(normal)) continue;
      seen.add(normal);
      out.push(entry);
    }
  }
  return out.join(separator);
}

/** The bare PATH a login service or a GUI app starts with. */
const SYSTEM_DIRS = new Set(["/usr/bin", "/bin", "/usr/sbin", "/sbin"]);

/** Started with only the system's folders (a login service, a GUI app), not from the person's terminal. */
export function bareSystemPath(path: string): boolean {
  const entries = path.split(delimiter).filter(Boolean);
  return entries.length > 0 && entries.every((entry) => SYSTEM_DIRS.has(entry.replace(/\/+$/, "")));
}

/**
 * The PATH to run with. Started from the person's terminal, its PATH already is theirs (an `nvm use`
 * included) and comes first; started with the bare system PATH, the login shell's comes first.
 * The usual install folders come last.
 */
export async function userToolPath(input: { workspaceRoot?: string; platform?: NodeJS.Platform; home?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const home = input.home ?? homedir();
  const current = env.PATH ?? env.Path ?? "";
  const shell = env.SHELL || (platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  // Already resolving (a login shell that starts this runtime): do not recurse. Tests turn it off.
  const login = platform === "win32" || env.ENSEMBLE_RESOLVING_SHELL || env.ENSEMBLE_LOGIN_SHELL_PATH === "0" ? null : await loginShellPath(shell);
  const fromShell = { entries: login ? login.split(delimiter) : [] };
  const fromProcess = { entries: current.split(delimiter) };
  return mergePath(
    [...(bareSystemPath(current) ? [fromShell, fromProcess] : [fromProcess, fromShell]), { entries: knownToolDirs(platform, home, env), mustExist: true }],
    input.workspaceRoot,
  );
}
