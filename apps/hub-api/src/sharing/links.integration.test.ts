/**
 * Public links over HTTP: anyone with the link (no account) opens one item and nothing else,
 * edits only its content when the link allows it, gets a stable creature name, and loses access
 * the moment the owner turns the link off or makes a new one. Five links per account.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import type { InjectOptions } from "fastify";
import { createHttpHarness, type HttpHarness, type HttpUser } from "../test/http.js";
import { linksRouteCoverage, type RouteCheck } from "../test/route-coverage.js";

const harness: HttpHarness = await createHttpHarness();
const db = harness.prisma;
const covered = new Map<string, Set<RouteCheck>>();
function claim(route: string, ...checks: RouteCheck[]): void {
  const set = covered.get(route) ?? new Set<RouteCheck>();
  for (const check of checks) set.add(check);
  covered.set(route, set);
}

after(async () => {
  try {
    for (const [route, checks] of Object.entries(linksRouteCoverage)) {
      for (const check of checks) assert.ok(covered.get(route)?.has(check), `Unexecuted coverage claim: ${check} ${route}`);
    }
  } finally {
    await harness.close();
  }
});

async function person(name: string): Promise<HttpUser> {
  const user = await harness.asUser();
  await db.user.update({ where: { id: user.id }, data: { name, onboardingRole: "student", onboardingCompletedAt: new Date(), emailVerifiedAt: new Date() } });
  return user;
}

/** No cookie at all: someone who only has the link. */
function anon(token: string, request: InjectOptions, visitor = "visitor-one-123") {
  return harness.app.inject({ ...request, headers: { ...(request.headers as Record<string, string>), "x-ensemble-link": token, "x-ensemble-visitor": visitor } });
}

async function ok<T>(res: Promise<{ statusCode: number; body: string; json: () => unknown }>, status = 200): Promise<T> {
  const done = await res;
  assert.equal(done.statusCode, status, done.body);
  return (status === 204 ? undefined : done.json()) as T;
}

test("anyone with a view link reads that page and nothing else", async () => {
  const mira = await person("Mira Chen");
  const page = await ok<{ page: { id: string } }>(mira.inject({ method: "POST", url: "/api/pages" }), 201);
  const other = await ok<{ page: { id: string } }>(mira.inject({ method: "POST", url: "/api/pages" }), 201);
  const made = await ok<{ link: { id: string; token: string; role: string } }>(
    mira.inject({ method: "POST", url: "/api/links", payload: { kind: "page", resourceId: page.page.id, role: "view" } }),
    201,
  );
  claim("POST /api/links", "happy-path");
  const token = made.link.token;

  const opened = await ok<{ kind: string; resourceId: string; role: string; owner: { name: string }; you: { name: string; emoji: string; signedIn: boolean } }>(
    anon(token, { method: "GET", url: "/api/links/open" }),
  );
  assert.deepEqual([opened.kind, opened.resourceId, opened.role, opened.owner.name, opened.you.signedIn], ["page", page.page.id, "view", "Mira Chen", false]);
  assert.match(opened.you.name, /^[A-Z][a-z]+ [A-Z][a-z]+$/, "an adjective and a creature");
  const again = await ok<{ you: { name: string } }>(anon(token, { method: "GET", url: "/api/links/open" }));
  assert.equal(again.you.name, opened.you.name, "the same visitor keeps the same name");
  claim("GET /api/links/open", "happy-path");

  await ok(anon(token, { method: "GET", url: `/api/pages/${page.page.id}` }));
  for (const url of [`/api/pages/${other.page.id}`, "/api/tasks", "/api/settings", "/api/auth/me", "/api/connectors", "/api/sharing/overview", `/api/pages/page/${page.page.id}/comments`]) {
    const res = await anon(token, { method: "GET", url });
    assert.ok([401, 403, 404].includes(res.statusCode), `${url}: ${res.statusCode}`);
  }
  const write = await anon(token, { method: "PUT", url: `/api/pages/${page.page.id}`, payload: { revision: 1, content: { type: "doc", content: [] } } });
  assert.equal(write.statusCode, 403, "view only");
  const assistant = await anon(token, { method: "POST", url: "/api/assistant/turn", payload: { message: "hi" } });
  assert.equal(assistant.statusCode, 403, "no model calls on someone else's link");

  const bad = await harness.app.inject({ method: "GET", url: "/api/links/open", headers: { "x-ensemble-link": "not-a-real-token-at-all-000" } });
  assert.equal(bad.statusCode, 401);
  claim("GET /api/links/open", "isolation");
});

test("an edit link lets anyone edit the content; turning it off or rotating ends access", async () => {
  const mira = await person("Mira Chen");
  const ben = await person("Ben Ortiz");
  const page = await ok<{ page: { id: string } }>(mira.inject({ method: "POST", url: "/api/pages" }), 201);
  const made = await ok<{ link: { id: string; token: string } }>(
    mira.inject({ method: "POST", url: "/api/links", payload: { kind: "page", resourceId: page.page.id, role: "edit" } }),
    201,
  );
  const current = await ok<{ revision: number }>(anon(made.link.token, { method: "GET", url: `/api/pages/${page.page.id}` }));
  const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Written by a visitor" }] }] };
  await ok(anon(made.link.token, { method: "PUT", url: `/api/pages/${page.page.id}`, payload: { revision: current.revision, content: doc } }));
  const seen = await mira.inject({ method: "GET", url: `/api/pages/${page.page.id}` });
  assert.ok(seen.body.includes("Written by a visitor"));
  assert.equal(await db.undoEntry.count({ where: { userId: mira.id, actorAccountId: { startsWith: "visitor:" } } }), 0, "visitors leave no undo rows");

  // Signed in on someone else's link: you, by name.
  const asBen = await ok<{ you: { name: string; signedIn: boolean } }>(
    harness.app.inject({ method: "GET", url: "/api/links/open", headers: { cookie: ben.cookie, "x-ensemble-link": made.link.token } }),
  );
  assert.deepEqual([asBen.you.name, asBen.you.signedIn], ["Ben Ortiz", true]);

  const peek = await ben.inject({ method: "GET", url: `/api/links/item?kind=page&resourceId=${page.page.id}` });
  assert.ok(peek.json().link === null, "in Ben's own space there is no such item");
  const listed = await ok<{ links: Array<{ id: string; opens: number }>; limit: number }>(mira.inject({ method: "GET", url: "/api/links" }));
  assert.equal(listed.limit, 5);
  assert.ok((listed.links.find((row) => row.id === made.link.id)?.opens ?? 0) >= 1);
  claim("GET /api/links", "happy-path");
  const item = await ok<{ link: { id: string } | null; used: number }>(mira.inject({ method: "GET", url: `/api/links/item?kind=page&resourceId=${page.page.id}` }));
  assert.equal(item.link?.id, made.link.id);
  claim("GET /api/links/item", "happy-path");

  const rotated = await ok<{ link: { token: string } }>(mira.inject({ method: "POST", url: `/api/links/${made.link.id}/rotate` }));
  assert.notEqual(rotated.link.token, made.link.token);
  assert.equal((await anon(made.link.token, { method: "GET", url: "/api/links/open" })).statusCode, 401, "the old address stops working");
  await ok(anon(rotated.link.token, { method: "GET", url: "/api/links/open" }));
  claim("POST /api/links/:id/rotate", "happy-path");
  const notYours = await ben.inject({ method: "DELETE", url: `/api/links/${made.link.id}` });
  assert.equal(notYours.statusCode, 403);
  claim("DELETE /api/links/:id", "isolation");
  await ok(mira.inject({ method: "DELETE", url: `/api/links/${made.link.id}` }), 204);
  claim("DELETE /api/links/:id", "happy-path");
  assert.equal((await anon(rotated.link.token, { method: "GET", url: "/api/links/open" })).statusCode, 401);
});

test("five public links per account, only for pages, tasks, diagrams and meeting notes", async () => {
  const mira = await person("Mira Chen");
  const ids: string[] = [];
  for (let index = 0; index < 6; index += 1) ids.push((await ok<{ page: { id: string } }>(mira.inject({ method: "POST", url: "/api/pages" }), 201)).page.id);
  for (const id of ids.slice(0, 5)) await ok(mira.inject({ method: "POST", url: "/api/links", payload: { kind: "page", resourceId: id, role: "view" } }), 201);
  const sixth = await mira.inject({ method: "POST", url: "/api/links", payload: { kind: "page", resourceId: ids[5], role: "view" } });
  assert.equal(sixth.statusCode, 409);
  assert.match(sixth.body, /5 public links/);
  const space = await mira.inject({ method: "POST", url: "/api/links", payload: { kind: "board", resourceId: mira.id, role: "view" } });
  assert.equal(space.statusCode, 400, "a board, a space or code is never public");
  claim("POST /api/links", "invalid-input");

  const task = await ok<{ task: { id: string } }>(mira.inject({ method: "POST", url: "/api/tasks", payload: { title: "Public task" } }), 201);
  await ok(mira.inject({ method: "DELETE", url: `/api/links/${(await ok<{ links: Array<{ id: string }> }>(mira.inject({ method: "GET", url: "/api/links" }))).links[0]!.id}` }), 204);
  const tl = await ok<{ link: { token: string } }>(mira.inject({ method: "POST", url: "/api/links", payload: { kind: "task", resourceId: task.task.id, role: "edit" } }), 201);
  await ok(anon(tl.link.token, { method: "GET", url: `/api/tasks/${task.task.id}` }));
  const props = await anon(tl.link.token, { method: "PATCH", url: `/api/tasks/${task.task.id}`, payload: { title: "Renamed by a stranger" } });
  assert.equal(props.statusCode, 403, "an edit link changes the task's page, not its properties");

  await ok(anon(tl.link.token, { method: "POST", url: "/api/presence", payload: { tabId: "visitor-tab-1", route: "/secret" } }), 204);
  const room = await ok<{ people: Array<{ name: string; emoji: string | null; route: string | null; signedIn: boolean }> }>(mira.inject({ method: "GET", url: "/api/presence" }));
  const visitor = room.people.find((row) => !row.signedIn);
  assert.ok(visitor?.emoji, "the owner sees the visitor with their creature");
  assert.equal(visitor?.route, null, "a visitor never reports where else they are");
});
