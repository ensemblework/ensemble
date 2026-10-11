import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { desktopDiscoveryPath } from "@ensemble/shared-types/desktop-discovery";

/**
 * Port, token, process id and which launcher started it (`desktop` or `cli`),
 * mode 0600, in the OS app-data folder unless ENSEMBLE_DISCOVERY_FILE is set.
 * The desktop app and the CLI runner read the same file to attach to one runtime.
 */
export function writeDiscoveryFile(port: number, token: string): string {
  const file = desktopDiscoveryPath({
    platform: process.platform,
    home: homedir(),
    env: process.env,
  });
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const owner = process.env.ENSEMBLE_RUNTIME_OWNER?.trim() || "desktop";
  const mode = process.env.ENSEMBLE_RUNTIME_MODE === "admin" ? "admin" : "runner";
  const version = process.env.ENSEMBLE_APP_VERSION?.trim() || undefined;
  writeFileSync(file, `${JSON.stringify({ port, token, pid: process.pid, owner, mode, ...(version ? { version } : {}) })}\n`, { mode: 0o600 });
  try {
    chmodSync(dirname(file), 0o700);
  } catch {
    // Windows does not use POSIX modes.
  }
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows does not use POSIX modes.
  }
  return file;
}
