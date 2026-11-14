import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { createHttpHarness, HTTP_TEST_PASSWORD, type HttpHarness, type HttpUser } from "../test/http.js";
import { activePlacesRouteCoverage, type RouteCheck } from "../test/route-coverage.js";

let h: HttpHarness;
const covered = new Map<string, Set<RouteCheck>>();
before(async () => { h = await createHttpHarness(); });
after(async () => {
  try {
    for (const [route, checks] of Object.entries(activePlacesRouteCoverage)) {
      for (const check of checks) assert.ok(covered.get(route)?.has(check), `Unexecuted coverage claim: ${check} ${route}`);
    }
  } finally {
    await h?.close();
  }
});
function track(route: string, check: RouteCheck): void {
  const checks = covered.get(route) ?? new Set<RouteCheck>();
  checks.add(check);
  covered.set(route, checks);
}
const windowInput = (surface: "hub" | "node" | "desktop" = "hub") => ({ id: randomUUID(), seq: 1, surface });
const heartbeat = (user: HttpUser, input: ReturnType<typeof windowInput>) => user.inject({ method: "POST", url: "/api/auth/places", payload: input });

test("three Ensemble places and three Node places coexist, with each fourth place refused independently", async () => {
  const user = await h.asUser();
  const ensemble = [windowInput("desktop"), windowInput("hub"), windowInput("hub"), windowInput("hub")];
  const node = Array.from({ length: 4 }, () => windowInput("node"));
  const answers = await Promise.all([...ensemble, ...node].map(input => heartbeat(user, input)));
  assert.equal(answers.filter(answer => answer.statusCode === 200).length, 6);
  for (const [pool, allowed] of [[ensemble, ["hub", "desktop"]], [node, ["node"]]] as const) {
    const listed = await user.inject({ url: `/api/auth/places?surface=${pool[0]!.surface}` });
    assert.equal(listed.json().places.length, 3);
    assert.ok(listed.json().places.every((place: { surface: string }) => allowed.some(surface => surface === place.surface)));
  }
  const token = await h.asToken(user, "full");
  assert.equal((await token.inject({ url: "/api/tasks" })).statusCode, 200);
});

test("Node replacement and release cannot evict or move an Ensemble slot", async () => {
  const user = await h.asUser();
  const hub = windowInput();
  const node = [windowInput("node"), windowInput("node"), windowInput("node")];
  for (const input of [hub, ...node]) assert.equal((await heartbeat(user, input)).statusCode, 200);
  const fourth = windowInput("node");
  const wrong = await user.inject({ method: "POST", url: "/api/auth/places/continue", payload: { ...fourth, replace: hub.id } });
  assert.equal(wrong.statusCode, 409);
  assert.equal(wrong.json().code, "PLACE_WRONG_SURFACE");
  const move = await heartbeat(user, { ...hub, seq: 2, surface: "node" });
  assert.equal(move.statusCode, 409);
  const release = await user.inject({ method: "POST", url: "/api/auth/places/release", payload: { ...hub, seq: 3, surface: "node" } });
  assert.equal(release.statusCode, 409);
  const replaced = await user.inject({ method: "POST", url: "/api/auth/places/continue", payload: { ...fourth, replace: "oldest" } });
  assert.equal(replaced.statusCode, 200, replaced.body);
  const retained = await h.prisma.activePlace.findUniqueOrThrow({ where: { userId_windowId: { userId: user.id, windowId: hub.id } } });
  assert.equal(retained.revoked, false);
  assert.equal(retained.surface, "hub");
  assert.equal((await user.inject({ url: "/api/tasks", headers: { "x-ensemble-place": hub.id } })).statusCode, 200);
});

test("Ensemble replacement never takes the older Node slot; expiry frees only its own pool", async () => {
  const user = await h.asUser();
  const hub = Array.from({ length: 3 }, () => windowInput());
  const node = Array.from({ length: 3 }, () => windowInput("node"));
  for (const input of [...node, ...hub]) await heartbeat(user, input);
  await h.prisma.activePlace.updateMany({ where: { userId: user.id, windowId: node[0]!.id }, data: { lastSeen: new Date(Date.now() - 61_000) } });
  assert.equal((await heartbeat(user, windowInput())).statusCode, 409, "an expired Node place cannot free an Ensemble slot");
  assert.equal((await heartbeat(user, windowInput("node"))).statusCode, 200);
  const fourth = windowInput();
  const replaced = await user.inject({ method: "POST", url: "/api/auth/places/continue", payload: { ...fourth, replace: "oldest" } });
  assert.equal(replaced.statusCode, 200);
  assert.equal(await h.prisma.activePlace.count({ where: { userId: user.id, surface: "node", revoked: true } }), 0);
});

test("Node request refusals list only Node places, and cannot reuse an Ensemble lease header", async () => {
  const user = await h.asUser();
  const hub = windowInput();
  const node = windowInput("node");
  await heartbeat(user, hub);
  await heartbeat(user, node);
  const headers = { "x-ensemble-place-surface": "node" };
  const wrong = await user.inject({ url: "/api/tasks", headers: { ...headers, "x-ensemble-place": hub.id } });
  assert.equal(wrong.statusCode, 409);
  assert.equal(wrong.json().code, "PLACE_WRONG_SURFACE");
  const expired = await user.inject({ url: "/api/tasks", headers: { ...headers, "x-ensemble-place": randomUUID() } });
  assert.equal(expired.statusCode, 409);
  assert.deepEqual(expired.json().places.map((place: { windowId: string }) => place.windowId), [node.id]);
  const stream = await user.inject({ url: `/api/node/events?place=${randomUUID()}&placeAccount=${user.id}` });
  assert.equal(stream.statusCode, 409);
  assert.deepEqual(stream.json().places.map((place: { windowId: string }) => place.windowId), [node.id]);
  const switched = await user.inject({ url: `/api/node/events?place=${node.id}&placeAccount=someone-else` });
  assert.equal(switched.statusCode, 409);
  assert.equal(switched.json().code, "PLACE_ACCOUNT_CHANGED");
});

test("four simultaneous tabs admit exactly three; blocked tabs cannot read or save with their place id", async () => {
  const user = await h.asUser();
  const windows = Array.from({ length: 4 }, () => windowInput());
  const answers = await Promise.all(windows.map((input) => heartbeat(user, input)));
  assert.equal(answers.filter((answer) => answer.statusCode === 200).length, 3);
  const index = answers.findIndex((answer) => answer.statusCode === 409);
  const blocked = answers[index]!;
  assert.equal(blocked.json().code, "PLACE_LIMIT");
  assert.equal(blocked.json().places.length, 3);
  assert.doesNotMatch(blocked.body, /sessionId|userAgent|tokenHash/);
  const headers = { "x-ensemble-place": windows[index]!.id };
  for (const request of [{ url: "/api/tasks" }, { method: "PATCH" as const, url: "/api/settings", payload: { desktopReminders: true } }]) {
    const answer = await user.inject({ ...request, headers });
    assert.equal(answer.statusCode, 409, answer.body);
  }
});

test("closing and expiry free slots; delayed heartbeats cannot undo closing", async () => {
  const user = await h.asUser();
  const windows = Array.from({ length: 4 }, () => windowInput());
  for (const input of windows.slice(0, 3)) assert.equal((await heartbeat(user, input)).statusCode, 200);
  track("POST /api/auth/places", "happy-path");
  assert.equal((await heartbeat(user, windows[3]!)).statusCode, 409);
  const released = await user.inject({ method: "POST", url: "/api/auth/places/release", payload: { ...windows[0], seq: 2 } });
  assert.equal(released.statusCode, 204);
  assert.equal((await heartbeat(user, windows[0]!)).statusCode, 409);
  assert.equal((await heartbeat(user, windows[3]!)).statusCode, 200);
  track("POST /api/auth/places/release", "happy-path");
  await h.prisma.activePlace.updateMany({ where: { userId: user.id, windowId: windows[1]!.id }, data: { lastSeen: new Date(Date.now() - 61_000) } });
  assert.equal((await heartbeat(user, windowInput())).statusCode, 200);
});

test("closing before the first heartbeat arrives does not create a phantom slot", async () => {
  const user = await h.asUser();
  const input = windowInput();
  const released = await user.inject({ method: "POST", url: "/api/auth/places/release", payload: { ...input, seq: 2 } });
  assert.equal(released.statusCode, 204);
  const delayed = await heartbeat(user, input);
  assert.equal(delayed.statusCode, 409, delayed.body);
  assert.deepEqual((await user.inject({ url: "/api/auth/places" })).json().places, []);
  assert.equal((await heartbeat(user, { ...input, seq: 3 })).statusCode, 200, "a real reopen uses a newer sequence");
});

test("replacement evicts one place, never its shared session; evicted heartbeats cannot reclaim a free slot", async () => {
  const user = await h.asUser();
  const windows = [windowInput("desktop"), windowInput("desktop"), windowInput("hub"), windowInput("hub")];
  for (const input of windows.slice(0, 3)) await heartbeat(user, input);
  assert.equal((await heartbeat(user, windows[3]!)).statusCode, 409);
  const replaced = await user.inject({ method: "POST", url: "/api/auth/places/continue", payload: { ...windows[3], replace: windows[1]!.id } });
  assert.equal(replaced.statusCode, 200, replaced.body);
  assert.equal(replaced.json().places.length, 3);
  const evicted = await heartbeat(user, { ...windows[1]!, seq: 2 });
  assert.equal(evicted.json().code, "PLACE_REPLACED");
  track("POST /api/auth/places/continue", "happy-path");
  assert.equal((await user.inject({ url: "/api/tasks", headers: { "x-ensemble-place": windows[1]!.id } })).statusCode, 409);
  assert.equal((await user.inject({ url: "/api/tasks", headers: { "x-ensemble-place": windows[0]!.id } })).statusCode, 200);
  assert.equal((await user.inject({ url: "/api/auth/me" })).statusCode, 200);
  await user.inject({ method: "POST", url: "/api/auth/places/release", payload: { ...windows[0], seq: 2 } });
  assert.equal((await heartbeat(user, { ...windows[1]!, seq: 3 })).statusCode, 409);
});

test("continue here takes the least recently heard place, and ens keys remain uncapped", async () => {
  const user = await h.asUser();
  const windows = [windowInput(), windowInput(), windowInput()];
  for (const input of windows) await heartbeat(user, input);
  await h.prisma.activePlace.updateMany({ where: { userId: user.id, windowId: windows[1]!.id }, data: { lastSeen: new Date(Date.now() - 30_000) } });
  const fourth = windowInput();
  const result = await user.inject({ method: "POST", url: "/api/auth/places/continue", payload: { ...fourth, replace: "oldest" } });
  assert.equal(result.statusCode, 200, result.body);
  assert.ok((await h.prisma.activePlace.findUniqueOrThrow({ where: { userId_windowId: { userId: user.id, windowId: windows[1]!.id } } })).revoked);
  const key = await h.asToken(user, "full");
  assert.equal((await key.inject({ url: "/api/tasks", headers: { "x-ensemble-place": randomUUID() } })).statusCode, 200);
  assert.equal((await key.inject({ method: "POST", url: "/api/auth/places", payload: windowInput() })).statusCode, 403);
});

test("leases are account-private, survive space changes and are removed with their browser session", async () => {
  const user = await h.asUser();
  const other = await h.asUser();
  const input = windowInput();
  await heartbeat(user, input);
  assert.equal((await other.inject({ url: "/api/auth/places" })).json().places.length, 0);
  track("GET /api/auth/places", "isolation");
  await other.inject({ method: "POST", url: "/api/auth/places/continue", payload: { ...windowInput(), replace: input.id } });
  const mine = (await user.inject({ url: "/api/auth/places" })).json().places;
  assert.deepEqual(mine.map((place: { windowId: string }) => place.windowId), [input.id]);
  track("GET /api/auth/places", "happy-path");
  track("POST /api/auth/places/continue", "isolation");
  const space = await h.prisma.user.create({ data: { email: `${randomUUID()}@spaces.ensemble.invalid`, name: "Work", ownerId: user.id } });
  const switched = await h.app.inject({ url: "/api/tasks", headers: { cookie: `${user.cookie}; ensemble_space=${space.id}`, "x-ensemble-place": input.id } });
  assert.equal(switched.statusCode, 200, switched.body);
  await h.prisma.session.deleteMany({ where: { userId: user.id } });
  assert.equal(await h.prisma.activePlace.count({ where: { userId: user.id } }), 0);
});

test("a password change racing a heartbeat invalidates old sessions and places while renewing the changing window", async () => {
  const user = await h.asUser();
  const input = windowInput();
  await heartbeat(user, input);
  const { sha256, SESSION_COOKIE } = await import("../lib/auth.js");
  const token = randomUUID();
  await h.prisma.session.create({ data: { id: sha256(token), userId: user.id, expiresAt: new Date(Date.now() + 86_400_000) } });
  const headers = { cookie: `${SESSION_COOKIE}=${token}` };
  const [beat, changed] = await Promise.all([
    h.app.inject({ method: "POST", url: "/api/auth/places", headers, payload: { ...input, seq: 2 } }),
    h.app.inject({ method: "PATCH", url: "/api/auth/me", headers, payload: { current: HTTP_TEST_PASSWORD, password: "next-test-password-only-123" } }),
  ]);
  assert.equal(changed.statusCode, 200, changed.body);
  assert.ok(beat.statusCode === 200 || beat.statusCode === 401, beat.body);
  assert.equal(await h.prisma.session.count({ where: { userId: user.id } }), 1);
  assert.equal((await user.inject({ url: "/api/auth/me" })).statusCode, 401);
  assert.equal((await h.app.inject({ url: "/api/auth/me", headers })).statusCode, 401);
  assert.equal(await h.prisma.activePlace.count({ where: { userId: user.id } }), 0);
});

test("an account switch cannot silently admit an old tab or apply its cached settings to the new account", async () => {
  const first = await h.asUser();
  const second = await h.asUser();
  const input = { ...windowInput(), accountId: first.id };
  assert.equal((await heartbeat(first, input)).statusCode, 200);
  const refused = await second.inject({ method: "POST", url: "/api/auth/places", payload: { ...input, seq: 2 } });
  assert.equal(refused.statusCode, 409, refused.body);
  assert.equal(refused.json().code, "PLACE_ACCOUNT_CHANGED");
  assert.equal(await h.prisma.activePlace.count({ where: { userId: second.id } }), 0);
  const save = await second.inject({
    method: "PATCH", url: "/api/settings",
    headers: { "x-ensemble-place": input.id, "x-ensemble-place-account": first.id },
    payload: { timezone: "Europe/London" },
  });
  assert.equal(save.statusCode, 409, save.body);
  assert.equal(save.json().code, "PLACE_ACCOUNT_CHANGED");
});
