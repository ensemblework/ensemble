/**
 * The interaction log and the operator's metrics: a signed-in person's batch is stored without
 * content (routes keep their shape, props only short named values), API tokens store nothing, old or
 * malformed events are refused, retention purges, and /metrics counts requests by route pattern.
 * Runs on the in-memory database.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createHttpHarness, type HttpHarness } from "../test/http.js";

const harness: HttpHarness = await createHttpHarness();
const { cleanProps, purgeInteractionEvents, routeShape } = await import("./telemetry.js");
const { registry, viaOf } = await import("./prometheus.js");
const db = harness.prisma;
after(() => harness.close());

test("a route keeps only its shape and area; unknown screens keep neither", () => {
  assert.deepEqual(routeShape("/pages/5f1c2a7c-5b3c-4f4e-9a21-3d1c2b4a5e6f?tab=x#y"), { route: "/pages/:id", surface: "pages" });
  assert.deepEqual(routeShape("/code/review"), { route: "/code/review", surface: "code" });
  assert.deepEqual(routeShape("/"), { route: "/", surface: "home" });
  assert.deepEqual(routeShape("/board"), { route: "/board", surface: "board" });
  assert.deepEqual(routeShape("/files/My Secret Plan.pdf"), { route: "/files", surface: "files" }, "a segment that is not an id is dropped");
  assert.deepEqual(routeShape("/mira-chens-notes/abc"), { route: "/:other", surface: "other" });
});

test("props keep numbers, booleans and short words; text is dropped", () => {
  assert.deepEqual(cleanProps({ count: 3, ok: true, mode: "split", title: "Quarterly plan for Fieldnote", "Bad Key": 1, ratio: 0.12345 }), { count: 3, ok: true, mode: "split", ratio: 0.123 });
});

test("a signed-in person's batch is stored; an API token's is not; malformed or stale events are refused", async () => {
  const user = await harness.asUser();
  const now = Date.now();
  const batch = {
    sessionKey: "tab0123456789",
    viewport: "1440x900",
    events: [
      { kind: "session", path: "/today", at: now - 5_000 },
      { kind: "view", path: "/pages/5f1c2a7c-5b3c-4f4e-9a21-3d1c2b4a5e6f", at: now - 4_000, durationMs: 42_000 },
      { kind: "view", path: "/board", at: now - 3_000, durationMs: 99 * 60 * 60_000 / 100 },
      { kind: "action", path: "/board", action: "assistant.open", at: now - 2_000, props: { from: "shortcut", note: "free text is dropped here" } },
      { kind: "view", path: "/board", at: now - 3 * 86_400_000, durationMs: 1_000 },
    ],
  };
  const res = await user.inject({ method: "POST", url: "/api/telemetry", payload: batch });
  assert.equal(res.statusCode, 204, res.body);
  const rows = await db.interactionEvent.findMany({ where: { userId: user.id }, orderBy: { at: "asc" } });
  assert.deepEqual(rows.map((row) => [row.kind, row.surface, row.route, row.action, row.durationMs]), [
    ["session", "today", "/today", null, null],
    ["view", "pages", "/pages/:id", null, 42_000],
    ["view", "board", "/board", null, 30 * 60_000],
    ["action", "board", "/board", "assistant.open", null],
  ], "a long view is capped at 30 minutes and a three-day-old event is dropped");
  assert.deepEqual(rows[3]!.props, { from: "shortcut" });
  assert.equal(rows[0]!.viewport, "1440x900");

  const token = await harness.asToken(user, "full");
  assert.equal((await token.inject({ method: "POST", url: "/api/telemetry", payload: batch })).statusCode, 204);
  assert.equal(await db.interactionEvent.count({ where: { userId: user.id } }), 4, "an API token stores nothing");

  const bad = await user.inject({ method: "POST", url: "/api/telemetry", payload: { sessionKey: "x", events: [] } });
  assert.equal(bad.statusCode, 400);
  const tooMany = await user.inject({ method: "POST", url: "/api/telemetry", payload: { ...batch, events: Array.from({ length: 51 }, () => batch.events[0]) } });
  assert.equal(tooMany.statusCode, 400);
});

test("events older than the retention window are purged", async () => {
  const user = await harness.asUser();
  await db.interactionEvent.createMany({
    data: [
      { userId: user.id, sessionKey: "old", at: new Date(Date.now() - 800 * 86_400_000), kind: "view", surface: "board", route: "/board" },
      { userId: user.id, sessionKey: "new", at: new Date(), kind: "view", surface: "board", route: "/board" },
    ],
  });
  assert.ok((await purgeInteractionEvents(db)) >= 1);
  assert.deepEqual((await db.interactionEvent.findMany({ where: { userId: user.id } })).map((row) => row.sessionKey), ["new"]);
});

test("/metrics counts requests by route pattern and tells Vercel's rewrite from direct calls", async () => {
  const user = await harness.asUser();
  await user.inject({ method: "POST", url: "/api/telemetry", payload: { sessionKey: "tab0123456789", events: [] }, headers: { "x-vercel-id": "bom1::abc" } });
  const text = await registry.metrics();
  assert.match(text, /ensemble_http_requests_total\{route="\/api\/telemetry",method="POST",status="2xx",via="vercel"\} \d+/);
  assert.match(text, /ensemble_live_streams \d+/);
  assert.equal(viaOf({ "cf-ray": "x" }), "direct");
});

test("the operator's analytics views (infra/deploy/home/observability/analytics.sql) still match the schema", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../../../../infra/deploy/home/observability/analytics.sql", import.meta.url), "utf8");
  // The views only: the psql settings and the reader role are for the home server's Postgres.
  const views = source.slice(0, source.indexOf("DO $$")).replace(/^\\set .*$/m, "");
  await db.$executeRawUnsafe("DROP SCHEMA IF EXISTS analytics CASCADE");
  for (const statement of views.split(/;\s*\n/).map((part) => part.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean)) {
    await db.$executeRawUnsafe(statement);
  }
  const user = await harness.asUser();
  await db.interactionEvent.create({ data: { userId: user.id, sessionKey: "views", at: new Date(), kind: "view", surface: "board", route: "/board", durationMs: 20_000 } });
  const rows = await db.$queryRawUnsafe<Array<{ account_id: string }>>(`SELECT account_id FROM analytics.engagement WHERE account_id = '${user.id}'`);
  assert.equal(rows.length, 1);
  for (const view of ["users", "activity", "llm_calls", "included_usage", "files", "plot_datasets", "jobs", "devices", "logins", "created_items", "server_actions", "assistant_turns"]) {
    await db.$queryRawUnsafe(`SELECT * FROM analytics.${view} LIMIT 1`);
  }
  await db.$executeRawUnsafe("DROP SCHEMA analytics CASCADE");
});
