import assert from "node:assert/strict";
import test from "node:test";
import { deviceTokenRejected, hooksTokenRejected, readOnlyTokenRejected } from "./auth.js";

test("bridge-scope tokens may reach only bridge reads, hosted MCP, and CLI logout", () => {
  assert.equal(readOnlyTokenRejected("bridge", "GET", "/api/bridge/today"), null);
  assert.equal(readOnlyTokenRejected("bridge", "POST", "/mcp"), null);
  assert.equal(readOnlyTokenRejected("bridge", "GET", "/mcp"), null);
  assert.equal(readOnlyTokenRejected("bridge", "DELETE", "/mcp"), null);
  assert.equal(readOnlyTokenRejected("bridge", "POST", "/api/cli/logout"), null);
  assert.match(readOnlyTokenRejected("bridge", "POST", "/api/cli/auth/approve") ?? "", /read-only/i);
  assert.match(readOnlyTokenRejected("bridge", "POST", "/api/tasks") ?? "", /read-only/i);
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
