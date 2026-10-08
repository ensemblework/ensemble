/**
 * The sharing policy table: every route has a class, private surfaces are owner-only, viewers
 * only read, and a single shared item only reaches its own routes.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { classify, memberDecision, SHARE_RULE_TABLE, shareDecision, VIEW_ONLY_KINDS } from "./policy.js";
import { delivers } from "../lib/sse.js";

type Row = { method: string; path: string; mode: string };
const inventory = JSON.parse(readFileSync(new URL("../../scripts/route-inventory.json", import.meta.url), "utf8")) as Row[];
const hosted = new Set(inventory.filter((row) => row.mode !== "desktop-only").map((row) => `${row.method} ${row.path}`));

test("every share rule names a route that exists", () => {
  for (const [kind, rules] of Object.entries(SHARE_RULE_TABLE)) {
    for (const rule of rules) assert.ok(hosted.has(`${rule.method} ${rule.url}`), `${kind}: ${rule.method} ${rule.url} is not a route`);
  }
});

test("private surfaces are owner-only for members", () => {
  const owner = [
    ["GET", "/api/connectors"],
    ["POST", "/api/connectors/:provider/connect"],
    ["GET", "/api/tokens"],
    ["POST", "/api/tokens"],
    ["GET", "/api/today"],
    ["GET", "/api/reminders"],
    ["POST", "/api/imports"],
    ["POST", "/api/terminal/sessions"],
    ["PUT", "/api/settings/modules"],
    ["POST", "/api/code/apply"],
    ["POST", "/api/approvals/:id/decide"],
    ["DELETE", "/api/data"],
    ["POST", "/api/cli/auth/approve"],
  ];
  for (const [method, url] of owner) {
    assert.equal(classify(method!, url!), "owner", `${method} ${url}`);
    assert.equal(memberDecision(method!, url!, "editor", "Mira").allow, false, `${method} ${url}`);
  }
});

test("settings, keys and notifications act on the member's own account", () => {
  for (const [method, url] of [
    ["GET", "/api/settings"],
    ["PUT", "/api/settings"],
    ["GET", "/api/model-keys"],
    ["GET", "/api/notifications"],
    ["GET", "/api/devices"],
    ["GET", "/api/metrics/summary"],
  ]) {
    const decision = memberDecision(method!, url!, "viewer", "Mira");
    assert.deepEqual(decision, { allow: true, personal: true }, `${method} ${url}`);
  }
});

test("viewers read, editors write, runner routes need edit access", () => {
  assert.equal(memberDecision("GET", "/api/tasks", "viewer", "Mira").allow, true);
  assert.equal(memberDecision("POST", "/api/tasks", "viewer", "Mira").allow, false);
  assert.equal(memberDecision("POST", "/api/tasks", "editor", "Mira").allow, true);
  assert.equal(memberDecision("POST", "/api/agent/assign", "viewer", "Mira").allow, false);
  assert.equal(memberDecision("POST", "/api/agent/assign", "editor", "Mira").allow, true);
  assert.equal(memberDecision("GET", "/api/code/file", "viewer", "Mira").allow, true);
  assert.equal(memberDecision("POST", "/api/code/file", "editor", "Mira").allow, false);
  const denied = memberDecision("GET", "/api/connectors", "editor", "Mira");
  assert.equal(denied.allow, false);
  if (!denied.allow) assert.match(denied.message, /Mira/);
});

test("a shared page reaches only its own routes", () => {
  const access = { resource: "page" as const, resourceId: "p1", role: "view" as const };
  const input = (params: Record<string, string>, body?: unknown) => ({ params, query: {}, body });
  assert.equal(shareDecision(access, "GET", "/api/pages/:id", input({ id: "p1" })).allow, true);
  assert.equal(shareDecision(access, "GET", "/api/pages/:id", input({ id: "p2" })).allow, false);
  assert.equal(shareDecision(access, "PUT", "/api/pages/:id", input({ id: "p1" })).allow, false, "view role cannot write");
  assert.equal(shareDecision({ ...access, role: "edit" }, "PUT", "/api/pages/:id", input({ id: "p1" })).allow, true);
  assert.equal(shareDecision(access, "GET", "/api/pages/:kind/:id/comments", input({ kind: "task", id: "p1" })).allow, false, "kind must match");
  assert.equal(shareDecision(access, "GET", "/api/tasks", input({})).allow, false);
  assert.equal(shareDecision(access, "GET", "/api/connectors", input({})).allow, false);
  assert.deepEqual(shareDecision(access, "GET", "/api/notifications", input({})), { allow: true, personal: true });
});

test("a shared plot space binds to the query and body id", () => {
  const access = { resource: "plot_space" as const, resourceId: "s1", role: "edit" as const };
  assert.equal(shareDecision(access, "GET", "/api/plots/workspace", { params: {}, query: { id: "s1" }, body: undefined }).allow, true);
  assert.equal(shareDecision(access, "GET", "/api/plots/workspace", { params: {}, query: { id: "s2" }, body: undefined }).allow, false);
  assert.equal(shareDecision(access, "PUT", "/api/plots/workspace", { params: {}, query: {}, body: { id: "s1" } }).allow, true);
  assert.equal(shareDecision(access, "PUT", "/api/plots/workspace", { params: {}, query: {}, body: { id: "s2" } }).allow, false);
});

test("meetings, the workspace tab and code are view-only kinds with no write routes", () => {
  for (const kind of VIEW_ONLY_KINDS) {
    for (const rule of SHARE_RULE_TABLE[kind]) assert.equal(rule.role, "view", `${kind} ${rule.method} ${rule.url}`);
  }
});

test("event frames reach the right people", () => {
  const owner = { accountId: "a", owner: true };
  const member = { accountId: "b", owner: false };
  const page = { accountId: "c", owner: false, share: { kind: "page", resourceId: "p1" } };
  const own = { accountId: "b", personalOnly: true };
  const task = { event: "task", data: { id: "t1" } };
  assert.equal(delivers(owner, task, undefined), true);
  assert.equal(delivers(member, task, undefined), true);
  assert.equal(delivers(page, task, undefined), false);
  assert.equal(delivers(page, { event: "page", data: { id: "p1", action: "save" } }, undefined), true);
  assert.equal(delivers(page, { event: "page", data: { id: "p2", action: "save" } }, undefined), false);
  const frame = { event: "assistant.frame", data: {} };
  assert.equal(delivers(owner, frame, "b"), false, "a member's assistant reply is theirs");
  assert.equal(delivers(member, frame, "b"), true);
  assert.equal(delivers(member, { event: "reminder.due", data: {} }, undefined), false);
  assert.equal(delivers(own, task, undefined), false, "the account channel carries personal frames only");
  assert.equal(delivers(own, { event: "sharing.changed", data: {} }, undefined), true);
  assert.equal(delivers(member, { event: "presence", data: {}, to: "a" }, undefined), false);
  assert.equal(delivers(page, { event: "presence", data: {}, about: { kind: "page", id: "p1" } }, undefined), true);
  assert.equal(delivers(page, { event: "presence", data: {}, about: { kind: "page", id: "p9" } }, undefined), false);
});

test("masked emails tell same-name people apart without giving the address away", async () => {
  const { maskEmail } = await import("./store.js");
  assert.equal(maskEmail("akash.one@example.test"), "ak••••••e@example.test");
  assert.equal(maskEmail("akash.two@example.test"), "ak••••••o@example.test");
  assert.equal(maskEmail("ben@example.test"), "b•••@example.test");
});
