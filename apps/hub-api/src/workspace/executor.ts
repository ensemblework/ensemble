/**
 * Native / sandbox command runner (docs/06).
 *
 * OUTPUT_LIMIT keeps a single command from flooding the run log.
 * ProcessHandle is the persisted shape of a live pid/container so Stop can
 * cancel work that is already in flight.
 */
import { z } from "zod";
import { hostExecutable } from "./policy.js";

export { hostExecutable } from "./policy.js";

export const OUTPUT_LIMIT = 80_000;

export const ProcessHandle = z.object({
  pid: z.number().int().positive().optional(),
  marker: z.string(),
  container: z.string().optional(),
});
export type ProcessHandle = z.infer<typeof ProcessHandle>;

export class ProcessCleanupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcessCleanupError";
  }
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  redacted: boolean;
}

/** What a native run may inherit when the engineer opted into "use my sign-ins". */
export const SIGN_IN_PASSTHROUGH = [
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "USERNAME",
  "USERDOMAIN",
  "COMPUTERNAME",
  "HOME",
  "USER",
  "LOGNAME",
] as const;

export async function whichHost(name: string): Promise<string> {
  return hostExecutable(name);
}
