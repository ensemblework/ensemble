/**
 * The spawn interface the Linux helper will implement later.
 *
 * Doc 24 §3.1 describes a Rust `Sandbox` trait in the Tauri core and a tiny
 * `ensemble-sbx` helper. Desktop step 2 keeps that interface in the Node sidecar:
 * every agent command and every plot goes through `startSandboxed`. Nothing else
 * execs `sandbox-exec`. When step 4 lands, `prepareSpawn` on Linux is replaced
 * by a request that asks the core to exec `ensemble-sbx` with this same policy.
 * The policy is the contract. Callers do not build Seatbelt text themselves.
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
   * macOS applies Seatbelt. Other platforms have no OS sandbox yet.
   * Agent jobs refuse to run in that state. Plots may pass `advisoryOk`
   * and are marked not safe.
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

export interface PlatformCaps {
  os: string;
  /** What the UI may say. Linux is advisory until ensemble-sbx exists. */
  strength: "strong" | "reduced" | "advisory" | "ask";
  osSandbox: boolean;
  mechanism: "seatbelt" | "none";
  /** Shown as-is. Linux must say the confinement is not safe yet. */
  reason: string;
}

export interface PreparedSpawn {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  sandboxed: boolean;
  caps: PlatformCaps;
}

export interface SandboxBackend {
  capabilities(): PlatformCaps;
  /**
   * Apply `policy` and exec `cmd`. The returned child is already confined
   * on platforms where `capabilities().osSandbox` is true.
   */
  start(policy: SandboxPolicy, cmd: SpawnCommand): ChildProcess;
}
