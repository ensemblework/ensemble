import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { after } from "node:test";
import type { InjectOptions } from "fastify";
import { BROWSER_SESSION_REQUIRED } from "../bridge/auth.js";
import { createHttpHarness, type HttpHarness, type HttpUser } from "../test/http.js";
import { cliAuthRouteCoverage, type RouteCheck } from "../test/route-coverage.js";

const originalEnv = { ...process.env };
process.env.NODE_ENV = "test";
process.env.HUB_WEB_ORIGIN = "http://hub.example.test";
process.env.HUB_API_PUBLIC_URL = "http://api.example.test";

const harness: HttpHarness = await createHttpHarness();
const covered = new Map<string, Set<RouteCheck>>();

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

after(async () => {
  try {
    for (const [route, checks] of Object.entries(cliAuthRouteCoverage)) {
      for (const check of checks) assert.ok(covered.get(route)?.has(check), `Unexecuted CLI auth coverage claim: ${check} ${route}`);
    }
  } finally {
    await harness.close();
    process.env = originalEnv;
  }
});

function routeKey(method: string, url: string): string {
  return `${method} ${url.split("?")[0]}`;
}

function track(method: string, url: string, check: RouteCheck): void {
  const key = routeKey(method, url);
  const checks = covered.get(key) ?? new Set<RouteCheck>();
  checks.add(check);
  covered.set(key, checks);
}

async function inject(method: InjectOptions["method"], url: string, check: RouteCheck, options: Omit<InjectOptions, "method" | "url"> = {}) {
  const response = await harness.app.inject({ ...options, method, url });
  track(String(method), url, check);
  return response;
}

async function start(scopes: Array<"mcp" | "runner">, clientName = "VS Code") {
  const response = await inject("POST", "/api/cli/auth/start", "happy-path", {
    payload: { clientName, platform: "darwin", version: "0.1.0", scopes },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json<{
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string;
    expiresIn: number;
    interval: number;
  }>();
}

async function approve(user: HttpUser, userCode: string, scopes: Array<"mcp" | "runner">, decision: "approve" | "deny" = "approve", check: RouteCheck = "happy-path") {
  const response = await inject("POST", "/api/cli/auth/approve", check, {
    headers: { cookie: user.cookie },
    payload: { userCode, scopes, decision },
  });
  return response;
}

async function token(deviceCode: string, check: RouteCheck = "happy-path") {
  return inject("POST", "/api/cli/auth/token", check, { payload: { deviceCode } });
}

test("start, browser request, approve, token, bridge access, MCP gate, pairing, single-use, and logout", async () => {
  const user = await harness.asUser("cli-success@example.test");
  await harness.prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
  await harness.prisma.task.create({ data: { userId: user.id, title: "CLI visible task", status: "todo", todayFocus: "keep" } });

  const started = await start(["mcp", "runner"], "Akash MacBook");
  assert.match(started.deviceCode, /^[\w-]+$/);
  assert.match(started.userCode, /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
  assert.equal(started.verificationUri, "http://hub.example.test/link");
  assert.equal(started.verificationUriComplete, `http://hub.example.test/link?code=${encodeURIComponent(started.userCode)}`);
  assert.equal(started.expiresIn, 600);
  assert.equal(started.interval, 5);

  const request = await inject("GET", `/api/cli/auth/request?code=${started.userCode.replace("-", "").toLowerCase()}`, "happy-path", {
    headers: { cookie: user.cookie },
  });
  assert.equal(request.statusCode, 200, request.body);
  assert.deepEqual(request.json().scopes, ["mcp", "runner"]);
  assert.equal(typeof request.json().requestedFrom, "string");
  assert.equal(request.json().sameNetwork, true);

  const approved = await approve(user, started.userCode.toLowerCase(), ["mcp", "runner"]);
  assert.equal(approved.statusCode, 200, approved.body);
  assert.deepEqual(approved.json(), { ok: true, scopes: ["mcp", "runner"] });

  const issued = await token(started.deviceCode);
  assert.equal(issued.statusCode, 200, issued.body);
  const body = issued.json<{
    token: string;
    tokenId: string;
    scopes: string[];
    account: { email: string; name: string };
    apiBase: string;
    appUrl: string;
    pairingCode: string;
    pairingExpiresAt: string;
  }>();
  assert.match(body.token, /^ens_/);
  assert.deepEqual(body.scopes, ["mcp", "runner"]);
  assert.equal(body.account.email, user.email);
  assert.equal(body.apiBase, "http://api.example.test");
  assert.equal(body.appUrl, "http://hub.example.test");
  assert.match(body.pairingCode, /^[A-Z0-9]{8}$/);
  const exchanged = await harness.prisma.cliAuthRequest.findFirstOrThrow({ where: { tokenId: body.tokenId } });
  assert.equal(exchanged.requestIp, null);
  assert.ok(Date.parse(body.pairingExpiresAt) > Date.now());

  const today = await harness.app.inject({ method: "GET", url: "/api/bridge/today", headers: { authorization: `Bearer ${body.token}` } });
  assert.equal(today.statusCode, 200, today.body);
  assert.match(today.body, /CLI visible task/);

  const mcpGate = await harness.app.inject({ method: "GET", url: "/mcp", headers: { authorization: `Bearer ${body.token}` } });
  assert.equal(mcpGate.statusCode, 405, mcpGate.body);

  const registered = await harness.app.inject({
    method: "POST",
    url: "/api/devices/register",
    payload: { code: body.pairingCode, name: "Akash MacBook", platform: "macos", appVersion: "cli-test", capabilities: {} },
  });
  assert.equal(registered.statusCode, 201, registered.body);
  const deviceToken = registered.json<{ token: string; device: { id: string } }>();
  const selfDelete = await harness.app.inject({ method: "DELETE", url: "/api/devices/self", headers: { authorization: `Bearer ${deviceToken.token}` } });
  assert.equal(selfDelete.statusCode, 204, selfDelete.body);
  assert.ok((await harness.prisma.device.findUnique({ where: { id: deviceToken.device.id } }))?.revokedAt);

  const secondToken = await token(started.deviceCode, "invalid-input");
  assert.equal(secondToken.statusCode, 400);
  assert.equal(secondToken.json().error, "expired_token");

  const logout = await inject("POST", "/api/cli/logout", "happy-path", { headers: { authorization: `Bearer ${body.token}` } });
  assert.equal(logout.statusCode, 204, logout.body);
  const revoked = await harness.app.inject({ method: "GET", url: "/api/bridge/today", headers: { authorization: `Bearer ${body.token}` } });
  assert.equal(revoked.statusCode, 401, revoked.body);
});

test("deny is visible to the polling device as access_denied", async () => {
  const user = await harness.asUser("cli-deny@example.test");
  const started = await start(["mcp"], "Denied CLI");
  const denied = await approve(user, started.userCode, ["mcp"], "deny");
  assert.equal(denied.statusCode, 200, denied.body);
  assert.deepEqual(denied.json(), { ok: true, scopes: [] });
  const polled = await token(started.deviceCode, "invalid-input");
  assert.equal(polled.statusCode, 400);
  assert.equal(polled.json().error, "access_denied");
});

test("pending, fast poll and expired requests return the device-login errors", async () => {
  const pending = await start(["mcp"], "Pending CLI");
  const first = await token(pending.deviceCode, "invalid-input");
  assert.equal(first.statusCode, 400);
  assert.equal(first.json().error, "authorization_pending");
  const second = await token(pending.deviceCode, "invalid-input");
  assert.equal(second.statusCode, 400);
  assert.equal(second.json().error, "slow_down");

  const expired = await start(["mcp"], "Expired CLI");
  await harness.prisma.cliAuthRequest.updateMany({ where: { deviceCodeHash: sha256(expired.deviceCode) }, data: { expiresAt: new Date(0) } });
  const polled = await token(expired.deviceCode, "invalid-input");
  assert.equal(polled.statusCode, 400);
  assert.equal(polled.json().error, "expired_token");
});

test("unknown request code and invalid start body are rejected", async () => {
  const user = await harness.asUser("cli-unknown@example.test");
  const unknown = await inject("GET", "/api/cli/auth/request?code=BCDF-GHJK", "unknown-id", { headers: { cookie: user.cookie } });
  assert.equal(unknown.statusCode, 404, unknown.body);
  const invalid = await inject("POST", "/api/cli/auth/start", "invalid-input", {
    payload: { clientName: "", platform: "darwin", version: "0.1.0", scopes: [] },
  });
  assert.equal(invalid.statusCode, 400, invalid.body);
});

test("runner approval requires a verified email in hosted mode, while MCP-only does not", async () => {
  const user = await harness.asUser("cli-unverified@example.test");
  const previous = { nodeEnv: process.env.NODE_ENV, desktop: process.env.ENSEMBLE_DESKTOP };
  process.env.NODE_ENV = "production";
  process.env.ENSEMBLE_DESKTOP = "0";
  try {
    const runner = await start(["runner"], "Runner CLI");
    const rejected = await approve(user, runner.userCode, ["runner"], "approve", "invalid-input");
    assert.equal(rejected.statusCode, 403, rejected.body);
    assert.equal(rejected.json().code, "EMAIL_UNVERIFIED");

    const mcp = await start(["mcp"], "MCP CLI");
    const approved = await approve(user, mcp.userCode, ["mcp"]);
    assert.equal(approved.statusCode, 200, approved.body);
  } finally {
    process.env.NODE_ENV = previous.nodeEnv;
    process.env.ENSEMBLE_DESKTOP = previous.desktop;
  }
});

test("bearer tokens cannot approve a CLI login request", async () => {
  const user = await harness.asUser("cli-token-auth@example.test");
  const full = await harness.asToken(user, "full");
  const started = await start(["mcp"], "Token Auth CLI");
  const rejected = await inject("POST", "/api/cli/auth/approve", "invalid-input", {
    headers: { authorization: `Bearer ${full.token}` },
    payload: { userCode: started.userCode, scopes: ["mcp"], decision: "approve" },
  });
  assert.equal(rejected.statusCode, 403, rejected.body);
  assert.equal(rejected.json().error, BROWSER_SESSION_REQUIRED);
});
