/**
 * The spawn contract every agent command and every plot goes through.
 *
 * `startSandboxed` (spawn.ts) is the only place a confined process starts.
 * Callers describe what the command may touch with a `SandboxPolicy`; the
 * backend for this computer turns it into an OS-native sandbox:
 * - macOS: Seatbelt (`seatbelt.ts`).
 * - Linux: bubblewrap when the system has it and user namespaces work, else
 *   Landlock through the bundled `landrun` helper (`linux.ts`).
 * - Windows: a dedicated sandbox account with folder grants and a network
 *   fence, from Anthropic's sandbox-runtime (`windows.ts`). One admin prompt
 *   sets it up per computer.
 * No backend needs Docker or a VM. Callers never build sandbox arguments.
 *
 * The app's own git (clone, fetch, push) does not use this interface. That
 * process is the only one allowed to see a git token, and it is not an agent
 * command. See `git-gate.ts`.
 */
import type { ChildProcess } from "node:child_process";

export type NetworkPolicy = "none" | "loopback" | "outbound";

export interface SandboxPolicy {
  runId: string;
  cwd: string;
  /** Canonical paths the command may write. Deny entries win over these. */
  readWrite: string[];
  /** Canonical paths the command may read and must not write. */
  readOnly: string[];
  /** Always wins, including the desktop app-data folder. */
  deny: string[];
  network: NetworkPolicy;
  env: NodeJS.ProcessEnv;
  who: "agent" | "human";
  home: string;
  ensembleSource: string;
  appDataDir: string;
  /** Git askpass script. Denied to the child even when it lives in the cache. */
  askpassPath?: string;
  toolchainReads?: string[];
  /**
   * Apply this computer's OS sandbox. When it has none (see
   * `capabilities()`), a confined spawn is refused; plots may pass
   * `advisoryOk` and are marked not safe.
   */
  confined: boolean;
  advisoryOk?: boolean;
  /** Merged into the Seatbelt process-exec deny. Ignored where there is no OS sandbox. */
  extraExecDeny?: string[];
}

export interface SpawnCommand {
  /** Absolute path of the program. Arguments are the program's argv, without argv[0]. */
  program: string;
  args: string[];
}

export type SandboxMechanism = "seatbelt" | "bubblewrap" | "landlock" | "windows" | "none";

export interface PlatformCaps {
  os: string;
  /**
   * What the UI may say. `strong`: files, secrets and the network are all
   * enforced by the OS. `reduced`: files are enforced, something else is not
   * (listed in `limits`). `advisory`: no OS sandbox on this computer. `ask`:
   * kept for older runtimes that reported Windows this way.
   */
  strength: "strong" | "reduced" | "advisory" | "ask";
  osSandbox: boolean;
  mechanism: SandboxMechanism;
  /** Shown as-is: which sandbox, or why there is none. */
  reason: string;
  /** What this backend cannot enforce on this computer, in plain words. */
  limits?: string[];
  /** Whether "network off" is enforced by the OS here. */
  networkOff?: boolean;
  /** Set when one step would turn the sandbox on (Windows: one admin prompt). */
  setup?: { needed: boolean; how: string };
}

export interface PreparedSpawn {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  sandboxed: boolean;
  caps: PlatformCaps;
  /** Windows: the args are an already-escaped cmd.exe line; Node must not quote them again. */
  windowsVerbatimArguments?: boolean;
}

export interface SandboxBackend {
  capabilities(): PlatformCaps;
  /**
   * Apply `policy` and exec `cmd`. The returned child is already confined
   * on platforms where `capabilities().osSandbox` is true.
   */
  start(policy: SandboxPolicy, cmd: SpawnCommand): ChildProcess;
}
