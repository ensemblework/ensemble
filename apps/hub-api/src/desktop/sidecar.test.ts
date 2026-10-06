import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const hub = fileURLToPath(new URL("../..", import.meta.url));

test("the sidecar starts, writes a private discovery file, and stops", { timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-sidecar-"));
  const discovery = join(root, "api.json");
  const token = "sidecar-token-0123456789";
  const child = spawn(process.execPath, ["--import", "tsx", "src/desktop/main.ts"], {
    cwd: hub,
    env: {
      ...process.env,
      NODE_ENV: "development",
      ENSEMBLE_DATA_DIR: join(root, "pglite"),
      ENSEMBLE_BACKUP_DIR: join(root, "backups"),
      ENSEMBLE_DISCOVERY_FILE: discovery,
      ENSEMBLE_DESKTOP_TOKEN: token,
      ENSEMBLE_INPROCESS_RUNTIME: "1",
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
      ENSEMBLE_DEV_AUTH_BYPASS: "false",
      REDIS_URL: "memory://desktop",
      HUB_API_PORT: "0",
      HUB_API_HOST: "127.0.0.1",
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
    const file = await waitForFile(discovery, 150_000);
    const mode = statSync(file).mode & 0o777;
    assert.equal(mode, 0o600);
    const body = JSON.parse(readFileSync(file, "utf8")) as { port: number; token: string };
    assert.equal(body.token, token);
    assert.ok(body.port > 0);
    assert.equal(logs.includes(token), false);

    const health = await fetch(`http://127.0.0.1:${body.port}/health`);
    assert.equal(health.status, 200);
    const ready = await fetch(`http://127.0.0.1:${body.port}/health/ready`);
    assert.equal(ready.status, 200);
    const deep = (await ready.json()) as {
      ok: boolean;
      checks: { redis: { ok: boolean }; agent: { ok: boolean; error?: string } };
    };
    assert.equal(deep.ok, true);
    assert.equal(deep.checks.redis.ok, true);
    assert.equal(deep.checks.agent.ok, true);
    const models = await fetch(`http://127.0.0.1:${body.port}/api/models`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(models.status, 200);
    const catalog = (await models.json()) as { runtime?: boolean; providers?: unknown[] };
    assert.equal(catalog.runtime, true);
    assert.ok(Array.isArray(catalog.providers) && catalog.providers.length > 0);
    const me = await fetch(`http://127.0.0.1:${body.port}/api/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(me.status, 200);
    const status = await fetch(`http://127.0.0.1:${body.port}/api/desktop/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(status.status, 200);
    const payload = (await status.json()) as { ok: boolean; migrations: string[]; runningJobs: number };
    assert.equal(payload.ok, true);
    assert.ok(payload.migrations.length >= 15);
    assert.equal(payload.runningJobs, 0);

    const foreign = await httpStatus(body.port, "evil.example");
    assert.equal(foreign, 403);
    const loopback = await httpStatus(body.port, `127.0.0.1:${body.port}`);
    assert.equal(loopback, 200);

    // The live-events stream is hijacked, so it skips @fastify/cors. It must
    // still allow the desktop webview, or the app shows "Offline".
    const ticketFor = async (origin: string) => {
      const response = await fetch(`http://127.0.0.1:${body.port}/api/events/ticket`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, origin },
      });
      assert.equal(response.status, 200);
      return ((await response.json()) as { ticket: string }).ticket;
    };
    for (const origin of ["tauri://localhost", "ensemble://localhost", "http://tauri.localhost"]) {
      const ticket = await ticketFor(origin);
      const stream = await streamHeaders(body.port, "GET", `/api/events?ticket=${encodeURIComponent(ticket)}`, { origin });
      assert.equal(stream.status, 200, origin);
      assert.match(String(stream.headers["content-type"]), /^text\/event-stream/);
      assert.equal(stream.headers["access-control-allow-origin"], origin);
      assert.equal(stream.headers["access-control-allow-credentials"], "true");
      assert.equal(stream.headers.vary, "Origin", origin);
    }
    const foreignTicket = await ticketFor("https://evil.example");
    const foreignStream = await streamHeaders(body.port, "GET", `/api/events?ticket=${encodeURIComponent(foreignTicket)}`, {
      origin: "https://evil.example",
    });
    assert.equal(foreignStream.status, 200);
    assert.equal(foreignStream.headers["access-control-allow-origin"], undefined);
    assert.equal(foreignStream.headers["access-control-allow-credentials"], undefined);
    // Refused or not, a hijacked stream varies on Origin, like the plugin's responses.
    assert.equal(foreignStream.headers.vary, "Origin");

    // Streamed assistant replies are hijacked the same way.
    const turn = await streamHeaders(
      body.port,
      "POST",
      "/api/assistant/turn",
      { origin: "tauri://localhost", authorization: `Bearer ${token}`, "content-type": "application/json" },
      JSON.stringify({ message: "hi" }),
    );
    assert.equal(turn.status, 200);
    assert.equal(turn.headers["access-control-allow-origin"], "tauri://localhost");
    assert.equal(turn.headers["access-control-allow-credentials"], "true");
    assertVaryOrigin(turn.headers, "turn");

    // The other two hijacked streams: @ensemble on a page, and Ensemble on a surface.
    const authed = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const taskReply = await fetch(`http://127.0.0.1:${body.port}/api/tasks`, {
      method: "POST",
      headers: authed,
      body: JSON.stringify({ title: "Sidecar comment stream" }),
    });
    assert.equal(taskReply.status, 201);
    const { task } = (await taskReply.json()) as { task: { id: string } };
    const hijacked = [
      { path: `/api/pages/task/${task.id}/ensemble`, payload: JSON.stringify({ prompt: "hi" }) },
      { path: "/api/ensemble/invoke", payload: JSON.stringify({ surface: "board", prompt: "hi" }) },
    ];
    for (const { path, payload } of hijacked) {
      for (const origin of ["ensemble://localhost", "http://ensemble.localhost"]) {
        const stream = await streamHeaders(body.port, "POST", path, { ...authed, origin }, payload);
        assert.equal(stream.status, 200, `${origin} ${path}`);
        assert.match(String(stream.headers["content-type"]), /^text\/event-stream/);
        assert.equal(stream.headers["access-control-allow-origin"], origin, `${origin} ${path}`);
        assert.equal(stream.headers["access-control-allow-credentials"], "true", `${origin} ${path}`);
        assertVaryOrigin(stream.headers, `${origin} ${path}`);
      }
      const lookalike = await streamHeaders(body.port, "POST", path, { ...authed, origin: "ensemble://localhost.evil.com" }, payload);
      assert.equal(lookalike.status, 200, path);
      assertNoCors(lookalike.headers, `lookalike ${path}`);
      // Refused or not, the hijacked stream still varies on Origin, so a cache cannot hand one origin's answer to another.
      assertVaryOrigin(lookalike.headers, `lookalike ${path}`);
    }

    // Preflight goes through @fastify/cors, before the auth hook, so it needs no token.
    for (const origin of ["ensemble://localhost", "http://ensemble.localhost", "tauri://localhost"]) {
      for (const path of ["/api/assistant/turn", "/api/ensemble/invoke", "/api/events/ticket"]) {
        const response = await preflight(body.port, path, origin);
        assert.equal(response.status, 204, `${origin} ${path}`);
        assert.equal(response.headers["access-control-allow-origin"], origin, `${origin} ${path}`);
        assert.equal(response.headers["access-control-allow-credentials"], "true", `${origin} ${path}`);
        assert.match(String(response.headers["access-control-allow-methods"]), /\bPOST\b/);
        const allowHeaders = String(response.headers["access-control-allow-headers"]).toLowerCase();
        for (const name of ["content-type", "authorization"]) assert.ok(allowHeaders.includes(name), `${origin} ${path} ${name}`);
        assert.match(String(response.headers.vary), /Origin/);
      }
    }
    for (const origin of [
      "ensemble://localhost.evil.com",
      "http://ensemble.localhost.evil.com",
      "http://tauri.localhost.evil.com",
      "null",
      "ENSEMBLE://localhost",
      "ensemble://localhost/",
      "http://ensemble.localhost:1420",
      "https://evil.example",
    ]) {
      const response = await preflight(body.port, "/api/assistant/turn", origin);
      assert.notEqual(response.status, 204, origin);
      assertNoCors(response.headers, origin);
    }
  } finally {
    child.kill("SIGTERM");
    await exited(child);
    rmSync(root, { recursive: true, force: true });
  }
});

/** Vary must name Origin exactly once (a hijacked route that drops it, or sets it twice, fails). */
function assertVaryOrigin(headers: http.IncomingHttpHeaders, label: string) {
  const raw = headers.vary;
  const values = (Array.isArray(raw) ? raw.join(",") : String(raw ?? "")).split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  assert.equal(values.filter((value) => value === "origin").length, 1, `${label}: Vary is ${JSON.stringify(raw)}`);
}

function assertNoCors(headers: http.IncomingHttpHeaders, label: string) {
  for (const name of ["access-control-allow-origin", "access-control-allow-credentials", "access-control-allow-methods", "access-control-allow-headers"]) {
    assert.equal(headers[name], undefined, `${label}: ${name}`);
  }
}

function preflight(port: number, path: string, origin: string): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type,authorization" },
      },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0, headers: res.headers });
      },
    );
    req.on("error", reject);
    req.setTimeout(15_000, () => req.destroy(new Error(`OPTIONS ${path} timed out`)));
    req.end();
  });
}

function httpStatus(port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: "/health", method: "GET", headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

/** Resolve with status and headers as soon as they arrive, then drop the open stream. */
function streamHeaders(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  payload?: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = http.request({ hostname: "127.0.0.1", port, path, method, headers }, (res) => {
      settled = true;
      resolve({ status: res.statusCode ?? 0, headers: res.headers });
      res.on("error", () => {});
      req.destroy();
    });
    req.on("error", (error) => {
      if (!settled) reject(error);
    });
    req.setTimeout(30_000, () => req.destroy(new Error(`${method} ${path} sent no headers`)));
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
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
