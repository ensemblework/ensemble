#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromCli = createRequire(join(root, "apps/cli/package.json"));

const options = parseArgs(process.argv.slice(2));
if (!options.packageDir) {
  console.error("Usage: node scripts/smoke-cli-package.mjs <extracted ensemble dir> [--skip-mcp] [--skip-sidecar-health]");
  process.exit(1);
}

const packageDir = resolve(options.packageDir);
const launcher = launcherPath(packageDir);
const version = readFileSync(join(packageDir, "VERSION"), "utf8").trim();
const temp = mkdtempSync(join(tmpdir(), "ensemble-cli-smoke-"));

try {
  smokeVersion(launcher, version, temp);
  if (!options.skipMcp) await smokeMcp(launcher, temp);
  if (!options.skipSidecarHealth) await smokeSidecar(packageDir, temp);
  console.error(`CLI package smoke OK (${version}).`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

function parseArgs(args) {
  const parsed = { packageDir: "", skipMcp: false, skipSidecarHealth: false };
  for (const arg of args) {
    if (arg === "--skip-mcp") {
      parsed.skipMcp = true;
    } else if (arg === "--skip-sidecar-health") {
      parsed.skipSidecarHealth = true;
    } else if (!parsed.packageDir) {
      parsed.packageDir = arg;
    } else {
      throw new Error(`Unknown argument ${arg}.`);
    }
  }
  return parsed;
}

function launcherPath(packageDir) {
  if (process.platform === "win32") return join(packageDir, "bin", "ensemble.exe");
  return join(packageDir, "bin", "ensemble");
}

function smokeVersion(command, version, tempDir) {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    env: smokeEnv(tempDir),
  });
  if (result.error) throw new Error(`could not start ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`ensemble --version exited with ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (!output.includes(version)) {
    throw new Error(`ensemble --version did not print ${version}. Output:\n${output}`);
  }
}

async function smokeMcp(command, tempDir) {
  const [{ Client }, { getDefaultEnvironment, StdioClientTransport }] = await Promise.all([
    importSdk("client/index.js"),
    importSdk("client/stdio.js"),
  ]);
  const mock = await startMockHub();
  const transport = new StdioClientTransport({
    command,
    args: ["mcp"],
    env: {
      ...getDefaultEnvironment(),
      ...smokeEnv(tempDir),
      ENSEMBLE_BRIDGE_TOKEN: "ens_smoke",
      ENSEMBLE_API_URL: mock.url,
      HUB_API_URL: mock.url,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "ensemble-cli-package-smoke", version: "0.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    if (!tools.tools?.length) throw new Error("MCP tools/list returned no tools.");
  } finally {
    await client.close().catch(() => undefined);
    await mock.close();
  }
}

async function smokeSidecar(packageDir, tempDir) {
  const sidecarDir = join(packageDir, "sidecar");
  const node = join(sidecarDir, process.platform === "win32" ? "node.exe" : "node");
  const appDir = join(sidecarDir, "app");
  const entry = join(appDir, "src/desktop/main.ts");
  statSync(node);
  statSync(entry);

  const dataHome = join(tempDir, "data");
  const discovery = join(dataHome, "api.json");
  const child = spawn(node, ["--import", "tsx", "src/desktop/main.ts"], {
    cwd: appDir,
    env: {
      ...smokeEnv(tempDir),
      ENSEMBLE_DATA_HOME: dataHome,
      ENSEMBLE_DATA_DIR: join(dataHome, "pglite"),
      ENSEMBLE_BACKUP_DIR: join(dataHome, "backups"),
      ENSEMBLE_DISCOVERY_FILE: discovery,
      ENSEMBLE_REMOTE_STATE_DIR: dataHome,
      ENSEMBLE_APP_VERSION: "cli-smoke",
      ENSEMBLE_REMOTE_LOOP: "off",
      ENSEMBLE_AGENT_QUEUE: "off",
      ENSEMBLE_SCHEDULER: "off",
      ENSEMBLE_DESKTOP_TOKEN: "cli-smoke-token",
      ENSEMBLE_DEV_AUTH_BYPASS: "false",
      ENSEMBLE_INPROCESS_RUNTIME: "1",
      HUB_API_PORT: "0",
      HUB_API_HOST: "127.0.0.1",
      REDIS_URL: "memory://cli",
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      GOOGLE_API_KEY: "",
      GEMINI_API_KEY: "",
      MISTRAL_API_KEY: "",
      MOONSHOT_API_KEY: "",
      KIMI_API_KEY: "",
      DASHSCOPE_API_KEY: "",
      QWEN_API_KEY: "",
      COPILOT_API_KEY: "",
      GITHUB_TOKEN: "",
      CURSOR_API_KEY: "",
      OPENROUTER_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout?.on("data", (chunk) => {
    logs += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    logs += chunk.toString();
  });
  try {
    const body = JSON.parse(await waitForFile(discovery, 180_000, () => child.exitCode ?? child.signalCode));
    const response = await fetch(`http://127.0.0.1:${body.port}/health`, { signal: AbortSignal.timeout(10_000) });
    if (response.status !== 200) throw new Error(`/health returned ${response.status}`);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n--- sidecar logs ---\n${logs.slice(-4000)}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise((resolveDone) => child.once("exit", resolveDone));
    }
  }
}

function smokeEnv(tempDir) {
  return {
    ...process.env,
    HOME: join(tempDir, "home"),
    USERPROFILE: join(tempDir, "home"),
    ENSEMBLE_CONFIG_DIR: join(tempDir, "config"),
    ENSEMBLE_DATA_HOME: join(tempDir, "data"),
  };
}

function importSdk(path) {
  return Promise.resolve(requireFromCli(`@modelcontextprotocol/sdk/${path}`));
}

function startMockHub() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.headers.authorization && !String(req.headers.authorization).includes("ens_smoke")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad token" }));
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "read only" }));
      return;
    }
    const payload = bridgePayload(url.pathname);
    if (!payload) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  return new Promise((resolveStart, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolveStart({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((resolveClose, rejectClose) => server.close((error) => (error ? rejectClose(error) : resolveClose()))),
      });
    });
  });
}

function bridgePayload(path) {
  if (path === "/api/bridge/today") {
    return { date: "2026-10-06", focus: [{ id: "task", title: "Package Ensemble CLI" }], proposed: [], meetings: [], omitted: [] };
  }
  if (path === "/api/bridge/gaps") {
    return { gaps: [], reads: ["today"] };
  }
  if (path === "/api/bridge/brief") {
    return { resolution: "none", message: "Package smoke mock hub.", resolved: {}, howIWork: [], context: [], gaps: [] };
  }
  if (path.startsWith("/api/bridge/")) {
    return {};
  }
  return null;
}

function waitForFile(file, timeoutMs, exitCode) {
  const start = Date.now();
  return new Promise((resolveFile, reject) => {
    const tick = () => {
      if (exitCode() !== null) {
        reject(new Error(`sidecar exited before writing ${file}`));
        return;
      }
      try {
        resolveFile(readFileSync(file, "utf8"));
        return;
      } catch (error) {
        if (error.code !== "ENOENT") {
          reject(error);
          return;
        }
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`timed out waiting for ${file}`));
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}
