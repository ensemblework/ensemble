/**
 * What a node remembers (node/memory.ts): a fact saved with a key revises the one before it (kept and linked,
 * never deleted), no node changes a pinned memory and the owner's own edits win, past 200 the oldest unused are
 * archived instead of deleted, a turn gets its pinned memories and the owner's preferences always and then those
 * its words call for, and the owner lists, adds, edits, pins and deletes them in Node.
 */
import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import type { LightMyRequestResponse } from "fastify";
import type { NodeMemory } from "@prisma/client";
import { createHttpHarness, type HttpUser } from "../test/http.js";
import type { RuntimeTurn } from "../lib/model-turn.js";

const h = await createHttpHarness();
after(() => h.close());
// After the harness: the database client is made when these load.
const { setAskRuntimeStreamForTests } = await import("../lib/model-turn.js");
const { settleTurns } = await import("./queue.js");
const { DEFAULT_CONTEXT_CONFIG } = await import("../context/config.js");
const { MAX_MEMORIES, MemoryRefused, memoriesForTurn, rememberAsNode } = await import("./memory.js");

type Call = { name: string; arguments: Record<string, unknown> };
let script: (prompt: string) => Call[] = () => [];
const contexts: string[] = [];

setAskRuntimeStreamForTests(async (args) => {
  const messages = args.messages as Array<{ role?: string; content?: unknown }>;
  contexts.push(messages.filter((row) => row.role === "system").map((row) => String(row.content)).join("\n"));
  const last = messages.at(-1);
  const asked = messages.filter((row) => row.role === "user").at(-1)?.content;
  const prompt = Array.isArray(asked) ? asked.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "")).join("\n") : String(asked ?? "");
  const calls = last?.role === "tool" ? [] : script(prompt);
  const turn: RuntimeTurn = {
    text: calls.length ? "" : "(no reply)",
    toolCalls: calls.map((call, index) => ({ id: `call-${index}-${Date.now()}`, name: call.name, arguments: JSON.stringify(call.arguments) })),
    model: "test-model",
    credits: 0,
    tokensIn: 10,
    tokensOut: 5,
    reasoning: "",
    raw: {},
    finishReason: "stop",
    cutOff: false,
  };
  if (turn.text) args.onDelta?.(turn.text);
  return turn;
});

afterEach(async () => {
  await settleTurns();
  script = () => [];
  contexts.length = 0;
});

const json = (response: LightMyRequestResponse) => response.json() as any;

async function owner(name = "Akash"): Promise<HttpUser> {
  const user = await h.asUser();
  await h.prisma.user.update({ where: { id: user.id }, data: { name, emailVerifiedAt: new Date() } });
  return user;
}

async function nodeOf(user: HttpUser, templateId = "assistant") {
  const response = await user.inject({ method: "POST", url: "/api/node/nodes", payload: { templateId } });
  assert.equal(response.statusCode, 201, response.body);
  const { node, room } = json(response) as { node: { id: string }; room: { id: string } };
  return { node: await h.prisma.nodeAgent.findUniqueOrThrow({ where: { id: node.id } }), roomId: room.id };
}

const remember = (node: { id: string; userId: string }, roomId: string, content: string, over: Partial<Parameters<typeof rememberAsNode>[1]> = {}) =>
  rememberAsNode(h.prisma, { node, roomId, turnId: "turn-1", sourceMessageId: "message-1", content, since: new Date(), ...over });

const refused = (pattern: RegExp) => (error: unknown) => error instanceof MemoryRefused && error.status === 409 && pattern.test(error.message);

test("node_remember keeps where a fact came from, and the same key revises it: the old one is linked, never deleted", async () => {
  const akash = await owner();
  const { node, roomId } = await nodeOf(akash);
  script = (prompt) => (prompt.includes("from now on") ? [{ name: "node_remember", arguments: { content: "Akash wants coding work run with Copilot.", key: "coding agent" } }] : []);
  assert.equal((await akash.inject({ method: "POST", url: `/api/node/rooms/${roomId}/messages`, payload: { body: "from now on, use Copilot for coding" } })).statusCode, 201);
  await settleTurns();
  const first = await h.prisma.nodeMemory.findFirstOrThrow({ where: { nodeId: node.id } });
  const asked = await h.prisma.nodeMessage.findFirstOrThrow({ where: { roomId, body: "from now on, use Copilot for coding" } });
  const turn = await h.prisma.nodeTurn.findFirstOrThrow({ where: { nodeId: node.id, triggerMessageId: asked.id } });
  assert.deepEqual([first.key, first.scope, first.sourceMessageId, first.turnId, first.pinned], ["coding agent", "node", asked.id, turn.id, false]);

  const revised = await remember(node, roomId, "Akash wants coding work run with Claude Code.", { key: "Coding Agent" });
  assert.equal(revised.status, "revised");
  assert.equal(revised.replaced?.id, first.id);
  const old = await h.prisma.nodeMemory.findUniqueOrThrow({ where: { id: first.id } });
  assert.equal(old.supersededById, revised.memory.id, "the old fact points at the one that replaced it");
  assert.equal(old.content, "Akash wants coding work run with Copilot.");
  assert.equal((await remember(node, roomId, "Akash wants coding work run with Claude Code.", { key: "coding agent" })).status, "same");
  assert.equal(await h.prisma.nodeMemory.count({ where: { nodeId: node.id } }), 2);

  // Scopes: the owner's facts reach every node of theirs; a room's only that room.
  const other = await nodeOf(akash, "researcher");
  await remember(node, roomId, "Akash's time zone is IST.", { key: "time zone", scope: "owner" });
  await remember(node, roomId, "In this chat, answer in German.", { scope: "room" });
  const elsewhere = await memoriesForTurn(h.prisma, { node: other.node, roomId: other.roomId, projectId: null, words: "what time is it?", config: DEFAULT_CONTEXT_CONFIG.memory });
  assert.deepEqual(elsewhere.lines, ["Akash's time zone is IST. (key “time zone”)"]);
  const here = await memoriesForTurn(h.prisma, { node, roomId, projectId: null, words: "hello", config: DEFAULT_CONTEXT_CONFIG.memory });
  assert.ok(here.lines.includes("In this chat, answer in German. (this conversation)"), here.lines.join("\n"));
  assert.ok(!here.lines.some((line) => line.includes("Copilot")), "a replaced fact is never given");
});

test("no node changes a pinned memory, and an edit its owner made after the turn began wins", async () => {
  const akash = await owner();
  const { node, roomId } = await nodeOf(akash);
  const url = `/api/node/nodes/${node.id}/memory`;
  const pinned = json(await akash.inject({ method: "POST", url, payload: { content: "Reports in bullet points.", key: "report format", pinned: true } })).memory;
  assert.equal(pinned.pinned, true);
  await assert.rejects(remember(node, roomId, "Reports as a table.", { key: "report format" }), refused(/pinned/));

  const began = new Date(Date.now() - 1_000);
  const unpinned = json(await akash.inject({ method: "PATCH", url: `${url}/${pinned.id}`, payload: { pinned: false } })).memory;
  assert.equal(unpinned.pinned, false);
  const edited = json(await akash.inject({ method: "PATCH", url: `${url}/${pinned.id}`, payload: { content: "Reports as short paragraphs." } })).memory;
  assert.notEqual(edited.id, pinned.id, "new words are a new revision");
  await assert.rejects(remember(node, roomId, "Reports as a table.", { key: "report format", since: began }), refused(/changed this memory themselves/));
  const later = await remember(node, roomId, "Reports as a table.", { key: "report format" });
  assert.equal(later.status, "revised", "a turn that began after the owner's edit may change it");

  // The owner's own edits change a pinned memory, which stays pinned.
  json(await akash.inject({ method: "PATCH", url: `${url}/${later.memory.id}`, payload: { pinned: true } }));
  const owners = json(await akash.inject({ method: "PATCH", url: `${url}/${later.memory.id}`, payload: { content: "Reports as a table, newest first." } })).memory;
  assert.deepEqual([owners.pinned, owners.key, owners.source], [true, "report format", "owner"]);
});

test("past 200 live memories the oldest unused are archived, never deleted; pinned and used ones stay", async () => {
  const akash = await owner();
  const { node, roomId } = await nodeOf(akash);
  const start = Date.now() - 300 * 86_400_000;
  await h.prisma.nodeMemory.createMany({
    data: Array.from({ length: MAX_MEMORIES }, (_, index) => ({
      userId: akash.id,
      nodeId: node.id,
      content: `Fact number ${index}.`,
      createdAt: new Date(start + index * 60_000),
      updatedAt: new Date(start + index * 60_000),
      pinned: index === 0,
      lastUsedAt: index === 1 ? new Date() : null,
    })),
  });
  const saved = await remember(node, roomId, "A brand new fact.");
  assert.equal(saved.archived, 1);
  const archived = await h.prisma.nodeMemory.findMany({ where: { nodeId: node.id, archivedAt: { not: null } } });
  assert.deepEqual(archived.map((row) => row.content), ["Fact number 2."], "the oldest unused one that is not pinned");
  assert.equal(await h.prisma.nodeMemory.count({ where: { nodeId: node.id } }), MAX_MEMORIES + 1, "nothing deleted");
  assert.equal(await h.prisma.nodeMemory.count({ where: { nodeId: node.id, archivedAt: null, supersededById: null } }), MAX_MEMORIES);

  // The owner brings it back: it counts as used, and the next oldest unused goes instead.
  const restored = json(await akash.inject({ method: "PATCH", url: `/api/node/nodes/${node.id}/memory/${archived[0]!.id}`, payload: { archived: false } })).memory;
  assert.equal(restored.archived, false);
  const now = await h.prisma.nodeMemory.findMany({ where: { nodeId: node.id, archivedAt: { not: null } } });
  assert.deepEqual(now.map((row) => row.content), ["Fact number 3."]);
  const listed = json(await akash.inject({ method: "GET", url: `/api/node/nodes/${node.id}/memory` })).memories as Array<{ content: string; archived: boolean; pinned: boolean }>;
  assert.equal(listed.length, MAX_MEMORIES + 1);
  assert.deepEqual(listed[0]!.pinned && listed[0]!.content, "Fact number 0.", "pinned first");
  assert.equal(listed.at(-1)!.content, "Fact number 3.");
  assert.equal(listed.at(-1)!.archived, true, "archived last");
});

test("a turn gets its pinned memories and the owner's preferences, then those its words call for: an old one among 60", async () => {
  const akash = await owner();
  const { node, roomId } = await nodeOf(akash);
  const day = 86_400_000;
  const topics = ["the garden", "the quarterly report", "the gym schedule", "the team offsite", "the newsletter", "the car service", "the dentist", "the book club", "the tax filing", "the kitchen remodel"];
  const rows = [
    { content: "Akash flies Lufthansa and wants an aisle seat on long flights.", at: 400 },
    ...Array.from({ length: 57 }, (_, index) => ({ content: `About ${topics[index % topics.length]}: note ${index} that Akash asked to keep, with a few more words.`, at: 57 - index })),
  ];
  await h.prisma.nodeMemory.createMany({ data: rows.map((row) => ({ userId: akash.id, nodeId: node.id, content: row.content, createdAt: new Date(Date.now() - row.at * day), updatedAt: new Date(Date.now() - row.at * day) })) });
  await h.prisma.nodeMemory.create({ data: { userId: akash.id, nodeId: node.id, content: "Never book anything before 9am.", pinned: true, createdAt: new Date(Date.now() - 300 * day), updatedAt: new Date(Date.now() - 300 * day) } });
  await h.prisma.nodeMemory.create({ data: { userId: akash.id, nodeId: node.id, content: "Akash's name is pronounced AH-kaash.", scope: "owner", key: "pronunciation" } });
  assert.equal(await h.prisma.nodeMemory.count({ where: { nodeId: node.id } }), 60);

  const config = { ...DEFAULT_CONTEXT_CONFIG.memory, budgetTokens: 150 };
  const got = await memoriesForTurn(h.prisma, { node, roomId, projectId: null, words: "Book me a flight to Munich next Tuesday, aisle if you can", config });
  assert.deepEqual(got.selected.slice(0, 2).map((row) => row.why), ["pinned", "owner"]);
  assert.equal(got.lines[0], "Never book anything before 9am. (pinned)");
  assert.equal(got.lines[2], "Akash flies Lufthansa and wants an aisle seat on long flights.", got.lines.join("\n"));
  assert.equal(got.selected[2]!.why, "relevant");
  assert.ok(got.lines.reduce((sum, line) => sum + line.length + 3, 0) <= config.budgetTokens * 4);
  assert.ok(got.left > 40, "the rest stay out");
  const used = await h.prisma.nodeMemory.findMany({ where: { nodeId: node.id, lastUsedAt: { not: null } } });
  assert.deepEqual(new Set(used.map((row) => row.id)), new Set(got.selected.map((row) => row.id)), "what was given is marked used");

  // Without its words the old fact stays out, and the newest fill the room.
  const plain = await memoriesForTurn(h.prisma, { node, roomId, projectId: null, words: "how is the week looking?", config });
  assert.ok(!plain.lines.some((line) => line.includes("Lufthansa")));
  assert.match(plain.lines[2]!, /note 56/, "newest first among the rest");
});

test("the owner's memory routes: list with scope, key, pin and archive; history; edit; delete with its revisions", async () => {
  const akash = await owner();
  const ben = await owner("Ben");
  const { node, roomId } = await nodeOf(akash);
  const url = `/api/node/nodes/${node.id}/memory`;
  const first = await akash.inject({ method: "POST", url, payload: { content: "Ship on Thursdays.", key: "release day" } });
  assert.equal(first.statusCode, 201, first.body);
  const second = json(await akash.inject({ method: "POST", url, payload: { content: "Ship on Wednesdays.", key: "release day" } }));
  assert.equal(second.replaced, json(first).memory.id, "the same key replaces it");

  const listed = json(await akash.inject({ method: "GET", url })).memories;
  assert.equal(listed.length, 1);
  const view = listed[0];
  assert.deepEqual(
    { content: view.content, key: view.key, scope: view.scope, pinned: view.pinned, archived: view.archived, source: view.source },
    { content: "Ship on Wednesdays.", key: "release day", scope: "node", pinned: false, archived: false, source: "owner" },
  );
  const history = json(await akash.inject({ method: "GET", url: `${url}?history=1` })).memories as Array<{ id: string; supersededById: string | null }>;
  assert.equal(history.length, 2);
  assert.equal(history.find((row) => row.supersededById)?.supersededById, view.id);

  const room = json(await akash.inject({ method: "PATCH", url: `${url}/${view.id}`, payload: { scope: "room", scopeId: roomId } })).memory;
  assert.deepEqual([room.scope, room.scopeId, typeof room.scopeTitle], ["room", roomId, "string"]);
  assert.equal((await akash.inject({ method: "PATCH", url: `${url}/${view.id}`, payload: { scope: "project", scopeId: "00000000-0000-4000-8000-000000000000" } })).statusCode, 404);
  assert.equal((await akash.inject({ method: "PATCH", url: `${url}/${view.id}`, payload: { scopeId: roomId } })).statusCode, 400, "a scope comes with its id");
  assert.equal((await akash.inject({ method: "PATCH", url: `${url}/${view.id}`, payload: {} })).statusCode, 400);
  const cleared = json(await akash.inject({ method: "PATCH", url: `${url}/${view.id}`, payload: { key: null, scope: "node" } })).memory;
  assert.deepEqual([cleared.key, cleared.scope, cleared.scopeId], [null, "node", null]);
  assert.equal((await akash.inject({ method: "PATCH", url: `${url}/${history.find((row) => row.supersededById)!.id}`, payload: { pinned: true } })).statusCode, 409, "a replaced revision is history");

  assert.equal((await akash.inject({ method: "POST", url, payload: { content: " " } })).statusCode, 400);
  assert.equal((await akash.inject({ method: "PATCH", url: `${url}/00000000-0000-4000-8000-000000000001`, payload: { pinned: true } })).statusCode, 404);
  const bens = await h.prisma.project.create({ data: { userId: ben.id, name: "Ben's launch" } });
  assert.equal((await akash.inject({ method: "PATCH", url: `${url}/${view.id}`, payload: { scope: "project", scopeId: bens.id } })).statusCode, 404, "not someone else's project");
  for (const request of [
    { method: "GET" as const, url },
    { method: "POST" as const, url, payload: { content: "Ben was here." } },
    { method: "PATCH" as const, url: `${url}/${view.id}`, payload: { pinned: true } },
    { method: "DELETE" as const, url: `${url}/${view.id}` },
  ]) {
    assert.equal((await ben.inject(request)).statusCode, 404, `${request.method}: not someone else's node`);
  }
  assert.equal((await akash.inject({ method: "DELETE", url: `${url}/${view.id}` })).statusCode, 204);
  assert.deepEqual(json(await akash.inject({ method: "GET", url: `${url}?history=1` })).memories, [], "with its earlier revisions");
  const rows: NodeMemory[] = await h.prisma.nodeMemory.findMany({ where: { nodeId: node.id } });
  assert.equal(rows.length, 0);
});
