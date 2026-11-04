/**
 * Public links over HTTP: anyone with the link (no account) opens one item and nothing else,
 * edits only its content when the link allows it, gets a stable creature name, and loses access
 * the moment the owner turns the link off or makes a new one. Three links per account.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import type { InjectOptions } from "fastify";
import { createHttpHarness, type HttpHarness, type HttpUser } from "../test/http.js";
import { linksRouteCoverage, type RouteCheck } from "../test/route-coverage.js";
import type { Frame } from "../lib/sse.js";

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
  assert.equal(listed.limit, 3);
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

test("three public links per account, only for pages, tasks, diagrams and meeting notes", async () => {
  const mira = await person("Mira Chen");
  const ids: string[] = [];
  for (let index = 0; index < 6; index += 1) ids.push((await ok<{ page: { id: string } }>(mira.inject({ method: "POST", url: "/api/pages" }), 201)).page.id);
  for (const id of ids.slice(0, 3)) await ok(mira.inject({ method: "POST", url: "/api/links", payload: { kind: "page", resourceId: id, role: "view" } }), 201);
  const fourth = await mira.inject({ method: "POST", url: "/api/links", payload: { kind: "page", resourceId: ids[3], role: "view" } });
  assert.equal(fourth.statusCode, 409);
  assert.match(fourth.body, /3 public links/);
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

test("the owner hears a link visitor arrive, move and leave at once, in order and without lost posts", async () => {
  const mira = await person("Mira Chen");
  const ben = await person("Ben Ortiz");
  const page = await ok<{ page: { id: string } }>(mira.inject({ method: "POST", url: "/api/pages" }), 201);
  const made = await ok<{ link: { token: string } }>(mira.inject({ method: "POST", url: "/api/links", payload: { kind: "page", resourceId: page.page.id, role: "edit" } }), 201);
  const token = made.link.token;
  const { delivers, sseHub } = await import("../lib/sse.js");
  const { AWAY_TTL_MS, PRESENCE_TTL_MS, sweepPresence } = await import("./presence.js");
  type Row = { accountId: string; tabId: string; name: string; role: string; away: boolean; caret: unknown; scroll: unknown; gone?: boolean };
  const frames: Array<{ userId: string; frame: Frame }> = [];
  const stop = sseHub.onFrame((event) => {
    if (event.frame.event === "presence") frames.push(event);
  });
  const owner = { owner: true, accountId: mira.id };
  const visitorStream = { accountId: "visitor:visitor-two-123", owner: false, share: { kind: "page", resourceId: page.page.id, linkId: "link" } };
  const last = (tab: string) => frames.filter((event) => (event.frame.data as Row).tabId === tab).at(-1);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
  try {
    const t = Date.now() * 1000;
    await ok(anon(token, { method: "POST", url: "/api/presence", payload: { tabId: "guest-tab-1", seq: t } }, "visitor-two-123"), 204);
    const joined = last("guest-tab-1");
    assert.ok(joined, "joining publishes at once, without waiting for a heartbeat");
    assert.equal(joined.userId, mira.id, "on the owner's own channel");
    assert.ok(delivers(owner, joined.frame, undefined), "the owner's stream delivers it");
    assert.deepEqual(joined.frame.about, { kind: "page", id: page.page.id });
    const row = joined.frame.data as Row;
    assert.equal(row.role, "edit");
    assert.match(row.name, /^[A-Z][a-z]+ [A-Z][a-z]+$/);

    // The owner on the page is heard by the visitor's item-only stream; a signed-in visitor shows by name.
    await ok(mira.inject({ method: "POST", url: "/api/presence", payload: { tabId: "mira-tab-1", route: `/pages/${page.page.id}`, resource: { kind: "page", id: page.page.id } } }), 204);
    const miraFrame = last("mira-tab-1")!;
    assert.ok(delivers(visitorStream, miraFrame.frame, undefined), "a link visitor hears the owner on the item");
    assert.equal((miraFrame.frame.data as Row).role, "owner");
    await ok(harness.app.inject({ method: "POST", url: "/api/presence", payload: { tabId: "ben-tab-1" }, headers: { cookie: ben.cookie, "x-ensemble-link": token } }), 204);
    assert.deepEqual([(last("ben-tab-1")!.frame.data as Row).name, (last("ben-tab-1")!.frame.data as Row).role], ["Ben Ortiz", "edit"]);

    // Posts closer together than the gap are merged into one frame with the latest state, never dropped.
    await ok(anon(token, { method: "POST", url: "/api/presence", payload: { tabId: "guest-tab-1", seq: t + 1, caret: { anchor: 2, head: 4 } } }, "visitor-two-123"), 204);
    await ok(anon(token, { method: "POST", url: "/api/presence", payload: { tabId: "guest-tab-1", seq: t + 2, scroll: { pos: 9 } } }, "visitor-two-123"), 204);
    await settle();
    const merged = last("guest-tab-1")!.frame.data as Row;
    assert.deepEqual([merged.caret, merged.scroll], [{ anchor: 2, head: 4 }, { pos: 9 }]);

    // A leave, then a late post from before it: the late one is ignored, so nobody comes back as a ghost.
    await ok(anon(token, { method: "POST", url: "/api/presence", payload: { tabId: "guest-tab-1", seq: t + 10, leave: true } }, "visitor-two-123"), 204);
    assert.equal((last("guest-tab-1")!.frame.data as Row).gone, true, "leaving publishes at once");
    await ok(anon(token, { method: "POST", url: "/api/presence", payload: { tabId: "guest-tab-1", seq: t + 9 } }, "visitor-two-123"), 204);
    const room = await ok<{ now: number; people: Row[] }>(mira.inject({ method: "GET", url: "/api/presence" }));
    assert.equal(room.people.some((entry) => entry.tabId === "guest-tab-1"), false);
    assert.equal(typeof room.now, "number");
    // A reload: the same tab joins again with a later seq.
    await ok(anon(token, { method: "POST", url: "/api/presence", payload: { tabId: "guest-tab-1", seq: t + 11 } }, "visitor-two-123"), 204);
    assert.equal((last("guest-tab-1")!.frame.data as Row).gone, undefined);

    // Silent tabs drop off on their own, and the owner hears it; a background tab is kept longer.
    await ok(anon(token, { method: "POST", url: "/api/presence", payload: { tabId: "guest-tab-2", seq: t, away: true } }, "visitor-three-123"), 204);
    const now = Date.now();
    sweepPresence(now + PRESENCE_TTL_MS + 1_000);
    assert.equal((last("guest-tab-1")!.frame.data as Row).gone, true, "a closed laptop or lost network leaves after the TTL");
    assert.equal(last("guest-tab-1")!.userId, mira.id);
    assert.equal((last("guest-tab-2")!.frame.data as Row).gone, undefined, "a background tab stays");
    sweepPresence(now + AWAY_TTL_MS + 1_000);
    assert.equal((last("guest-tab-2")!.frame.data as Row).gone, true);
  } finally {
    stop();
  }
});

test("people in one room get distinct colours, so their carets and cursors tell them apart", async () => {
  const mira = await person("Mira Chen");
  const page = await ok<{ page: { id: string } }>(mira.inject({ method: "POST", url: "/api/pages" }), 201);
  const made = await ok<{ link: { token: string } }>(mira.inject({ method: "POST", url: "/api/links", payload: { kind: "page", resourceId: page.page.id, role: "view" } }), 201);
  const { anonymousVisitor } = await import("./visitors.js");
  const visitors = Array.from({ length: 9 }, (_, index) => `colour-visitor-${index}`);
  const wanted = visitors.map((id) => anonymousVisitor(id).color);
  assert.ok(new Set(wanted).size < wanted.length, "some of these visitors would share a colour");
  for (const [index, visitor] of visitors.entries()) {
    await ok(anon(made.link.token, { method: "POST", url: "/api/presence", payload: { tabId: `colour-tab-${index}` } }, visitor), 204);
  }
  // A second tab keeps the person's colour.
  await ok(anon(made.link.token, { method: "POST", url: "/api/presence", payload: { tabId: "colour-tab-0b" } }, visitors[0]), 204);
  const room = await ok<{ people: Array<{ accountId: string; tabId: string; color: string }> }>(mira.inject({ method: "GET", url: "/api/presence" }));
  const mine = room.people.filter((entry) => entry.tabId.startsWith("colour-tab-"));
  const byPerson = new Map(mine.map((entry) => [entry.accountId, entry.color]));
  assert.equal(byPerson.size, 9);
  assert.equal(new Set(byPerson.values()).size, 9, "nobody shares a colour");
  assert.equal(mine.find((entry) => entry.tabId === "colour-tab-0b")?.color, mine.find((entry) => entry.tabId === "colour-tab-0")?.color);
});
