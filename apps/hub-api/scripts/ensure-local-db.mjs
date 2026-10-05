/**
 * `pnpm db:migrate` and `pnpm db:seed` use Postgres at 127.0.0.1:5432.
 * That address is the database from `infra/docker-compose.yml`. When nothing
 * is listening, start those containers (the same work as `pnpm infra:up`)
 * and wait until Postgres accepts connections.
 *
 * A remote DATABASE_URL is left alone. CI is left alone so a hosted test
 * database is not replaced with the compose one.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

export function localDatabaseTarget(databaseUrl) {
  if (!databaseUrl || typeof databaseUrl !== "string") return null;
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") return null;
  // Compose publishes 127.0.0.1 only. `localhost` is often ::1 on macOS, and
  // a Homebrew Postgres install uses that name too.
  if (parsed.hostname !== "127.0.0.1") return null;
  const port = parsed.port === "" ? 5432 : Number(parsed.port);
  if (port !== 5432) return null;
  return { host: "127.0.0.1", port: 5432 };
}

export function localDbHelp(target) {
  return [
    `Can't reach database server at \`${target.host}:${target.port}\`.`,
    "Open Docker Desktop, then from the repo root run:",
    "  docker volume create ensemble_pg",
    "  pnpm infra:up",
    "Then run pnpm db:migrate or pnpm db:seed again.",
  ].join("\n");
}

export function probePort(host, port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadEnv() {
  const envFile = new URL("../../../.env", import.meta.url);
  if (!existsSync(envFile)) return;
  const { config } = await import("dotenv");
  config({ path: envFile });
}

function defaultSpawn(command, args, options) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: process.env,
    stdio: "inherit",
  });
}

async function defaultReady(target) {
  const result = spawnSync(
    "docker",
    ["exec", "ensemble-postgres", "pg_isready", "-U", "ensemble", "-d", "ensemble"],
    { stdio: "ignore" },
  );
  if (result.status === 0) return true;
  return probePort(target.host, target.port, 500);
}

export async function ensureLocalDatabase(options = {}) {
  if (!options.env) await loadEnv();
  const env = options.env ?? process.env;
  if (env.CI || env.ENSEMBLE_SKIP_LOCAL_DB === "1") return { action: "skip" };

  const target = localDatabaseTarget(env.DATABASE_URL);
  if (!target) return { action: "skip" };

  const probe = options.probe ?? probePort;
  const ready = options.ready ?? defaultReady;
  const log = options.log ?? ((message) => console.error(message));
  const spawn = options.spawn ?? defaultSpawn;
  const cwd = options.cwd ?? repoRoot;
  const timeoutMs = options.timeoutMs ?? 90_000;
  const intervalMs = options.intervalMs ?? 500;

  if (await probe(target.host, target.port)) return { action: "ready" };

  log(`Postgres is not accepting connections at ${target.host}:${target.port}.`);
  log("Starting it with Docker (the same containers as pnpm infra:up).");

  const volume = spawn("docker", ["volume", "create", "ensemble_pg"], { cwd });
  if ((volume.status ?? 1) !== 0) {
    log(localDbHelp(target));
    return { action: "failed", status: volume.status || 1 };
  }

  const up = spawn("docker", ["compose", "-f", "infra/docker-compose.yml", "up", "-d"], { cwd });
  if ((up.status ?? 1) !== 0) {
    log(localDbHelp(target));
    return { action: "failed", status: up.status || 1 };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ready(target)) {
      log(`Postgres is accepting connections at ${target.host}:${target.port}.`);
      return { action: "started" };
    }
    if (intervalMs <= 0) break;
    await delay(intervalMs);
  }

  log(localDbHelp(target));
  return { action: "failed", status: 1 };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const result = await ensureLocalDatabase();
  if (result.action === "failed") process.exit(result.status ?? 1);
}
