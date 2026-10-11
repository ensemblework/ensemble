/**
 * Desktop sidecar: one Node process for hub-api, the worker, and the scheduler.
 * The Rust shell starts this, passes a data directory and a launch token, and
 * stops it on quit. It binds 127.0.0.1 on a random port.
 *
 * Set ENSEMBLE_DESKTOP and the token before any hub-api module loads. Those
 * modules read the environment once, at import.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { desktopDataDir } from "@ensemble/shared-types/desktop-discovery";
import { acquireRuntimeLock, ALREADY_RUNNING_EXIT } from "./runtime-lock.js";

// Loopback http cookies must stay non-Secure, and the production boot checks
// refuse a non-https web origin. The desktop process is not that deployment.
if (process.env.NODE_ENV === "production") delete process.env.NODE_ENV;
if (!process.env.ENSEMBLE_DESKTOP_TOKEN) process.env.ENSEMBLE_DESKTOP_TOKEN = randomBytes(32).toString("base64url");
if (!process.env.ENSEMBLE_INTERNAL_TOKEN || process.env.ENSEMBLE_INTERNAL_TOKEN === "dev-internal-token") {
  process.env.ENSEMBLE_INTERNAL_TOKEN = randomBytes(32).toString("hex");
}
process.env.ENSEMBLE_DESKTOP = "1";
process.env.ENSEMBLE_DESKTOP_EMBED = "1";
// Model calls stay in this process. Set ENSEMBLE_INPROCESS_RUNTIME=0 to use the Python runtime instead.
if (!process.env.ENSEMBLE_INPROCESS_RUNTIME) process.env.ENSEMBLE_INPROCESS_RUNTIME = "1";
process.env.ENSEMBLE_DEV_AUTH_BYPASS = "false";
process.env.HUB_API_HOST = "127.0.0.1";
if (!process.env.HUB_API_PORT) process.env.HUB_API_PORT = "0";
process.env.DATABASE_URL ??= "postgresql://ensemble:unused@127.0.0.1:1/ensemble_desktop";
process.env.REDIS_URL ??= "memory://desktop";

// The desktop app and the CLI runner share one data folder per computer: one
// database, one pairing, one trusted-folder list, one sandbox setup.
const dataDir =
  process.env.ENSEMBLE_DATA_DIR?.trim() || join(desktopDataDir({ platform: process.platform, home: homedir(), env: process.env }), "pglite");
mkdirSync(dataDir, { recursive: true });
// The workspace is the same for both too. /tmp is cleared on reboot, so it is never the default here.
process.env.ENSEMBLE_WORKSPACE_ROOT ||= join(homedir(), "ensemble-workspace");

// One runtime per data folder. A second launcher attaches to the first (the
// discovery file has its port and token) instead of opening the database again.
const owner = process.env.ENSEMBLE_RUNTIME_OWNER?.trim() || "desktop";
const lock = acquireRuntimeLock(dirname(dataDir), owner);
if (!lock.ok) {
  let port = "";
  try {
    port = String((JSON.parse(readFileSync(process.env.ENSEMBLE_DISCOVERY_FILE || join(dirname(dataDir), "api.json"), "utf8")) as { port?: number }).port ?? "");
  } catch {
    // no discovery file yet: the other runtime is still starting
  }
  console.error(
    `ensemble-sidecar: the ${lock.holder.owner === "cli" ? "Ensemble CLI runner" : "Ensemble app"} is already running this computer's Ensemble (pid ${lock.holder.pid}${port ? `, port ${port}` : ""}). Attach to it instead of starting a second one.`,
  );
  process.exit(ALREADY_RUNNING_EXIT);
}
process.on("exit", () => lock.release());

// The encryption key must live with the data, not in the install folder: that
// folder is read-only for system packages and replaced on every upgrade.
if (!process.env.ENSEMBLE_SECRET_KEY?.trim() && !process.env.ENSEMBLE_SECRET_KEY_FILE?.trim()) {
  const keyFile = join(dirname(dataDir), "secret.key");
  const { DEFAULT_KEY_FILE } = await import("../lib/secrets.js");
  if (!existsSync(keyFile) && existsSync(DEFAULT_KEY_FILE)) {
    copyFileSync(DEFAULT_KEY_FILE, keyFile);
    chmodSync(keyFile, 0o600);
  }
  process.env.ENSEMBLE_SECRET_KEY_FILE = keyFile;
}

const { openDesktopDatabase } = await import("../lib/pglite-engine.js");
const opened = await openDesktopDatabase(dataDir);
const { startHub } = await import("../index.js");
const started = await startHub();
console.log(`ensemble-sidecar listening on 127.0.0.1:${started.port} migrations=${opened.applied.length} backup=${opened.backup ?? "none"}`);
