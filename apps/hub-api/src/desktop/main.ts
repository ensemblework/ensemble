/**
 * Desktop sidecar: one Node process for hub-api, the worker, and the scheduler.
 * The Rust shell starts this, passes a data directory and a launch token, and
 * stops it on quit. It binds 127.0.0.1 on a random port.
 *
 * Set ENSEMBLE_DESKTOP and the token before any hub-api module loads. Those
 * modules read the environment once, at import.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

const dataDir = process.env.ENSEMBLE_DATA_DIR?.trim() || join(homedir(), ".local", "share", "com.ensemblework.desktop", "pglite");
mkdirSync(dataDir, { recursive: true });

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
