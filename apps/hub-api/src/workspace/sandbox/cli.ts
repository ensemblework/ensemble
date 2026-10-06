/**
 * Plot spawn. Python calls this; it does not import the database or the guard.
 *
 * The child is the person's own Python, with no network and writes only in the
 * plot folder. On Linux `advisoryOk` runs it unsandboxed and the environment
 * says so (`ENSEMBLE_OS_SANDBOX=advisory`). That is not safe. macOS applies the
 * same Seatbelt profile as an agent command.
 *
 * `ENSEMBLE_GIT_TOKEN` and every other credential variable are scrubbed here.
 * The plot process is not the app's git.
 */
import { homedir } from "node:os";
import { dirname } from "node:path";
import { desktopDataDir } from "@ensemble/shared-types/desktop-discovery";
import { capabilities, startSandboxed } from "./spawn.js";

/** Shells a plot must not exec. `os.system` is `/bin/sh -c`. */
export const PLOT_SHELLS = ["/bin/sh", "/bin/bash", "/bin/zsh", "/usr/bin/bash", "/usr/bin/zsh", "/bin/dash"];

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function repeated(name: string): string[] {
  const values: string[] = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1] && !process.argv[index + 1]!.startsWith("--")) {
      values.push(process.argv[index + 1]!);
      index += 1;
    }
  }
  return values;
}

const root = flag("--root");
const python = flag("--python");
const script = flag("--script");
const worker = process.argv.includes("--worker");
if (!root || !python || !script) {
  process.stderr.write("usage: sandbox-cli --root DIR --python EXE --script FILE [--read-only DIR] [--worker]\n");
  process.exit(2);
}

const home = homedir();
const caps = capabilities();
const env: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: root,
  PLOTS_ROOT: root,
  ENSEMBLE_OS_SANDBOX: caps.osSandbox ? "seatbelt" : "advisory",
};
const { child } = startSandboxed(
  {
    runId: worker ? "plot-worker" : "plot",
    cwd: root,
    readWrite: [root, ...repeated("--read-write")],
    readOnly: [...repeated("--read-only"), dirname(script)],
    deny: ["/etc/passwd", "/private/etc/passwd"],
    network: "none",
    env,
    who: "agent",
    home,
    ensembleSource: desktopDataDir({ platform: process.platform, home }),
    appDataDir: desktopDataDir({ platform: process.platform, home }),
    confined: true,
    advisoryOk: true,
    extraExecDeny: PLOT_SHELLS,
  },
  { program: python, args: [script] },
  worker ? { detached: false, stdin: "pipe" } : {},
);
if (worker && child.stdin) process.stdin.pipe(child.stdin);
child.stdout?.pipe(process.stdout);
child.stderr?.pipe(process.stderr);
child.on("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
child.on("close", (code) => {
  process.exit(code ?? 1);
});
