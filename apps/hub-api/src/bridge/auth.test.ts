import assert from "node:assert/strict";
import test from "node:test";
import { bridgeWriteRejected, deviceTokenRejected, hooksTokenRejected, readOnlyTokenRejected } from "./auth.js";

test("bridge-scope tokens may reach only bridge reads, hosted MCP, and CLI logout", () => {
  assert.equal(readOnlyTokenRejected("bridge", "GET", "/api/bridge/today"), null);
  assert.equal(readOnlyTokenRejected("bridge", "POST", "/mcp"), null);
  assert.equal(readOnlyTokenRejected("bridge", "GET", "/mcp"), null);
  assert.equal(readOnlyTokenRejected("bridge", "DELETE", "/mcp"), null);
  assert.equal(readOnlyTokenRejected("bridge", "POST", "/api/cli/logout"), null);
  assert.match(readOnlyTokenRejected("bridge", "POST", "/api/cli/auth/approve") ?? "", /read-only/i);
  assert.match(readOnlyTokenRejected("bridge", "POST", "/api/tasks") ?? "", /read-only/i);
  assert.match(readOnlyTokenRejected("bridge", "POST", "/api/bridge/write/tasks") ?? "", /read-only/i);
});

test("a bridge key made with task updates may write only under /api/bridge/write/", () => {
  assert.equal(readOnlyTokenRejected("bridge", "POST", "/api/bridge/write/tasks", true), null);
  assert.equal(readOnlyTokenRejected("bridge", "PATCH", "/api/bridge/write/tasks/abc", true), null);
  assert.match(readOnlyTokenRejected("bridge", "DELETE", "/api/bridge/write/tasks/abc", true) ?? "", /read-only/i);
  assert.match(readOnlyTokenRejected("bridge", "POST", "/api/tasks", true) ?? "", /read-only/i);
  assert.match(readOnlyTokenRejected("bridge", "PATCH", "/api/tasks/abc", true) ?? "", /read-only/i);
  assert.match(readOnlyTokenRejected("bridge", "POST", "/api/connect/token", true) ?? "", /read-only/i);
});

test("bridge writes accept a signed-in page, a full key or a writing bridge key", () => {
  assert.equal(bridgeWriteRejected({ authVia: "session" }), null);
  assert.equal(bridgeWriteRejected({ authVia: "desktop", tokenScope: "full" }), null);
  assert.equal(bridgeWriteRejected({ authVia: "token", tokenScope: "full" }), null);
  assert.equal(bridgeWriteRejected({ authVia: "token", tokenScope: "bridge", tokenCanWrite: true }), null);
  assert.match(bridgeWriteRejected({ authVia: "token", tokenScope: "bridge", tokenCanWrite: false }) ?? "", /read-only/);
  assert.ok(bridgeWriteRejected({ authVia: "token", tokenScope: "device", tokenCanWrite: true }));
  assert.ok(bridgeWriteRejected({ authVia: "token", tokenScope: "hooks", tokenCanWrite: true }));
  assert.ok(bridgeWriteRejected({ authVia: "link" }));
});

test("device-scope tokens stay limited to their own device routes", () => {
  assert.equal(deviceTokenRejected("device", "DELETE", "/api/devices/self"), null);
  assert.equal(deviceTokenRejected("device", "POST", "/api/devices/self/heartbeat"), null);
  assert.match(deviceTokenRejected("device", "POST", "/mcp") ?? "", /computer/i);
  assert.match(deviceTokenRejected("device", "POST", "/api/cli/logout") ?? "", /computer/i);
});

test("a hooks key may ask, wait, withdraw and report, and nothing else", () => {
  assert.equal(hooksTokenRejected("hooks", "POST", "/api/decisions"), null);
  assert.equal(hooksTokenRejected("hooks", "POST", "/api/decisions/activity"), null);
  assert.equal(hooksTokenRejected("hooks", "GET", "/api/decisions/abc/wait?timeout=25"), null);
  assert.equal(hooksTokenRejected("hooks", "POST", "/api/decisions/abc/cancel"), null);
  for (const [method, path] of [["POST", "/api/decisions/abc/decide"], ["GET", "/api/decisions"], ["POST", "/api/tokens"], ["GET", "/api/tasks"], ["DELETE", "/api/decision-rules/x"]]) {
    assert.match(hooksTokenRejected("hooks", method!, path!) ?? "", /only ask/, `${method} ${path}`);
  }
  assert.equal(hooksTokenRejected("full", "POST", "/api/decisions/abc/decide"), null);
});
