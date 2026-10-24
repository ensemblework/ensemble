/**
 * Whether Ensemble was uninstalled while this runtime kept running (doc 25 §8). Package upgrades
 * remove the launcher for a moment (Homebrew relinks `bin/ensemble`, Scoop swaps `current`), so
 * it counts as removed only after it stayed missing on every check for UNINSTALL_GRACE_MS.
 */
import { existsSync } from "node:fs";

export const UNINSTALL_GRACE_MS = 10 * 60_000;

let missingSince: number | null = null;

export function launcherRemoved(path: string | undefined, now: number = Date.now(), exists: (path: string) => boolean = existsSync): boolean {
  if (!path || exists(path)) {
    missingSince = null;
    return false;
  }
  missingSince ??= now;
  return now - missingSince >= UNINSTALL_GRACE_MS;
}
