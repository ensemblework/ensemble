import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DESKTOP_WEBVIEW_ORIGINS } from "./desktop-guard.js";

const hub = fileURLToPath(new URL("../..", import.meta.url));
const WEB_ORIGIN = "https://app.example.com";

// Preflight goes through @fastify/cors in index.ts, before the auth hook.
// Start the hosted build (no ENSEMBLE_DESKTOP) and check what OPTIONS returns.
// Postgres is pointed at a closed port on purpose: preflight never needs it,
// and the API stays up without it.
test("hosted preflight allows only HUB_WEB_ORIGIN, never the desktop webview origins", { timeout: 120_000 }, async () => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "development",
    HUB_WEB_ORIGIN: WEB_ORIGIN,
    HUB_API_HOST: "127.0.0.1",
    HUB_API_PORT: "0",
    ENSEMBLE_LOG_LEVEL: "info",
    DATABASE_URL: "postgresql://ensemble:unused@127.0.0.1:1/ensemble_preflight",
    REDIS_URL: "memory://preflight",
    ENSEMBLE_DEV_AUTH_BYPASS: "false",
  };
  delete env.ENSEMBLE_DESKTOP;
  delete env.ENSEMBLE_DESKTOP_EMBED;
  delete env.ENSEMBLE_DESKTOP_TOKEN;
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: hub, env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    const port = await listeningPort(child, 90_000);

    const allowed = await preflight(port, "/api/assistant/turn", WEB_ORIGIN);
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers["access-control-allow-origin"], WEB_ORIGIN);
    assert.equal(allowed.headers["access-control-allow-credentials"], "true");
    assert.match(String(allowed.headers["access-control-allow-methods"]), /\bPOST\b/);
    const allowHeaders = String(allowed.headers["access-control-allow-headers"]).toLowerCase();
    for (const name of ["content-type", "authorization"]) assert.ok(allowHeaders.includes(name), name);
    assert.match(String(allowed.headers.vary), /Origin/);

    const refused = [
      ...DESKTOP_WEBVIEW_ORIGINS,
      "ensemble://localhost.evil.com",
      "http://ensemble.localhost.evil.com",
      "https://evil.example",
      "null",
      `${WEB_ORIGIN}/`,
      `${WEB_ORIGIN}:443`,
      "https://APP.example.com",
      "http://app.example.com",
      "https://app.example.com.evil.com",
    ];
    for (const origin of refused) {
      for (const path of ["/api/assistant/turn", "/api/events", "/api/ensemble/invoke"]) {
        const response = await preflight(port, path, origin);
        assertNoCors(response.headers, `${origin} ${path}`);
        assert.notEqual(response.status, 204, `${origin} ${path}`);
      }
    }

    // No Origin at all is not a cross-origin request: no allow-origin either.
    const bare = await preflight(port, "/api/assistant/turn", undefined);
    assert.equal(bare.headers["access-control-allow-origin"], undefined);
    assert.equal(bare.headers["access-control-allow-methods"], undefined);
  } finally {
    child.kill("SIGTERM");
    await exited(child);
  }
});

function assertNoCors(headers: http.IncomingHttpHeaders, label: string) {
  for (const name of ["access-control-allow-origin", "access-control-allow-credentials", "access-control-allow-methods", "access-control-allow-headers"]) {
    assert.equal(headers[name], undefined, `${label}: ${name}`);
  }
}

function preflight(port: number, path: string, origin: string | undefined): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  const headers: Record<string, string> = {
    "access-control-request-method": "POST",
    "access-control-request-headers": "content-type,authorization",
  };
  if (origin !== undefined) headers.origin = origin;
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method: "OPTIONS", headers }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, headers: res.headers });
    });
    req.on("error", reject);
    req.setTimeout(15_000, () => req.destroy(new Error(`OPTIONS ${path} timed out`)));
    req.end();
  });
}

function listeningPort(child: ChildProcess, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let logs = "";
    const timer = setTimeout(() => reject(new Error(`hosted hub did not start:\n${logs.slice(-4000)}`)), timeoutMs);
    const onData = (chunk: Buffer) => {
      logs += chunk.toString();
      const match = /hub-api listening on 127\.0\.0\.1:(\d+)/.exec(logs);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`hosted hub exited with ${code}:\n${logs.slice(-4000)}`));
    });
  });
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
