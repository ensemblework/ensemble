import assert from "node:assert/strict";
import test from "node:test";
import type { QueryClient } from "@tanstack/react-query";
import { beginNavigation, resetFetchCancelState, trackRequest } from "./fetch-cancel";
import { isPrefetchQuery, isPrefetchRequest, prefetchApiPaths, prefetchQueryKeys } from "./prefetch";

test("runs, skills, and workspace prefetches are one path each", () => {
  assert.deepEqual(prefetchApiPaths("/runs"), ["/api/runs"]);
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
  assert.deepEqual(prefetchApiPaths("/runs/"), ["/api/runs"]);
  assert.deepEqual(prefetchApiPaths("/skills/"), ["/api/skills"]);
  assert.deepEqual(prefetchApiPaths("/workspace/"), ["/api/workspace"]);
  assert.equal(isPrefetchRequest("/runs/", "/api/runs?take=10"), true);
  assert.equal(isPrefetchRequest("/workspace/", "/api/workspace/checkouts"), false);
  assert.deepEqual(prefetchApiPaths("/connect/claude/"), prefetchApiPaths("/connect"));
  assert.equal(isPrefetchQuery({} as QueryClient, "/runs/", ["runs", false]), true);
  assert.equal(isPrefetchQuery({} as QueryClient, "/needs-me/", ["approvals"]), true);
});

test("a later slash-suffixed navigation still keeps the destination prefetch", async () => {
  resetFetchCancelState();
  const leaving = trackRequest(undefined, "/api/tasks");
  const opening = trackRequest(undefined, "/api/runs?take=10");
  assert.equal(beginNavigation((path) => isPrefetchRequest("/runs", path)), true);
  assert.equal(leaving.signal.aborted, true);
  assert.equal(opening.signal.aborted, false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(beginNavigation((path) => isPrefetchRequest("/runs/", path)), true);
  assert.equal(opening.signal.aborted, false);
  leaving.close();
  opening.close();
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
