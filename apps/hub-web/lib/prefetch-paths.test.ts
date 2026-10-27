import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import { beginNavigation, resetFetchCancelState, trackRequest } from "./fetch-cancel";
import { isPrefetchQuery, isPrefetchRequest, prefetchApiPaths, prefetchQueryKeys } from "./prefetch";

test("Runs preserves queue and history requests during navigation", () => {
  assert.deepEqual(prefetchApiPaths("/runs"), ["/api/runs", "/api/workspace"]);
  assert.deepEqual(prefetchApiPaths("/skills"), ["/api/skills"]);
  assert.deepEqual(prefetchApiPaths("/workspace"), ["/api/workspace"]);
});

test("a query string still counts as the destination prefetch", () => {
  assert.equal(isPrefetchRequest("/runs", "/api/runs?take=10"), true);
  assert.equal(isPrefetchRequest("/runs", "/api/runs/abc"), false);
  assert.equal(isPrefetchRequest("/workspace", "/api/workspace/checkouts"), false);
  assert.equal(isPrefetchRequest("/skills", "/api/tasks"), false);
});

test("a trailing slash is the same destination the desktop export opens", () => {
  assert.deepEqual(prefetchApiPaths("/today/"), ["/api/today/home"]);
  assert.deepEqual(prefetchApiPaths("/runs/"), ["/api/runs", "/api/workspace"]);
  assert.deepEqual(prefetchApiPaths("/skills/"), ["/api/skills"]);
  assert.deepEqual(prefetchApiPaths("/workspace/"), ["/api/workspace"]);
  assert.equal(isPrefetchRequest("/runs/", "/api/runs?take=10"), true);
  assert.equal(isPrefetchRequest("/workspace/", "/api/workspace/checkouts"), false);
  assert.deepEqual(prefetchApiPaths("/connect/claude/"), prefetchApiPaths("/connect"));
  const client = new QueryClient();
  client.setQueryData(["shell"], { modules: "workspace,runs" });
  assert.equal(isPrefetchQuery(client, "/runs/", ["runs", false]), true);
  assert.equal(isPrefetchQuery(client, "/runs/", ["workspace"]), true);
  assert.equal(isPrefetchQuery(client, "/needs-me/", ["approvals"]), true);
  client.clear();
});

test("Runs prefetch respects independently enabled queue and history permissions", () => {
  const client = new QueryClient();
  assert.deepEqual(prefetchQueryKeys(client, "/runs"), []);
  client.setQueryData(["shell"], { modules: "workspace" });
  assert.deepEqual(prefetchQueryKeys(client, "/runs"), [["workspace"]]);
  client.setQueryData(["shell"], { modules: "runs" });
  assert.deepEqual(prefetchQueryKeys(client, "/runs"), [["runs", false]]);
  client.setQueryData(["shell"], { modules: "runs,workspace" });
  assert.deepEqual(prefetchQueryKeys(client, "/runs"), [["workspace"], ["runs", false]]);
  client.clear();
});

test("a later slash-suffixed navigation still keeps the destination prefetch", async () => {
  resetFetchCancelState();
  const leaving = trackRequest(undefined, "/api/tasks");
  const opening = trackRequest(undefined, "/api/runs?take=10");
  const queue = trackRequest(undefined, "/api/workspace");
  assert.equal(beginNavigation((path) => isPrefetchRequest("/runs", path)), true);
  assert.equal(leaving.signal.aborted, true);
  assert.equal(opening.signal.aborted, false);
  assert.equal(queue.signal.aborted, false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(beginNavigation((path) => isPrefetchRequest("/runs/", path)), true);
  assert.equal(opening.signal.aborted, false);
  leaving.close();
  opening.close();
  queue.close();
  resetFetchCancelState();
});

test("the Code prefetch reads this server's folders only when the shell says this account may", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  const client = new QueryClient();
  assert.deepEqual(prefetchQueryKeys(client, "/code"), [], "not before the shell has said");
  client.setQueryData(["shell"], { hostCode: false });
  assert.deepEqual(prefetchQueryKeys(client, "/code"), [], "Ensemble on the web, not its operator: /api/code would be a 403");
  client.setQueryData(["shell"], { hostCode: true });
  assert.deepEqual(prefetchQueryKeys(client, "/code"), [["code-repos"], ["reviews", "needs", false]]);
  client.setQueryData(["shell"], {});
  assert.equal(prefetchQueryKeys(client, "/code").length, 2, "a server that does not say keeps the prefetch");
  client.clear();
});
