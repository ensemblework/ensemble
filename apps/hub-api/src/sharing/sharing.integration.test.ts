/**
 * Sharing over HTTP: who can find whom, the contact and member limits, what a member and a
 * single-item recipient can reach, what stays private (settings, keys, connected apps, undo,
 * chats), runs on the runner's own computer, and the one ownership transfer.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import type { InjectOptions } from "fastify";
import { createHttpHarness, type HttpHarness, type HttpUser } from "../test/http.js";
import { sharingRouteCoverage, type RouteCheck } from "../test/route-coverage.js";

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
    for (const [route, checks] of Object.entries(sharingRouteCoverage)) {
      for (const check of checks) assert.ok(covered.get(route)?.has(check), `Unexecuted coverage claim: ${check} ${route}`);
    }
  } finally {
    await harness.close();
  }
});

async function person(name: string, email?: string): Promise<HttpUser> {
  const user = await harness.asUser(email);
  await db.user.update({ where: { id: user.id }, data: { name, onboardingRole: "student", onboardingCompletedAt: new Date(), emailVerifiedAt: new Date() } });
  return user;
}

/** A request as `user`, inside `space` (cookie) or on one shared item (header). */
function as(user: HttpUser, request: InjectOptions, where?: { space?: string; share?: string }) {
  const cookie = where?.space ? `${user.cookie}; ensemble_space=${where.space}` : user.cookie;
  const headers: Record<string, string> = { ...(request.headers as Record<string, string>), cookie };
  if (where?.share) headers["x-ensemble-share"] = where.share;
  return harness.app.inject({ ...request, headers });
}

async function ok<T>(res: Promise<{ statusCode: number; body: string; json: () => unknown }>, status = 200): Promise<T> {
  const done = await res;
  assert.equal(done.statusCode, status, done.body);
  return (status === 204 ? undefined : done.json()) as T;
}

test("people search masks emails unless you typed the address, and hides spaces and you", async () => {
  const mira = await person("Mira Chen");
  const akash = await person("Akash Sharma", `akash.sharma-${Date.now()}@example.test`);
  await person("Akash Sharma", `asharma-${Date.now()}@example.test`);

  const byName = await ok<{ people: Array<{ id: string; name: string; email: string; exact: boolean }> }>(
    as(mira, { method: "GET", url: "/api/sharing/people?q=akash" }),
  );
  assert.equal(byName.people.filter((row) => row.name === "Akash Sharma").length, 2, "both people with the name show");
  for (const row of byName.people) {
    assert.match(row.email, /•/, "emails are masked for a name search");
    assert.equal(row.exact, false);
  }
  const exact = await ok<{ people: Array<{ id: string; email: string; exact: boolean }> }>(
    as(mira, { method: "GET", url: `/api/sharing/people?q=${encodeURIComponent(akash.email)}` }),
  );
  assert.equal(exact.people[0]?.id, akash.id);
  assert.equal(exact.people[0]?.email, akash.email);
  assert.equal(exact.people[0]?.exact, true);
  claim("GET /api/sharing/people", "happy-path");

  const self = await ok<{ people: Array<{ id: string }> }>(as(mira, { method: "GET", url: "/api/sharing/people?q=Mira" }));
  assert.ok(!self.people.some((row) => row.id === mira.id), "you are not in your own results");

  const space = await ok<{ space: { id: string } }>(as(mira, { method: "POST", url: "/api/spaces", payload: { name: "Mira hidden space", templateId: "semester-desk" } }), 201);
  const spaces = await ok<{ people: Array<{ id: string }> }>(as(akash, { method: "GET", url: "/api/sharing/people?q=Mira" }));
  assert.ok(!spaces.people.some((row) => row.id === space.space.id), "space rows are never people");

  const tooShort = await ok<{ people: unknown[] }>(as(mira, { method: "GET", url: "/api/sharing/people?q=a" }));
  assert.equal(tooShort.people.length, 0);
  claim("GET /api/sharing/people", "invalid-input");
});

test("five contacts at most; removing one takes back everything shared with them", async () => {
  const owner = await person("Olive Owner");
  const people = await Promise.all(["One", "Two", "Three", "Four", "Five", "Six"].map((name) => person(`Contact ${name}`)));
  for (const someone of people.slice(0, 5)) {
    await ok(as(owner, { method: "POST", url: "/api/sharing/contacts", payload: { personId: someone.id } }), 201);
  }
  claim("POST /api/sharing/contacts", "happy-path");
  const full = await as(owner, { method: "POST", url: "/api/sharing/contacts", payload: { personId: people[5]!.id } });
  assert.equal(full.statusCode, 409);
  assert.match(full.body, /up to 5 people/);
  claim("POST /api/sharing/contacts", "invalid-input");

  const page = await ok<{ page: { id: string } }>(as(owner, { method: "POST", url: "/api/pages" }), 201);
  const shared = await ok<{ shares: Array<{ id: string }> }>(
    as(owner, { method: "POST", url: "/api/sharing/items", payload: { kind: "page", resourceId: page.page.id, personId: people[0]!.id, role: "view" } }),
    201,
  );
  await ok(as(owner, { method: "POST", url: `/api/sharing/spaces/${owner.id}/members`, payload: { personId: people[0]!.id, role: "viewer" } }), 201);
  const listed = await ok<{ contacts: Array<{ id: string; spaces: number; items: number }> }>(as(owner, { method: "GET", url: "/api/sharing/contacts" }));
  assert.deepEqual(listed.contacts.find((row) => row.id === people[0]!.id)?.items, 1);
  claim("GET /api/sharing/contacts", "happy-path");

  const removed = await ok<{ removed: { spaces: number; items: number } }>(as(owner, { method: "DELETE", url: `/api/sharing/contacts/${people[0]!.id}` }));
  assert.deepEqual(removed.removed, { spaces: 1, items: 1 });
  claim("DELETE /api/sharing/contacts/:id", "happy-path");
  const gone = await as(people[0]!, { method: "GET", url: `/api/pages/${page.page.id}` }, { share: shared.shares[0]!.id });
  assert.equal(gone.statusCode, 404, "the share header stops working at once");
  const left = await as(people[0]!, { method: "GET", url: "/api/tasks" }, { space: owner.id });
  const ownTasks = await as(people[0]!, { method: "GET", url: "/api/tasks" });
  assert.equal(left.body, ownTasks.body, "the space cookie falls back to their own space");
  claim("DELETE /api/sharing/contacts/:id", "isolation");
});

test("members: viewers read, editors write, private surfaces stay the owner's, settings stay yours", async () => {
  const mira = await person("Mira Chen");
  const ben = await person("Ben Ortiz");
  const cara = await person("Cara Diaz");
  const dev = await person("Dev Patel");
  const space = await ok<{ space: { id: string } }>(as(mira, { method: "POST", url: "/api/spaces", payload: { name: "Launch", templateId: "semester-desk" } }), 201);
  const S = space.space.id;
  await ok(as(mira, { method: "POST", url: "/api/tasks", payload: { title: "Ship the launch post" } }, { space: S }), 201);
  await ok(as(mira, { method: "PATCH", url: "/api/settings", payload: { pageWidth: 72 } }, { space: S }));
  await ok(as(ben, { method: "PATCH", url: "/api/settings", payload: { pageWidth: 36 } }));

  const notYet = await as(ben, { method: "GET", url: "/api/tasks" }, { space: S });
  assert.ok(!notYet.body.includes("Ship the launch post"), "a cookie for a space not shared with you opens nothing");

  const added = await ok<{ members: Array<{ id: string; role: string }> }>(
    as(mira, { method: "POST", url: `/api/sharing/spaces/${S}/members`, payload: { personId: ben.id, role: "viewer" } }),
    201,
  );
  assert.deepEqual(added.members.map((row) => [row.id, row.role]), [[ben.id, "viewer"]]);
  claim("POST /api/sharing/spaces/:id/members", "happy-path");
  const byBen = await as(ben, { method: "POST", url: `/api/sharing/spaces/${S}/members`, payload: { personId: cara.id, role: "viewer" } }, { space: S });
  assert.equal(byBen.statusCode, 403, "only the owner shares the space");
  claim("POST /api/sharing/spaces/:id/members", "isolation");

  const withMe = await ok<{ spaces: Array<{ id: string; role: string; owner: { name: string } }> }>(as(ben, { method: "GET", url: "/api/sharing/with-me" }));
  assert.deepEqual(withMe.spaces.map((row) => [row.id, row.role, row.owner.name]), [[S, "viewer", "Mira Chen"]]);
  claim("GET /api/sharing/with-me", "happy-path");
  const listed = await ok<{ shared: Array<{ id: string }> }>(as(ben, { method: "GET", url: "/api/spaces" }));
  assert.deepEqual(listed.shared.map((row) => row.id), [S]);
  await ok(as(ben, { method: "POST", url: `/api/spaces/${S}/switch` }));

  const tasks = await as(ben, { method: "GET", url: "/api/tasks" }, { space: S });
  assert.ok(tasks.body.includes("Ship the launch post"), "a member reads the space");
  const write = await as(ben, { method: "POST", url: "/api/tasks", payload: { title: "Viewer write" } }, { space: S });
  assert.equal(write.statusCode, 403);
  assert.match(write.body, /view this space/);

  for (const url of ["/api/connectors", "/api/tokens", "/api/reminders", "/api/today/brief"]) {
    const res = await as(ben, { method: "GET", url }, { space: S });
    assert.ok([403, 404].includes(res.statusCode), `${url} is the owner's: ${res.statusCode}`);
    if (res.statusCode === 403) assert.match(res.body, /Only Mira/);
  }
  const settings = await ok<{ settings?: { pageWidth?: string }; pageWidth?: string }>(as(ben, { method: "GET", url: "/api/settings" }, { space: S }));
  assert.equal((settings.settings ?? settings).pageWidth, 36, "settings are the member's own");
  const shell = await ok<{ user: { id: string }; pageWidth: string; space: { shared: { role: string; owner: { name: string } } | null } }>(
    as(ben, { method: "GET", url: "/api/shell" }, { space: S }),
  );
  assert.equal(shell.user.id, ben.id, "the shell shows who you are, not the owner");
  assert.equal(shell.pageWidth, 36);
  assert.deepEqual(shell.space.shared && [shell.space.shared.role, shell.space.shared.owner.name], ["viewer", "Mira Chen"]);
  const copy = await as(ben, { method: "POST", url: "/api/spaces/settings/copy", payload: { from: ben.id } }, { space: S });
  assert.equal(copy.statusCode, 403, "a member cannot overwrite the space's settings");

  await ok(as(mira, { method: "PATCH", url: `/api/sharing/spaces/${S}/members/${ben.id}`, payload: { role: "editor" } }));
  claim("PATCH /api/sharing/spaces/:id/members/:personId", "happy-path");
  await ok(as(ben, { method: "POST", url: "/api/tasks", payload: { title: "Editor write" } }, { space: S }), 201);
  const mine = await as(mira, { method: "GET", url: "/api/tasks" }, { space: S });
  assert.ok(mine.body.includes("Editor write"), "the owner sees the member's work");

  const members = await ok<{ you: string; owner: { id: string }; members: unknown[] }>(as(ben, { method: "GET", url: `/api/sharing/spaces/${S}/members` }, { space: S }));
  assert.equal(members.you, "editor");
  assert.equal(members.owner.id, mira.id);
  claim("GET /api/sharing/spaces/:id/members", "happy-path");
  const stranger = await as(dev, { method: "GET", url: `/api/sharing/spaces/${S}/members` });
  assert.equal(stranger.statusCode, 404);
  claim("GET /api/sharing/spaces/:id/members", "isolation");

  await ok(as(mira, { method: "POST", url: `/api/sharing/spaces/${S}/members`, payload: { personId: cara.id, role: "editor" } }), 201);
  const third = await as(mira, { method: "POST", url: `/api/sharing/spaces/${S}/members`, payload: { personId: dev.id, role: "viewer" } });
  assert.equal(third.statusCode, 409, "a space has at most two members");
  claim("POST /api/sharing/spaces/:id/members", "invalid-input");

  await ok(as(cara, { method: "DELETE", url: `/api/sharing/spaces/${S}/members/${cara.id}` }), 204);
  const after = await as(cara, { method: "GET", url: "/api/tasks" }, { space: S });
  assert.ok(!after.body.includes("Ship the launch post"), "leaving takes the space away");
  await ok(as(mira, { method: "DELETE", url: `/api/sharing/spaces/${S}/members/${ben.id}` }), 204);
  claim("DELETE /api/sharing/spaces/:id/members/:personId", "happy-path");
  const removed = await as(ben, { method: "GET", url: "/api/tasks" }, { space: S });
  assert.ok(!removed.body.includes("Ship the launch post"));
  claim("DELETE /api/sharing/spaces/:id/members/:personId", "isolation");
});

test("undo, chats and comments are each person's own in a shared space", async () => {
  const mira = await person("Mira Chen");
  const ben = await person("Ben Ortiz");
  await ok(as(mira, { method: "POST", url: `/api/sharing/spaces/${mira.id}/members`, payload: { personId: ben.id, role: "editor" } }), 201);
  const space = { space: mira.id };

  const task = await ok<{ task: { id: string } }>(as(mira, { method: "POST", url: "/api/tasks", payload: { title: "Owner task" } }), 201);
  await ok(as(ben, { method: "PATCH", url: `/api/tasks/${task.task.id}`, payload: { title: "Renamed by Ben" } }, space));
  const benUndo = await as(ben, { method: "POST", url: "/api/undo", payload: {} }, space);
  assert.equal(benUndo.statusCode, 200, benUndo.body);
  const afterBen = await ok<{ task: { title: string } }>(as(mira, { method: "GET", url: `/api/tasks/${task.task.id}` }));
  assert.equal(afterBen.task.title, "Owner task", "Ben undid his own rename");
  const benAgain = await as(ben, { method: "POST", url: "/api/undo", payload: {} }, space);
  assert.notEqual(benAgain.statusCode, 200, "Ben cannot undo Mira's create");

  const chat = await ok<{ conversation: { id: string } }>(as(ben, { method: "POST", url: "/api/assistant/conversations", payload: { title: "Ben's chat" } }, space), 201);
  const miraChats = await ok<{ conversations: Array<{ id: string }> }>(as(mira, { method: "GET", url: "/api/assistant/conversations" }));
  assert.ok(!miraChats.conversations.some((row) => row.id === chat.conversation.id), "the owner does not see a member's chats");
  const peek = await as(mira, { method: "GET", url: `/api/assistant/conversations/${chat.conversation.id}/messages` });
  assert.equal(peek.statusCode, 404);

  const page = await ok<{ page: { id: string } }>(as(mira, { method: "POST", url: "/api/pages" }), 201);
  const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Looks good" }] }] };
  const benComment = await ok<{ comment: { id: string; author: { id: string; name: string } } }>(
    as(ben, { method: "POST", url: `/api/pages/page/${page.page.id}/comments`, payload: { body: doc } }, space),
    201,
  );
  assert.deepEqual([benComment.comment.author.id, benComment.comment.author.name], [ben.id, "Ben Ortiz"]);
  const miraComment = await ok<{ comment: { id: string } }>(as(mira, { method: "POST", url: `/api/pages/page/${page.page.id}/comments`, payload: { body: doc } }), 201);
  const benDeletes = await as(ben, { method: "DELETE", url: `/api/comments/${miraComment.comment.id}` }, space);
  assert.equal(benDeletes.statusCode, 403);
  const benEdits = await as(ben, { method: "PATCH", url: `/api/comments/${miraComment.comment.id}`, payload: { body: doc } }, space);
  assert.equal(benEdits.statusCode, 403);
  await ok(as(mira, { method: "DELETE", url: `/api/comments/${benComment.comment.id}` }), 204);
});

test("one shared item opens that item only, and only for its recipient", async () => {
  const mira = await person("Mira Chen");
  const cara = await person("Cara Diaz");
  const dev = await person("Dev Patel");
  const page = await ok<{ page: { id: string } }>(as(mira, { method: "POST", url: "/api/pages" }), 201);
  const other = await ok<{ page: { id: string } }>(as(mira, { method: "POST", url: "/api/pages" }), 201);
  const created = await ok<{ shares: Array<{ id: string; role: string }>; viewOnly: boolean }>(
    as(mira, { method: "POST", url: "/api/sharing/items", payload: { kind: "page", resourceId: page.page.id, personId: cara.id, role: "view" } }),
    201,
  );
  claim("POST /api/sharing/items", "happy-path");
  const share = created.shares[0]!.id;
  const missing = await as(mira, { method: "POST", url: "/api/sharing/items", payload: { kind: "page", resourceId: "00000000-0000-4000-8000-000000000000", personId: cara.id } });
  assert.equal(missing.statusCode, 404);
  claim("POST /api/sharing/items", "invalid-input");

  const opened = await ok<{ kind: string; resourceId: string; role: string; owner: { name: string } }>(as(cara, { method: "GET", url: `/api/sharing/open/${share}` }));
  assert.deepEqual([opened.kind, opened.resourceId, opened.role, opened.owner.name], ["page", page.page.id, "view", "Mira Chen"]);
  claim("GET /api/sharing/open/:id", "happy-path");
  const notYours = await as(dev, { method: "GET", url: `/api/sharing/open/${share}` });
  assert.equal(notYours.statusCode, 404);
  claim("GET /api/sharing/open/:id", "isolation");

  await ok(as(cara, { method: "GET", url: `/api/pages/${page.page.id}` }, { share }));
  const sibling = await as(cara, { method: "GET", url: `/api/pages/${other.page.id}` }, { share });
  assert.equal(sibling.statusCode, 403);
  const list = await as(cara, { method: "GET", url: "/api/tasks" }, { share });
  assert.equal(list.statusCode, 403);
  const rename = await as(cara, { method: "PATCH", url: `/api/pages/${page.page.id}`, payload: { title: "By Cara" } }, { share });
  assert.equal(rename.statusCode, 403, "view only");
  const stolen = await as(dev, { method: "GET", url: `/api/pages/${page.page.id}` }, { share });
  assert.equal(stolen.statusCode, 404, "a share id is useless to anyone else");

  const items = await ok<{ shares: Array<{ id: string; person: { id: string } }> }>(
    as(mira, { method: "GET", url: `/api/sharing/items?kind=page&resourceId=${page.page.id}` }),
  );
  assert.deepEqual(items.shares.map((row) => row.person.id), [cara.id]);
  claim("GET /api/sharing/items", "happy-path");
  const own = await ok<{ shares: unknown[] }>(as(cara, { method: "GET", url: `/api/sharing/items?kind=page&resourceId=${page.page.id}` }));
  assert.deepEqual(own.shares, [], "without the share, Cara is in her own space");
  const peek = await as(cara, { method: "GET", url: `/api/sharing/items?kind=page&resourceId=${page.page.id}` }, { share });
  assert.equal(peek.statusCode, 403, "the recipient cannot see who else has it");
  claim("GET /api/sharing/items", "isolation");

  await ok(as(mira, { method: "PATCH", url: `/api/sharing/items/${share}`, payload: { role: "edit" } }));
  claim("PATCH /api/sharing/items/:id", "happy-path");
  const renamed = await as(cara, { method: "PATCH", url: `/api/pages/${page.page.id}`, payload: { title: "By Cara" } }, { share });
  assert.equal(renamed.statusCode, 200, renamed.body);
  const caraEdits = await as(cara, { method: "PATCH", url: `/api/sharing/items/${share}`, payload: { role: "edit" } });
  assert.equal(caraEdits.statusCode, 403, "the recipient cannot change their own access");
  claim("PATCH /api/sharing/items/:id", "isolation");

  const meeting = await as(mira, { method: "POST", url: "/api/sharing/items", payload: { kind: "code", resourceId: mira.id, personId: cara.id, role: "edit" } });
  assert.equal(meeting.statusCode, 201);
  assert.equal((meeting.json() as { viewOnly: boolean; shares: Array<{ role: string }> }).shares[0]?.role, "view", "code is shared view-only");

  const overview = await ok<{ items: Array<{ id: string }>; contacts: Array<{ id: string }>; limits: { contacts: number; members: number } }>(
    as(mira, { method: "GET", url: "/api/sharing/overview" }),
  );
  assert.ok(overview.items.some((row) => row.id === share));
  assert.deepEqual(overview.limits, { contacts: 5, members: 2 });
  claim("GET /api/sharing/overview", "happy-path");

  await ok(as(cara, { method: "DELETE", url: `/api/sharing/items/${share}` }), 204);
  claim("DELETE /api/sharing/items/:id", "happy-path");
  const after = await as(cara, { method: "GET", url: `/api/pages/${page.page.id}` }, { share });
  assert.equal(after.statusCode, 404);
});

test("presence: members see each other; a single shared item sees only its own room", async () => {
  const mira = await person("Mira Chen");
  const ben = await person("Ben Ortiz");
  const cara = await person("Cara Diaz");
  await ok(as(mira, { method: "POST", url: `/api/sharing/spaces/${mira.id}/members`, payload: { personId: ben.id, role: "viewer" } }), 201);
  const page = await ok<{ page: { id: string } }>(as(mira, { method: "POST", url: "/api/pages" }), 201);
  const share = (await ok<{ shares: Array<{ id: string }> }>(as(mira, { method: "POST", url: "/api/sharing/items", payload: { kind: "page", resourceId: page.page.id, personId: cara.id } }), 201)).shares[0]!.id;

  await ok(as(ben, { method: "POST", url: "/api/presence", payload: { tabId: "ben-tab-1", route: "/board", resource: null } }, { space: mira.id }), 204);
  claim("POST /api/presence", "happy-path");
  await ok(as(cara, { method: "POST", url: "/api/presence", payload: { tabId: "cara-tab-1", route: "/secret", resource: { kind: "page", id: "spoofed" } } }, { share }), 204);
  const seen = await ok<{ people: Array<{ accountId: string; route: string | null; resource: { id: string } | null; color: string }> }>(
    as(mira, { method: "GET", url: "/api/presence" }),
  );
  const cRow = seen.people.find((row) => row.accountId === cara.id);
  assert.equal(seen.people.find((row) => row.accountId === ben.id)?.route, "/board");
  assert.equal(cRow?.route, null, "a shared item's viewer never reports a route");
  assert.equal(cRow?.resource?.id, page.page.id, "and is pinned to the shared item");
  assert.match(cRow?.color ?? "", /^#/);
  claim("GET /api/presence", "happy-path");
  const fromShare = await ok<{ people: Array<{ accountId: string }> }>(as(cara, { method: "GET", url: "/api/presence" }, { share }));
  assert.ok(!fromShare.people.some((row) => row.accountId === ben.id), "Ben is not on the shared page");
  claim("GET /api/presence", "isolation");
});

test("runs: a member runs on their own computer; only they stop it or answer it", async () => {
  const mira = await person("Mira Chen");
  const ben = await person("Ben Ortiz");
  await ok(as(mira, { method: "POST", url: `/api/sharing/spaces/${mira.id}/members`, payload: { personId: ben.id, role: "editor" } }), 201);
  const space = { space: mira.id };

  async function pair(user: HttpUser, name: string, platform: string) {
    const code = (await ok<{ code: string }>(as(user, { method: "POST", url: "/api/devices/pair" }), 201)).code;
    const registered = await ok<{ token: string; device: { id: string } }>(
      harness.app.inject({ method: "POST", url: "/api/devices/register", payload: { code, name, platform, appVersion: "0.1.0", capabilities: { folders: [] } } }),
      201,
    );
    return { id: registered.device.id, inject: (request: InjectOptions) => harness.app.inject({ ...request, headers: { ...request.headers, authorization: `Bearer ${registered.token}` } }) };
  }
  const miraMac = await pair(mira, "Mira's MacBook", "macos");
  const benPc = await pair(ben, "Ben's Gaming PC", "windows");

  const devices = await ok<{ devices: Array<{ id: string }> }>(as(ben, { method: "GET", url: "/api/devices" }, space));
  assert.deepEqual(devices.devices.map((row) => row.id), [benPc.id], "a member lists only their own computers");

  const task = await ok<{ task: { id: string } }>(as(ben, { method: "POST", url: "/api/tasks", payload: { title: "Research competitors" } }, space), 201);
  const onMira = await as(ben, { method: "POST", url: "/api/agent/assign", payload: { taskId: task.task.id, kind: "research", deviceId: miraMac.id } }, space);
  assert.equal(onMira.statusCode, 403);
  assert.match(onMira.body, /your own paired computers/);
  const onHost = await as(ben, { method: "POST", url: "/api/agent/assign", payload: { taskId: task.task.id, kind: "research" } }, space);
  assert.equal(onHost.statusCode, 403);
  assert.match(onHost.body, /your own computer/);
  const assigned = await ok<{ jobId: string }>(as(ben, { method: "POST", url: "/api/agent/assign", payload: { taskId: task.task.id, kind: "research", deviceId: benPc.id } }, space), 201);
  const job = await db.workspaceJob.findUniqueOrThrow({ where: { id: assigned.jobId } });
  assert.equal(job.userId, mira.id, "the job lives in the shared space");
  assert.equal(job.runnerAccountId, ben.id);

  const asMira = await ok<{ job: { deviceName: string | null; deviceId: string | null; yours: boolean; runnerAccountId: string } }>(as(mira, { method: "GET", url: `/api/agent/jobs/${job.id}` }));
  assert.deepEqual([asMira.job.deviceName, asMira.job.deviceId, asMira.job.yours, asMira.job.runnerAccountId], [null, null, false, ben.id], "the owner never sees Ben's computer");
  const asBen = await ok<{ job: { deviceName: string | null; yours: boolean } }>(as(ben, { method: "GET", url: `/api/agent/jobs/${job.id}` }, space));
  assert.deepEqual([asBen.job.deviceName, asBen.job.yours], ["Ben's Gaming PC", true]);

  const notMine = await miraMac.inject({ method: "POST", url: "/api/devices/self/claim" });
  assert.equal(notMine.statusCode, 204, "Mira's computer does not pick up Ben's run");
  const claimed = await ok<{ id: string; leaseToken: string }>(benPc.inject({ method: "POST", url: "/api/devices/self/claim" }));
  assert.equal(claimed.id, job.id);

  const asked = await ok<{ decisionId: string }>(
    benPc.inject({ method: "POST", url: `/api/devices/self/jobs/${job.id}/ask`, payload: { leaseToken: claimed.leaseToken, title: "Open the browser?", options: ["Yes", "No"], event: "question" } }),
    201,
  );
  const needs = await ok<{ decisions: Array<{ id: string; canAnswer: boolean; detail: { deviceName: string | null } }> }>(as(mira, { method: "GET", url: "/api/decisions" }));
  const card = needs.decisions.find((row) => row.id === asked.decisionId);
  assert.deepEqual([card?.canAnswer, card?.detail.deviceName], [false, null], "the owner sees the question, not the computer, and cannot answer");
  const miraAnswers = await as(mira, { method: "POST", url: `/api/decisions/${asked.decisionId}/decide`, payload: { decision: "allow", scope: "once", reason: "Yes" } });
  assert.equal(miraAnswers.statusCode, 403);
  assert.match(miraAnswers.body, /Only Ben/);
  const miraStops = await as(mira, { method: "POST", url: `/api/agent/jobs/${job.id}/stop` });
  assert.equal(miraStops.statusCode, 403);
  await ok(as(ben, { method: "POST", url: `/api/decisions/${asked.decisionId}/decide`, payload: { decision: "allow", scope: "once", reason: "Yes" } }, space));
  await ok(as(ben, { method: "POST", url: `/api/agent/jobs/${job.id}/stop` }, space), 204);
});

test("a space changes owner once; private things stay with the old owner", async () => {
  const mira = await person("Mira Chen");
  const ben = await person("Ben Ortiz");
  const space = await ok<{ space: { id: string } }>(as(mira, { method: "POST", url: "/api/spaces", payload: { name: "Handover", templateId: "semester-desk" } }), 201);
  const S = space.space.id;
  await db.modelCredential.create({ data: { userId: S, provider: "openai", secret: "sealed-test-secret" } });
  assert.equal(await db.modelCredential.count({ where: { userId: S } }), 1);
  await ok(as(mira, { method: "POST", url: "/api/tasks", payload: { title: "Keeps its work" } }, { space: S }), 201);

  const primary = await as(mira, { method: "POST", url: `/api/sharing/spaces/${mira.id}/transfer`, payload: { toId: ben.id, confirmation: "" } });
  assert.equal(primary.statusCode, 400);
  const notMember = await as(mira, { method: "POST", url: `/api/sharing/spaces/${S}/transfer`, payload: { toId: ben.id, confirmation: "Handover" } });
  assert.equal(notMember.statusCode, 400);
  assert.match(notMember.body, /Share the space with them first/);
  claim("POST /api/sharing/spaces/:id/transfer", "invalid-input");

  await ok(as(mira, { method: "POST", url: `/api/sharing/spaces/${S}/members`, payload: { personId: ben.id, role: "viewer" } }), 201);
  const byBen = await as(ben, { method: "POST", url: `/api/sharing/spaces/${S}/transfer`, payload: { toId: ben.id, confirmation: "Handover" } }, { space: S });
  assert.equal(byBen.statusCode, 403);
  claim("POST /api/sharing/spaces/:id/transfer", "isolation");
  await ok(as(mira, { method: "POST", url: `/api/sharing/spaces/${S}/transfer`, payload: { toId: ben.id, confirmation: "Handover" } }));
  claim("POST /api/sharing/spaces/:id/transfer", "happy-path");

  const row = await db.user.findUniqueOrThrow({ where: { id: S }, select: { ownerId: true, name: true } });
  assert.equal(row.ownerId, ben.id);
  assert.equal(row.name, "Ben Ortiz");
  assert.equal(await db.modelCredential.count({ where: { userId: S } }), 0, "model keys never change hands");
  const benTasks = await as(ben, { method: "GET", url: "/api/tasks" }, { space: S });
  assert.ok(benTasks.body.includes("Keeps its work"));
  const miraStill = await ok<{ you: string }>(as(mira, { method: "GET", url: `/api/sharing/spaces/${S}/members` }, { space: S }));
  assert.equal(miraStill.you, "editor", "the old owner stays on as an editor");

  const again = await as(ben, { method: "POST", url: `/api/sharing/spaces/${S}/transfer`, payload: { toId: mira.id, confirmation: "Handover" } }, { space: S });
  assert.equal(again.statusCode, 409);
  assert.match(again.body, /already changed owner once/);
});

test("review fixes: the owner's inbox, Today, settings and desk stay theirs", async () => {
  const mira = await person("Mira Chen");
  const ben = await person("Ben Ortiz");
  const cara = await person("Cara Diaz");
  await ok(as(mira, { method: "POST", url: `/api/sharing/spaces/${mira.id}/members`, payload: { personId: ben.id, role: "viewer" } }), 201);
  const space = { space: mira.id };
  await db.artifact.create({ data: { userId: mira.id, kind: "email", externalId: "mail-1", ts: new Date(), title: "Salary review, confidential", text: "Private body about pay" } });
  await db.artifact.create({ data: { userId: mira.id, kind: "pr", externalId: "pr-1", ts: new Date(), title: "Fix the ranker", text: "A pull request" } });

  const listed = await ok<{ artifacts: Array<{ title: string }>; sync: unknown[] }>(as(ben, { method: "GET", url: "/api/artifacts" }, space));
  assert.deepEqual(listed.artifacts.map((row) => row.title), ["Fix the ranker"], "work artifacts show, the inbox does not");
  const searched = await ok<{ artifacts: unknown[] }>(as(ben, { method: "GET", url: "/api/artifacts?q=Salary" }, space));
  assert.equal(searched.artifacts.length, 0);
  const board = await as(ben, { method: "GET", url: "/api/context/board" }, space);
  assert.ok(!board.body.includes("Salary review"), "the Context desk leaves the inbox out");
  const graph = await as(ben, { method: "GET", url: "/api/context/graph" }, space);
  assert.ok(!graph.body.includes("Salary review"));
  const live = await as(ben, { method: "GET", url: "/api/desk/live" }, space);
  assert.equal(live.statusCode, 200, live.body);
  assert.ok(!live.body.includes("Salary review"), "the live Context tiles leave the inbox out");
  const own = await ok<{ artifacts: Array<{ title: string }> }>(as(mira, { method: "GET", url: "/api/artifacts" }));
  assert.equal(own.artifacts.length, 2, "the owner still sees everything");

  const invoke = await as(ben, { method: "POST", url: "/api/ensemble/invoke", payload: { surface: "today", prompt: "What is due?" } }, space);
  assert.equal(invoke.statusCode, 403, "Today is the owner's");

  for (const [method, url, payload] of [
    ["DELETE", "/api/preferences/hub.settings", undefined],
    ["PUT", "/api/preferences/hub.onboarding", { value: 1 }],
  ] as const) {
    await ok(as(mira, { method: "POST", url: `/api/sharing/spaces/${mira.id}/members`, payload: { personId: ben.id, role: "editor" } }), 201);
    const res = await as(ben, { method, url, ...(payload ? { payload } : {}) }, space);
    assert.ok([400, 403].includes(res.statusCode), `${method} ${url}: ${res.statusCode}`);
  }

  const page = await ok<{ page: { id: string } }>(as(mira, { method: "POST", url: "/api/pages" }), 201);
  const board2 = (await ok<{ shares: Array<{ id: string }> }>(
    as(mira, { method: "POST", url: "/api/sharing/items", payload: { kind: "board", resourceId: mira.id, personId: cara.id } }),
    201,
  )).shares[0]!.id;
  const desk = await as(cara, { method: "GET", url: "/api/context/board" }, { share: board2 });
  assert.equal(desk.statusCode, 403, "a board share is the task board, not the Context desk");
  assert.ok(page.page.id);
});

test("review fixes: transfer keeps each person's chats; removal stops their runs", async () => {
  const mira = await person("Mira Chen");
  const ben = await person("Ben Ortiz");
  const created = await ok<{ space: { id: string } }>(as(mira, { method: "POST", url: "/api/spaces", payload: { name: "Handover two", templateId: "semester-desk" } }), 201);
  const S = created.space.id;
  const miraChat = await ok<{ conversation: { id: string } }>(as(mira, { method: "POST", url: "/api/assistant/conversations", payload: { title: "Mira's private chat" } }, { space: S }), 201);
  await ok(as(mira, { method: "POST", url: `/api/sharing/spaces/${S}/members`, payload: { personId: ben.id, role: "editor" } }), 201);
  await ok(as(mira, { method: "POST", url: `/api/sharing/spaces/${S}/transfer`, payload: { toId: ben.id, confirmation: "Handover two" } }));
  const benChats = await ok<{ conversations: Array<{ id: string }> }>(as(ben, { method: "GET", url: "/api/assistant/conversations" }, { space: S }));
  assert.ok(!benChats.conversations.some((row) => row.id === miraChat.conversation.id), "the new owner does not inherit the old owner's chats");
  const miraChats = await ok<{ conversations: Array<{ id: string }> }>(as(mira, { method: "GET", url: "/api/assistant/conversations" }, { space: S }));
  assert.ok(miraChats.conversations.some((row) => row.id === miraChat.conversation.id), "the old owner keeps them");

  // Removal: a queued run on the removed member's computer is cancelled and cannot be claimed.
  const task = await db.task.create({ data: { userId: S, title: "Queued by Mira", createdBy: "me", status: "todo" } });
  const job = await db.workspaceJob.create({
    data: { userId: S, runnerAccountId: mira.id, taskId: task.id, kind: "research", executionMode: "sandbox", model: "m", status: "queued" },
  });
  await ok(as(ben, { method: "DELETE", url: `/api/sharing/spaces/${S}/members/${mira.id}` }, { space: S }), 204);
  const after = await db.workspaceJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(after.status, "cancelled");
});
