/**
 * Ensemble spaces over HTTP: a space shares nothing with its siblings, the space cookie
 * only opens spaces the signed-in account owns, API tokens ignore it, account routes act
 * on the account, settings copy and sync stay inside the account, and deleting a space or
 * the account removes the space's rows.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import type { InjectOptions } from "fastify";
import { createHttpHarness, HTTP_TEST_PASSWORD, type HttpHarness, type HttpUser } from "../test/http.js";
import { spacesRouteCoverage, type RouteCheck } from "../test/route-coverage.js";

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
    for (const [route, checks] of Object.entries(spacesRouteCoverage)) {
      for (const check of checks) assert.ok(covered.get(route)?.has(check), `Unexecuted coverage claim: ${check} ${route}`);
    }
  } finally {
    await harness.close();
  }
});

/** A request as `user`, inside `space` when given. */
function as(user: HttpUser, request: InjectOptions, space?: string) {
  const cookie = space ? `${user.cookie}; ensemble_space=${space}` : user.cookie;
  return harness.app.inject({ ...request, headers: { ...request.headers, cookie } });
}

async function titles(res: Promise<{ json: () => unknown }>): Promise<string[]> {
  return ((await res).json() as { tasks: Array<{ title: string }> }).tasks.map((row) => row.title);
}

function spaceCookie(headers: Record<string, unknown>): string | null {
  const raw = headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  const row = list.find((value: string) => value.startsWith("ensemble_space="));
  return row ? row.split(";")[0]!.slice("ensemble_space=".length) : null;
}

async function createSpace(user: HttpUser, body: Record<string, unknown>, space?: string) {
  const res = await as(user, { method: "POST", url: "/api/spaces", payload: { templateId: "semester-desk", ...body } }, space);
  assert.equal(res.statusCode, 201, res.body);
  return { id: (res.json() as { space: { id: string } }).space.id, cookie: spaceCookie(res.headers) };
}

test("a new space opens on its template and shares no records with the account", async () => {
  const mira = await harness.asUser();
  await db.user.update({ where: { id: mira.id }, data: { name: "Mira Chen", onboardingRole: "student", onboardingCompletedAt: new Date() } });
  const own = await as(mira, { method: "POST", url: "/api/tasks", payload: { title: "Account-only task" } });
  assert.equal(own.statusCode, 201, own.body);

  const wrongRole = await as(mira, { method: "POST", url: "/api/spaces", payload: { name: "Side", templateId: "branch-desk" } });
  assert.equal(wrongRole.statusCode, 400);
  assert.match(wrongRole.body, /template for your role/);
  claim("POST /api/spaces", "invalid-input");

  const space = await createSpace(mira, { name: "Thesis", icon: "📚", settings: { mode: "fresh" } });
  assert.equal(space.cookie, space.id);
  claim("POST /api/spaces", "happy-path");

  const listed = await as(mira, { method: "GET", url: "/api/spaces" }, space.id);
  const body = listed.json() as { activeId: string; spaces: Array<{ id: string; name: string; primary: boolean; icon: string | null }> };
  assert.equal(body.activeId, space.id);
  assert.deepEqual(body.spaces.map((row) => [row.name, row.primary]), [["Mira's space", true], ["Thesis", false]]);
  assert.equal(body.spaces[1]!.icon, "📚");
  claim("GET /api/spaces", "happy-path");

  const inSpace = await titles(as(mira, { method: "GET", url: "/api/tasks" }, space.id));
  assert.ok(inSpace.includes("Read the brief"), "the template seeded starters");
  assert.ok(!inSpace.includes("Account-only task"));
  const added = await as(mira, { method: "POST", url: "/api/tasks", payload: { title: "Space-only task" } }, space.id);
  assert.equal(added.statusCode, 201);
  const inAccount = await titles(as(mira, { method: "GET", url: "/api/tasks" }));
  assert.ok(inAccount.includes("Account-only task"));
  assert.ok(!inAccount.includes("Space-only task"));

  const shell = (await as(mira, { method: "GET", url: "/api/shell" }, space.id)).json() as { user: { email: string; name: string }; space: { id: string; name: string; primary: boolean }; onboardingComplete: boolean };
  assert.equal(shell.user.email, mira.email, "who you are is the account");
  assert.equal(shell.user.name, "Mira Chen");
  assert.deepEqual([shell.space.id, shell.space.name, shell.space.primary], [space.id, "Thesis", false]);
  assert.equal(shell.onboardingComplete, true);
});

test("the space cookie only opens spaces the account owns, and tokens ignore it", async () => {
  const mira = await harness.asUser();
  const theirs = await harness.asUser();
  const space = await createSpace(mira, { name: "Side project", settings: { mode: "fresh" } });
  await as(mira, { method: "POST", url: "/api/tasks", payload: { title: "Secret plan" } }, space.id);

  const forged = await as(theirs, { method: "GET", url: "/api/tasks" }, space.id);
  assert.equal(forged.statusCode, 200);
  assert.ok(!(forged.json() as { tasks: Array<{ title: string }> }).tasks.some((row) => row.title === "Secret plan"));
  const shell = (await as(theirs, { method: "GET", url: "/api/shell" }, space.id)).json() as { space: { id: string } };
  assert.equal(shell.space.id, theirs.id);
  assert.equal((await as(theirs, { method: "POST", url: `/api/spaces/${space.id}/switch` })).statusCode, 404);
  assert.equal((await as(theirs, { method: "PATCH", url: `/api/spaces/${space.id}`, payload: { name: "Mine now" } })).statusCode, 404);
  assert.equal((await as(theirs, { method: "DELETE", url: `/api/spaces/${space.id}`, payload: { confirmation: "Side project" } })).statusCode, 404);
  const theirList = (await as(theirs, { method: "GET", url: "/api/spaces" }, space.id)).json() as { activeId: string; spaces: Array<{ id: string }> };
  assert.equal(theirList.activeId, theirs.id);
  assert.ok(!theirList.spaces.some((row) => row.id === space.id));
  claim("GET /api/spaces", "isolation");
  claim("POST /api/spaces/:id/switch", "isolation");
  claim("PATCH /api/spaces/:id", "isolation");
  claim("DELETE /api/spaces/:id", "isolation");

  const token = await harness.asToken(mira, "full");
  const viaToken = await token.inject({ method: "GET", url: "/api/tasks", headers: { cookie: `ensemble_space=${space.id}` } });
  assert.equal(viaToken.statusCode, 200);
  assert.ok(!(viaToken.json() as { tasks: Array<{ title: string }> }).tasks.some((row) => row.title === "Secret plan"), "a token stays in the space it was made in");
  assert.equal((await token.inject({ method: "GET", url: "/api/spaces" })).statusCode, 403);
});

test("account routes act on the account from inside a space", async () => {
  const mira = await harness.asUser();
  const space = await createSpace(mira, { name: "Work", settings: { mode: "fresh" } });
  const me = (await as(mira, { method: "GET", url: "/api/auth/me" }, space.id)).json() as { user: { id: string; email: string }; spaceId: string };
  assert.equal(me.user.id, mira.id);
  assert.equal(me.user.email, mira.email);
  assert.equal(me.spaceId, space.id);

  const profile = await as(mira, { method: "PUT", url: "/api/auth/profile", payload: { name: "Mira Chen", profession: "Engineer" } }, space.id);
  assert.equal(profile.statusCode, 200, profile.body);
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: mira.id } })).name, "Mira Chen");
  const mirrored = await db.user.findUniqueOrThrow({ where: { id: space.id } });
  assert.equal(mirrored.name, "Mira Chen");
  assert.equal(mirrored.profession, "Engineer");
  assert.equal(mirrored.passwordHash, null, "a space is never a login");
  assert.match(mirrored.email, /@spaces\.ensemble\.invalid$/);
});

test("settings copy into a new space, and sync keeps every space the same except connected apps", async () => {
  const mira = await harness.asUser();
  const patched = await as(mira, { method: "PATCH", url: "/api/settings", payload: { appearance: { theme: "light" }, timezone: "Europe/Lisbon" } });
  assert.equal(patched.statusCode, 200, patched.body);
  await as(mira, { method: "PUT", url: "/api/preferences/ui.shortcuts", payload: { value: { palette: { key: "k", alt: true } } } });

  const fresh = await createSpace(mira, { name: "Fresh", settings: { mode: "fresh" } });
  const freshSettings = (await as(mira, { method: "GET", url: "/api/settings" }, fresh.id)).json() as { settings: { appearance: { theme: string }; timezone: string } };
  assert.notEqual(freshSettings.settings.timezone, "Europe/Lisbon");

  const copied = await createSpace(mira, { name: "Copied", settings: { mode: "copy", from: mira.id } });
  const copiedSettings = (await as(mira, { method: "GET", url: "/api/settings" }, copied.id)).json() as { settings: { appearance: { theme: string }; timezone: string } };
  assert.equal(copiedSettings.settings.appearance.theme, "light");
  assert.equal(copiedSettings.settings.timezone, "Europe/Lisbon");
  const shortcut = await db.preference.findFirst({ where: { userId: copied.id, key: "ui.shortcuts", deletedAt: null } });
  assert.ok(shortcut);

  // Bring the account's settings into the fresh space on demand.
  assert.equal((await as(mira, { method: "POST", url: "/api/spaces/settings/copy", payload: { from: mira.id } }, fresh.id)).statusCode, 200);
  const imported = (await as(mira, { method: "GET", url: "/api/settings" }, fresh.id)).json() as { settings: { timezone: string } };
  assert.equal(imported.settings.timezone, "Europe/Lisbon");
  claim("POST /api/spaces/settings/copy", "happy-path");

  const sync = await as(mira, { method: "PUT", url: "/api/spaces/settings/sync", payload: { on: true } }, copied.id);
  assert.equal(sync.statusCode, 200, sync.body);
  claim("PUT /api/spaces/settings/sync", "happy-path");
  await as(mira, { method: "PATCH", url: "/api/settings", payload: { timezone: "Asia/Tokyo", connections: { github: { enabled: true } } } }, copied.id);
  for (const id of [mira.id, fresh.id]) {
    const row = (await as(mira, { method: "GET", url: "/api/settings" }, id === mira.id ? undefined : id)).json() as { settings: { timezone: string; connections: Record<string, { enabled?: boolean }> } };
    assert.equal(row.settings.timezone, "Asia/Tokyo", `sync reached ${id}`);
    assert.notEqual(row.settings.connections.github?.enabled, true, "connected apps stay in their space");
  }
  await as(mira, { method: "DELETE", url: "/api/preferences/ui.shortcuts" }, copied.id);
  assert.equal(await db.preference.count({ where: { userId: { in: [mira.id, fresh.id] }, key: "ui.shortcuts", deletedAt: null } }), 0);

  const otherAccount = await harness.asUser();
  assert.equal((await as(otherAccount, { method: "POST", url: "/api/spaces/settings/copy", payload: { from: mira.id } })).statusCode, 404);
  claim("POST /api/spaces/settings/copy", "isolation");
});

test("deleting a space removes its rows; the first space cannot be deleted; sign-in reopens the last space", async () => {
  const mira = await harness.asUser();
  const space = await createSpace(mira, { name: "Short lived", settings: { mode: "fresh" } });
  await as(mira, { method: "POST", url: "/api/tasks", payload: { title: "Goes away" } }, space.id);

  const login = await harness.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: mira.email, password: HTTP_TEST_PASSWORD } });
  assert.equal(login.statusCode, 200, login.body);
  assert.equal(spaceCookie(login.headers), space.id, "a new sign-in opens the space used last");

  assert.equal((await as(mira, { method: "DELETE", url: `/api/spaces/${mira.id}`, payload: { confirmation: "x" } })).statusCode, 400);
  assert.equal((await as(mira, { method: "DELETE", url: `/api/spaces/${space.id}`, payload: { confirmation: "Wrong" } }, space.id)).statusCode, 400);
  claim("DELETE /api/spaces/:id", "invalid-input");
  const removed = await as(mira, { method: "DELETE", url: `/api/spaces/${space.id}`, payload: { confirmation: "Short lived" } }, space.id);
  assert.equal(removed.statusCode, 204, removed.body);
  assert.equal(spaceCookie(removed.headers), "", "the open space was deleted, so the cookie is cleared");
  claim("DELETE /api/spaces/:id", "happy-path");
  assert.equal(await db.task.count({ where: { userId: space.id } }), 0);
  assert.equal(await db.user.count({ where: { id: space.id } }), 0);
  const after = await harness.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: mira.email, password: HTTP_TEST_PASSWORD } });
  assert.equal(spaceCookie(after.headers), "");
});

test("switching and renaming", async () => {
  const mira = await harness.asUser();
  const space = await createSpace(mira, { name: "Draft", settings: { mode: "fresh" } });
  const back = await as(mira, { method: "POST", url: `/api/spaces/${mira.id}/switch` }, space.id);
  assert.equal(back.statusCode, 200);
  assert.equal(spaceCookie(back.headers), "", "the account's own space clears the cookie");
  const into = await as(mira, { method: "POST", url: `/api/spaces/${space.id}/switch` });
  assert.equal(spaceCookie(into.headers), space.id);
  const renamed = await as(mira, { method: "PATCH", url: `/api/spaces/${space.id}`, payload: { name: "Thesis", icon: "🎓" } });
  assert.equal((renamed.json() as { space: { name: string; icon: string } }).space.name, "Thesis");
  assert.equal((await as(mira, { method: "PATCH", url: `/api/spaces/${mira.id}`, payload: { icon: "abc" } })).statusCode, 400, "an icon is an emoji");
  const first = await as(mira, { method: "PATCH", url: `/api/spaces/${mira.id}`, payload: { name: "Home" } });
  assert.equal((first.json() as { space: { name: string; primary: boolean } }).space.name, "Home");
});

test("deleting the account deletes every space it owns", async () => {
  const mira = await harness.asUser();
  const one = await createSpace(mira, { name: "One", settings: { mode: "fresh" } });
  const two = await createSpace(mira, { name: "Two", settings: { mode: "fresh" } });
  await as(mira, { method: "POST", url: "/api/tasks", payload: { title: "In two" } }, two.id);
  const exported = (await as(mira, { method: "GET", url: "/api/auth/export" }, one.id)).json() as { user: { email: string }; spaces: Array<{ name: string }> };
  assert.equal(exported.user.email, mira.email);
  assert.deepEqual(exported.spaces.map((row) => row.name), ["One", "Two"]);

  const deleted = await as(mira, { method: "DELETE", url: "/api/auth/account", payload: { confirmation: "DELETE", current: HTTP_TEST_PASSWORD } }, one.id);
  assert.equal(deleted.statusCode, 204, deleted.body);
  assert.equal(await db.user.count({ where: { id: { in: [mira.id, one.id, two.id] } } }), 0);
  assert.equal(await db.task.count({ where: { userId: { in: [one.id, two.id] } } }), 0);
});

test("a new space never copies settings from another account, even with sync on", async () => {
  const victim = await harness.asUser();
  await as(victim, { method: "PATCH", url: "/api/settings", payload: { timezone: "Pacific/Auckland" } });
  await db.modelCredential.create({ data: { userId: victim.id, provider: "openai", secret: "v1:victim", hint: "sk-…AL" } });
  const attacker = await harness.asUser();
  assert.equal((await as(attacker, { method: "PUT", url: "/api/spaces/settings/sync", payload: { on: true } })).statusCode, 200);
  for (const mode of ["fresh", "copy", "sync"]) {
    const res = await as(attacker, { method: "POST", url: "/api/spaces", payload: { name: `Try ${mode}`, templateId: "semester-desk", settings: { mode, from: victim.id } } });
    if (mode === "fresh") {
      // "fresh" ignores \`from\` and copies the open space under sync.
      assert.equal(res.statusCode, 201, res.body);
      const id = (res.json() as { space: { id: string } }).space.id;
      assert.equal(await db.modelCredential.count({ where: { userId: id } }), 0);
      const settings = (await as(attacker, { method: "GET", url: "/api/settings" }, id)).json() as { settings: { timezone: string } };
      assert.notEqual(settings.settings.timezone, "Pacific/Auckland");
    } else {
      assert.equal(res.statusCode, 404, `${mode}: ${res.body}`);
    }
  }
});

test("an account whose id is not a UUID (local and desktop) can leave and return to its first space", async () => {
  const { sha256, SESSION_COOKIE, hashPassword } = await import("../lib/auth.js");
  const id = `local-${Date.now()}`;
  await db.user.create({ data: { id, email: `${id}@example.test`, name: "Local Person", passwordHash: await hashPassword(HTTP_TEST_PASSWORD), onboardingRole: "student" } });
  const token = `local-session-${Date.now()}`;
  await db.session.create({ data: { id: sha256(token), userId: id, expiresAt: new Date(Date.now() + 86_400_000), modules: "" } });
  const local: HttpUser = { id, email: `${id}@example.test`, cookie: `${SESSION_COOKIE}=${token}`, inject: (request) => harness.app.inject({ ...request, headers: { ...request.headers, cookie: `${SESSION_COOKIE}=${token}` } }) };
  const space = await createSpace(local, { name: "Elsewhere", settings: { mode: "copy", from: id } });
  const back = await as(local, { method: "POST", url: `/api/spaces/${id}/switch` }, space.id);
  assert.equal(back.statusCode, 200, back.body);
  assert.equal(spaceCookie(back.headers), "");
  assert.equal((await as(local, { method: "PATCH", url: `/api/spaces/${id}`, payload: { name: "Home" } })).statusCode, 200);
  await harness.app.inject({ method: "DELETE", url: `/api/spaces/${space.id}`, payload: { confirmation: "Elsewhere" }, headers: { cookie: local.cookie } });
  await db.session.deleteMany({ where: { userId: id } });
  const { deleteAccountData } = await import("../lib/account-data.js");
  await deleteAccountData(db, id);
});
