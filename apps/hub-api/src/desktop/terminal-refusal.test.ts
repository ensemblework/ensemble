import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DESKTOP_WEBVIEW_ORIGINS } from "../lib/desktop-guard.js";
import { TERMINAL_DESKTOP_REFUSAL } from "../lib/terminal-human.js";

const hub = fileURLToPath(new URL("../..", import.meta.url));

// Every terminal route that runs humanOnly(). None of them may open for the desktop token.
const GUARDED: Array<[string, string, unknown]> = [
  ["POST", "/api/terminal/passkeys/options", { password: "a-guess" }],
  ["POST", "/api/terminal/passkeys/verify", { response: {}, label: "x" }],
  ["DELETE", "/api/terminal/passkeys/some-key", undefined],
  ["POST", "/api/terminal/unlock/options", {}],
  ["POST", "/api/terminal/unlock/verify", { response: { id: "x" } }],
  ["POST", "/api/terminal/kill", {}],
  ["POST", "/api/terminal/cd", { cwd: "/", path: "" }],
  ["POST", "/api/terminal/run", { cwd: "/", line: "ls" }],
];

// The real desktop sidecar, with the desktop token the webview (and the context-bridge MCP) use.
test("the desktop sidecar refuses the desktop token on every terminal route", { timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-terminal-refusal-"));
  const discovery = join(root, "api.json");
  const token = "terminal-refusal-token-0123456789";
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "development",
    ENSEMBLE_DATA_DIR: join(root, "pglite"),
    ENSEMBLE_BACKUP_DIR: join(root, "backups"),
    ENSEMBLE_DISCOVERY_FILE: discovery,
    ENSEMBLE_DESKTOP_TOKEN: token,
    ENSEMBLE_INPROCESS_RUNTIME: "1",
    ENSEMBLE_DEV_AUTH_BYPASS: "false",
    REDIS_URL: "memory://desktop",
    HUB_API_PORT: "0",
    HUB_API_HOST: "127.0.0.1",
  };
  delete env.HUB_WEB_ORIGIN; // the sidecar runs with the default, http://localhost:3000
  const child = spawn(process.execPath, ["--import", "tsx", "src/desktop/main.ts"], { cwd: hub, env, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout?.on("data", (chunk) => (logs += chunk.toString()));
  child.stderr?.on("data", (chunk) => (logs += chunk.toString()));
  try {
    await waitForFile(discovery, 150_000);
    const { port } = JSON.parse(readFileSync(discovery, "utf8")) as { port: number };
    const auth = { authorization: `Bearer ${token}` };

    // Status is not guarded (Settings reads it), and stays as it was.
    const status = await call(port, "GET", "/api/terminal/status", auth);
    assert.equal(status.status, 200, status.body);

    // From the desktop app's own window: refused on every route, and the message says why.
    for (const origin of DESKTOP_WEBVIEW_ORIGINS) {
      for (const [method, path, body] of GUARDED) {
        const response = await call(port, method, path, { ...auth, origin }, body);
        assert.equal(response.status, 403, `${origin} ${method} ${path}: ${response.body}`);
        assert.equal(error(response.body), TERMINAL_DESKTOP_REFUSAL, `${origin} ${method} ${path}`);
      }
    }

    // No Origin at all (a script or agent holding the token): the old refusal.
    for (const [method, path, body] of GUARDED) {
      const response = await call(port, method, path, auth, body);
      assert.equal(response.status, 403, `${method} ${path}: ${response.body}`);
      assert.equal(error(response.body), "The terminal only accepts requests from the Ensemble page itself.", `${method} ${path}`);
    }

    // A faked localhost Origin with the desktop token gets past humanOnly, exactly as before this change.
    // The passkey is what stops it: no password is known, no passkey is registered, nothing is unlocked.
    const faked = { ...auth, origin: "http://localhost:3000" };
    const enrol = await call(port, "POST", "/api/terminal/passkeys/options", faked, { password: "a-guess" });
    assert.equal(enrol.status, 403, enrol.body);
    assert.equal(error(enrol.body), "That password is not right.");
    const unlock = await call(port, "POST", "/api/terminal/unlock/options", faked, {});
    assert.equal(unlock.status, 403, unlock.body);
    assert.equal(error(unlock.body), "Set up Touch ID for the terminal first.");
    const verify = await call(port, "POST", "/api/terminal/unlock/verify", faked, { response: { id: "x" } });
    assert.equal(verify.status, 403, verify.body);
    const run = await call(port, "POST", "/api/terminal/run", faked, { cwd: "/", line: "ls" });
    assert.equal(run.status, 401, run.body);
    const cd = await call(port, "POST", "/api/terminal/cd", faked, { cwd: "/", path: "" });
    assert.equal(cd.status, 403, cd.body);
    assert.equal(error(cd.body), "The terminal is locked.");
  } catch (failure) {
    throw new Error(`${(failure as Error).message}\n--- sidecar log ---\n${logs.slice(-4000)}`, { cause: failure });
  } finally {
    child.kill("SIGTERM");
    await exited(child);
    rmSync(root, { recursive: true, force: true });
  }
});

function error(body: string): string | undefined {
  try {
    return (JSON.parse(body) as { error?: string }).error;
  } catch {
    return undefined;
  }
}

function call(port: number, method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; body: string }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: { ...headers, ...(payload ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } : {}) },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on("error", reject);
    req.setTimeout(15_000, () => req.destroy(new Error(`${method} ${path} timed out`)));
    req.end(payload);
  });
}

function waitForFile(path: string, timeoutMs: number): Promise<string> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      try {
        statSync(path);
        clearInterval(timer);
        resolve(path);
      } catch {
        if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          reject(new Error(`discovery file did not appear at ${path}`));
        }
      }
    }, 200);
  });
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
