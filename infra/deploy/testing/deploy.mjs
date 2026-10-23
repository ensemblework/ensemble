import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export function validateTestingEnv(env, home) {
  const db = new URL(env.DATABASE_URL);
  const redis = new URL(env.REDIS_URL);
  if (!["postgres:", "postgresql:"].includes(db.protocol) || db.hostname !== "127.0.0.1" || db.port !== "25432" || db.pathname !== "/ensemble_test" || !db.password) throw new Error("Testing requires its own loopback Postgres on 25432, database ensemble_test.");
  if (redis.protocol !== "redis:" || redis.hostname !== "127.0.0.1" || redis.port !== "26379" || !redis.password) throw new Error("Testing requires its own password-protected Redis on 26379.");
  const expected = {
    NODE_ENV: "production", HUB_API_HOST: "127.0.0.1", HUB_API_PORT: "24000",
    HUB_WEB_ORIGIN: "https://test.ensemblework.com", HUB_API_PUBLIC_URL: "https://api-test.ensemblework.com",
    ENSEMBLE_COOKIE_NAMESPACE: "testing", ENSEMBLE_COOKIE_DOMAIN: "ensemblework.com",
    ENSEMBLE_SERVER_RUNNER: "off", ENSEMBLE_INPROCESS_RUNTIME: "1",
    ENSEMBLE_FILE_STORAGE: "azure-blob", AZURE_STORAGE_CONTAINER: "ensemble-test-files",
    ENSEMBLE_TEST_HOME: home,
  };
  for (const [key, value] of Object.entries(expected)) if (env[key] !== value) throw new Error(`Testing isolation requires ${key}=${value}.`);
  for (const key of ["ENSEMBLE_WORKSPACE_ROOT", "ENSEMBLE_MPLCONFIGDIR", "ENSEMBLE_REMOTE_STATE_DIR"]) {
    if (!env[key] || !resolve(env[key]).startsWith(`${home}/state/`)) throw new Error(`${key} must stay inside the testing state directory.`);
  }
  return env;
}

async function deploy() {
  const home = join(homedir(), "ensemble-test"), app = join(home, "app");
  const node = join(homedir(), "ensemble-host/node/bin");
  const require = createRequire(join(app, "apps/hub-api/package.json"));
  const env = validateTestingEnv({ ...process.env, ...require("dotenv").parse(readFileSync(join(home, "ensemble.env"))) }, home);
  env.PATH = `${node}:${process.env.PATH}`;
  const run = (command, args, options = {}) => execFileSync(command, args, { cwd: app, env, encoding: "utf8", stdio: "pipe", ...options });
  const git = (...args) => run("git", args).trim();
  if (git("status", "--porcelain")) throw new Error("The testing checkout has local changes; refusing to replace them.");
  git("fetch", "--quiet", "origin", "testing-live");
  const previous = git("rev-parse", "HEAD"), target = git("rev-parse", "origin/testing-live");
  const installed = existsSync(join(home, "state/deployed.commit")) ? readFileSync(join(home, "state/deployed.commit"), "utf8").trim() : "";
  if (previous === target && installed === `ENSEMBLE_COMMIT=${target}`) return;
  git("merge", "--ff-only", "origin/testing-live");
  const manifests = git("diff", "--name-only", previous, target, "--", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ":(glob)**/package.json");
  if (manifests) {
    const installEnv = { ...env }; delete installEnv.NODE_ENV;
    run(join(node, "pnpm"), ["install", "--frozen-lockfile", "--reporter=silent"], { env: installEnv, stdio: "inherit" });
  }
  run(join(node, "pnpm"), ["db:generate"], { stdio: "inherit" });
  mkdirSync(join(home, "backups"), { recursive: true });
  const dump = openSync(join(home, "backups", `before-${target}-${Date.now()}.dump`), "wx", 0o600);
  try { run("docker", ["exec", "ensemble-test-postgres", "pg_dump", "-U", "ensemble_test", "-Fc", "ensemble_test"], { stdio: ["ignore", dump, "inherit"] }); }
  finally { closeSync(dump); }
  run(join(node, "pnpm"), ["db:migrate"], { stdio: "inherit" });
  writeFileSync(join(home, "ensemble.commit"), `ENSEMBLE_COMMIT=${target}\n`, { mode: 0o600 });
  run("systemctl", ["--user", "restart", "ensemble-test-api.service"], { stdio: "inherit" });
  for (let attempt = 0; attempt < 45; attempt++) {
    try {
      const response = await fetch("http://127.0.0.1:24000/health/ready", { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        mkdirSync(join(home, "state"), { recursive: true });
        writeFileSync(join(home, "state/deployed.commit"), `ENSEMBLE_COMMIT=${target}\n`, { mode: 0o600 });
        console.log(`Testing API ready at ${target}.`);
        return;
      }
    } catch (error) {
      if (!(error instanceof TypeError) && error.name !== "TimeoutError") throw error;
    }
    await new Promise((done) => setTimeout(done, 2000));
  }
  throw new Error("Testing API did not become ready; inspect ensemble-test-api.service.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  deploy().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
