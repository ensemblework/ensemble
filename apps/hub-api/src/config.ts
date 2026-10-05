import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { z } from "zod";
import { parsePlotConcurrency } from "./runtime/plot-concurrency.js";

for (const candidate of [resolve(process.cwd(), "../../.env"), resolve(process.cwd(), ".env")]) {
  if (existsSync(candidate)) loadEnv({ path: candidate, override: false });
}

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
  // Loopback only. Set 0.0.0.0 (or another interface) only when you mean to publish the API.
  HUB_API_HOST: z.string().default("127.0.0.1"),
  HUB_API_PORT: z.coerce.number().default(4000),
  HUB_WEB_ORIGIN: z.string().default("http://localhost:3000"),
  ENSEMBLE_DEV_AUTH_BYPASS: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  ENSEMBLE_DEV_USER_ID: z.string().default("local"),
  ENSEMBLE_TIMEZONE: z.string().default("Asia/Kolkata"),
  ENSEMBLE_AUTONOMY_LEVEL: z.enum(["assist", "supervised", "autonomous"]).default("assist"),
  ENSEMBLE_WORKSPACE_ROOT: z.string().default("/tmp/ensemble-workspace"),
  ENSEMBLE_INTERNAL_TOKEN: z.string().default("dev-internal-token"),
  ENSEMBLE_LOG_LEVEL: z.string().default("info"),
  // 5000 is taken by AirPlay Receiver on macOS.
  AGENT_RUNTIME_URL: z.string().default("http://127.0.0.1:5055"),
  // Read at call time by runtime/mode.ts. "1" forces the in-process adapters.
  // "0" keeps this process talking to the Python runtime. Unset follows ENSEMBLE_DESKTOP.
  ENSEMBLE_INPROCESS_RUNTIME: z.string().optional(),
  // Plot runner. Unset uses python3 on PATH (desktop) or the agent runtime's
  // own interpreter (hosted). Point this at a Python without matplotlib to
  // check the install error without uninstalling anything.
  ENSEMBLE_PYTHON: z.string().optional(),
  // How many plot exports may run at once. Extra exports wait. 1 on a small VM.
  ENSEMBLE_PLOT_CONCURRENCY: z
    .string()
    .optional()
    .transform((value) => parsePlotConcurrency(value)),
});

export type Env = z.infer<typeof Env>;

export const env: Env = Env.parse(process.env);

export function currentUserId(header?: string | string[]): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (value) return value;
  if (env.ENSEMBLE_DEV_AUTH_BYPASS) return env.ENSEMBLE_DEV_USER_ID;
  return env.ENSEMBLE_DEV_USER_ID;
}
