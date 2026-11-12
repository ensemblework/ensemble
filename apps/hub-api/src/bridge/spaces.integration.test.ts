import assert from "node:assert/strict";
import test, { after } from "node:test";
import type { InjectOptions } from "fastify";
import { createHttpHarness, type HttpUser } from "../test/http.js";

const h = await createHttpHarness();
after(() => h.close());
const db = h.prisma;
const { createSpaceUser, SPACE_COOKIE } = await import("../spaces/store.js");
const { newApiToken } = await import("../lib/auth.js");

/** A key minted the way Connect your apps mints one: from a signed-in page, in the space it has open. */
async function mint(user: HttpUser, openSpace?: string) {
  const cookie = openSpace ? `${user.cookie}; ${SPACE_COOKIE}=${openSpace}` : user.cookie;
  const made = await h.app.inject({ method: "POST", url: "/api/connect/token", headers: { cookie }, payload: { name: "Editor" } });
  assert.equal(made.statusCode, 200, made.body);
  return keyOf(made.json<{ id: string; token: string }>());
}

function keyOf(key: { id: string; token: string }) {
  return {
    id: key.id,
    token: key.token,
    inject: (request: InjectOptions, space?: string) =>
      h.app.inject({ ...request, headers: { ...request.headers, authorization: `Bearer ${key.token}`, ...(space ? { "x-ensemble-space": space } : {}) } }),
  };
}

/** A key with no recorded account: only its space is known. */
async function unrecordedKey(spaceId: string) {
  const minted = newApiToken();
  const row = await db.apiToken.create({ data: { userId: spaceId, name: "Older editor", tokenHash: minted.hash, prefix: minted.prefix, scope: "bridge", canWrite: true } });
  return keyOf({ id: row.id, token: minted.token });
}

async function world() {
  const mira = await h.asUser();
  const ben = await h.asUser();
  const fieldnote = await createSpaceUser(db, mira.id, { name: "Fieldnote", icon: null });
  const bens = await createSpaceUser(db, ben.id, { name: "Ben's team", icon: null });
  await db.spaceMember.create({ data: { spaceId: bens, accountId: mira.id, role: "editor", addedBy: ben.id } });
  await db.task.create({ data: { userId: mira.id, title: "Home task", status: "todo", createdBy: "me" } });
  await db.task.create({ data: { userId: fieldnote, title: "Fieldnote task", status: "todo", createdBy: "me" } });
  await db.task.create({ data: { userId: bens, title: "Ben's task", status: "todo", createdBy: "me" } });
  return { mira, ben, fieldnote, bens };
}

const titles = (body: string) => JSON.parse(body).tasks.map((task: { title: string }) => task.title) as string[];

test("a key reaches every space its account owns when a request names one, and nothing else", async () => {
  const { mira, ben, fieldnote, bens } = await world();
  const key = await mint(mira);
  assert.equal((await db.apiToken.findUniqueOrThrow({ where: { id: key.id } })).accountId, mira.id);

  assert.deepEqual(titles((await key.inject({ method: "GET", url: "/api/bridge/tasks" })).body), ["Home task"]);
  const there = await key.inject({ method: "GET", url: "/api/bridge/tasks" }, fieldnote);
  assert.equal(there.statusCode, 200, there.body);
  assert.deepEqual(titles(there.body), ["Fieldnote task"]);
  const page = await key.inject({ method: "POST", url: "/api/bridge/act/hub_create_page", payload: { input: { title: "Field plan" } } }, fieldnote);
  assert.equal(page.statusCode, 200, page.body);
  assert.equal(await db.taskPage.count({ where: { userId: fieldnote, title: "Field plan" } }), 1, "the change lands in the space named");
  assert.equal(await db.taskPage.count({ where: { userId: mira.id, title: "Field plan" } }), 0);

  const shared = await key.inject({ method: "GET", url: "/api/bridge/tasks" }, bens);
  assert.equal(shared.statusCode, 403);
  assert.match(shared.json<{ error: string }>().error, /“Ben's team” is shared with you, and keys act only in your own spaces/);
  const foreign = await key.inject({ method: "GET", url: "/api/bridge/tasks" }, ben.id);
  assert.equal(foreign.statusCode, 404);
  assert.match(foreign.json<{ error: string }>().error, /cannot open that space/);

  const whoami = (await key.inject({ method: "GET", url: "/api/bridge/whoami" }, fieldnote)).json<{ spaceId: string; spaceName: string; defaultSpace: { id: string }; crossSpace: boolean }>();
  assert.equal(whoami.spaceId, fieldnote);
  assert.equal(whoami.spaceName, "Fieldnote");
  assert.equal(whoami.defaultSpace.id, mira.id);
  assert.equal(whoami.crossSpace, true);

  const spaces = (await key.inject({ method: "GET", url: "/api/bridge/spaces" })).json<{ crossSpace: boolean; spaces: Array<{ id: string; access: string; role: string; default: boolean; usable: boolean }> }>();
  assert.equal(spaces.crossSpace, true);
  assert.deepEqual(
    spaces.spaces.map((row) => [row.id, row.access, row.role, row.default, row.usable]),
    [
      [mira.id, "own", "owner", true, true],
      [fieldnote, "own", "owner", false, true],
      [bens, "member", "editor", false, false],
    ],
  );

  // A full key names a space on any route; a key made inside a space reaches the account's own.
  const full = (await mira.inject({ method: "POST", url: "/api/tokens", payload: { name: "Scripts" } })).json<{ token: string }>();
  const fullTasks = await h.app.inject({ method: "GET", url: "/api/tasks", headers: { authorization: `Bearer ${full.token}`, "x-ensemble-space": fieldnote } });
  assert.equal(fullTasks.statusCode, 200, fullTasks.body);
  assert.match(fullTasks.body, /Fieldnote task/);
  assert.doesNotMatch(fullTasks.body, /Home task/);
  const inSpace = await mint(mira, fieldnote);
  assert.deepEqual(titles((await inSpace.inject({ method: "GET", url: "/api/bridge/tasks" })).body), ["Fieldnote task"]);
  assert.deepEqual(titles((await inSpace.inject({ method: "GET", url: "/api/bridge/tasks" }, mira.id)).body), ["Home task"]);
});

test("a key with no recorded account: made in the account's own space it reaches the account's spaces; made inside a space it stays there", async () => {
  const { mira, fieldnote } = await world();
  const home = await unrecordedKey(mira.id);
  assert.deepEqual(titles((await home.inject({ method: "GET", url: "/api/bridge/tasks" }, fieldnote)).body), ["Fieldnote task"]);

  const pinned = await unrecordedKey(fieldnote);
  assert.deepEqual(titles((await pinned.inject({ method: "GET", url: "/api/bridge/tasks" })).body), ["Fieldnote task"]);
  assert.equal((await pinned.inject({ method: "GET", url: "/api/bridge/tasks" }, fieldnote)).statusCode, 200, "naming its own space is fine");
  const refused = await pinned.inject({ method: "GET", url: "/api/bridge/tasks" }, mira.id);
  assert.equal(refused.statusCode, 404);
  assert.match(refused.json<{ error: string }>().error, /This key works only in “Fieldnote”: make a new key/);
  const whoami = (await pinned.inject({ method: "GET", url: "/api/bridge/whoami" })).json<{ crossSpace: boolean; crossSpaceNote?: string; defaultSpace: { name: string } }>();
  assert.equal(whoami.crossSpace, false);
  assert.equal(whoami.defaultSpace.name, "Fieldnote");
  assert.match(whoami.crossSpaceNote ?? "", /make a new key/);
  const spaces = (await pinned.inject({ method: "GET", url: "/api/bridge/spaces" })).json<{ crossSpace: boolean; spaces: Array<{ id: string }> }>();
  assert.equal(spaces.crossSpace, false);
  assert.deepEqual(spaces.spaces.map((row) => row.id), [fieldnote]);
});

test("the hosted MCP endpoint passes a space on: from the request's header, or a tool's space by name", async () => {
  const { mira, fieldnote } = await world();
  const key = await mint(mira);
  const rpc = (body: unknown, space?: string) =>
    key.inject({ method: "POST", url: "/mcp", headers: { accept: "application/json, text/event-stream", "content-type": "application/json" }, payload: JSON.stringify(body) }, space);
  const call = async (args: Record<string, unknown>, space?: string) => {
    const response = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ensemble_tasks", arguments: args } }, space);
    assert.equal(response.statusCode, 200, response.body);
    return response.json<{ result: { isError?: boolean; content: Array<{ text?: string }> } }>().result;
  };
  const text = (result: { content: Array<{ text?: string }> }) => result.content.map((block) => block.text ?? "").join("\n");

  assert.match(text(await call({}, fieldnote)), /Fieldnote task/);
  const named = await call({ space: "fieldnote" });
  assert.notEqual(named.isError, true, text(named));
  assert.match(text(named), /Fieldnote task/);
  assert.doesNotMatch(text(named), /Home task/);
  const home = await call({});
  assert.match(text(home), /Home task/);
  const shared = await call({ space: "Ben's team" });
  assert.equal(shared.isError, true);
  assert.match(text(shared), /Shared with you/);
  const listed = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ensemble_spaces", arguments: {} } });
  assert.match(listed.body, /Fieldnote/);
});
