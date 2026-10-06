import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { desktopDiscoveryPath } from "@ensemble/shared-types/desktop-discovery";

/** Port, token and process id, mode 0600, in the OS app-data folder unless ENSEMBLE_DISCOVERY_FILE is set. */
export function writeDiscoveryFile(port: number, token: string): string {
  const file = desktopDiscoveryPath({
    platform: process.platform,
    home: homedir(),
    env: process.env,
  });
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify({ port, token, pid: process.pid })}\n`, { mode: 0o600 });
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
