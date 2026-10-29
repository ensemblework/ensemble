/**
 * Ensemble Node across its owner's spaces, end to end against an in-memory database with the model
 * scripted: parity with the assistant (every tool, playbooks, personal skills, write policy, Apply and
 * Undo); a delegated identity that acts with the owner's current role in each space (writes where they
 * edit, reads only where they view, the space owner's connected apps out of reach); access checked
 * again on every call and every Apply, and results from a lost space leaving later turns; only the home
 * space where other people read; node_overview across three spaces; browser-only routes refusing it.
 */
import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { randomBytes } from "node:crypto";
import type { LightMyRequestResponse } from "fastify";
import { OPTIONAL_MODULES, serializeModules } from "@ensemble/shared-types";
import { createHttpHarness, type HttpUser } from "../test/http.js";
import type { RuntimeTurn } from "../lib/model-turn.js";

const h = await createHttpHarness();
const { setAskRuntimeStreamForTests } = await import("../lib/model-turn.js");
const { settleTurns } = await import("./queue.js");
const { loadSettings, saveSettings } = await import("../lib/settings.js");
const { TOOL_NAMES, chatToolSpecs } = await import("../assistant/registry.js");
const { nodeSpaceGateway } = await import("./spaces.js");
const { toolsForTurn } = await import("../assistant/apps.js");
const { NODE_REPLACED_TOOLS } = await import("./brain.js");
const { createSpaceUser, SPACE_COOKIE } = await import("../spaces/store.js");
const { nodeRequestHeaders } = await import("../lib/auth.js");
after(() => h.close());

type Call = { name: string; arguments?: Record<string, unknown>; raw?: string };
type Step = { calls?: Call[]; text?: string };
/** One model request: the node, its instructions, the room transcript, earlier turns, and this step's tool results. */
type Turn = { slug: string; system: string; transcript: string; history: string[]; tools: string[]; specs: Array<{ name: string; parameters: any }>; results: any[] };
let script: (turn: Turn, step: number) => Step | Promise<Step> = () => ({ text: "(no reply)" });
const seen: Turn[] = [];

const textOf = (content: unknown): string =>
  Array.isArray(content) ? content.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "")).join("\n") : String(content ?? "");

setAskRuntimeStreamForTests(async (args) => {
  const messages = args.messages as Array<{ role?: string; content?: unknown }>;
  const system = messages.filter((row) => row.role === "system").map((row) => textOf(row.content)).join("\n");
  const slug = /You are .+? \(@([a-z0-9-]+)\), (?:an Ensemble Node|a temporary helper)/.exec(system)?.[1] ?? "?";
  const asked = messages.map((row) => row.role).lastIndexOf("user");
  const after = messages.slice(asked + 1);
  const step = after.filter((row) => row.role === "assistant").length;
  const specs = ((args.chatTools ?? []) as Array<{ function: { name: string; parameters: unknown } }>).map((spec) => ({ name: spec.function.name, parameters: spec.function.parameters }));
  const turn: Turn = {
    slug,
    system,
    transcript: textOf(messages[asked]?.content),
    history: messages.slice(0, asked).filter((row) => row.role !== "system").map((row) => textOf(row.content)),
    tools: specs.map((spec) => spec.name),
    specs,
    results: after.filter((row) => row.role === "tool").map((row) => JSON.parse(textOf(row.content))),
  };
  if (step === 0) seen.push(turn);
  const planned = await script(turn, step);
  const calls = planned.calls ?? [];
  const text = calls.length ? "" : (planned.text ?? "(no reply)");
  const reply: RuntimeTurn = {
    text,
    toolCalls: calls.map((call, index) => ({ id: `call-${randomBytes(4).toString("hex")}-${index}`, name: call.name, arguments: call.raw ?? JSON.stringify(call.arguments ?? {}) })),
    model: "test-model",
    credits: 0,
    tokensIn: 10,
    tokensOut: 5,
    reasoning: "",
    raw: {},
    finishReason: "stop",
    cutOff: false,
  };
  if (text) args.onDelta?.(text);
  return reply;
});

afterEach(async () => {
  await settleTurns();
  seen.length = 0;
  script = () => ({ text: "(no reply)" });
});

const MODULES = serializeModules(OPTIONAL_MODULES);
const json = (response: LightMyRequestResponse) => response.json() as any;

async function person(name: string): Promise<HttpUser> {
  const user = await h.asUser();
  await h.prisma.user.update({ where: { id: user.id }, data: { name, emailVerifiedAt: new Date(), onboardingRole: "student" } });
  return user;
}

/** Another space `user` owns, with every module on. */
async function spaceOf(user: HttpUser, name: string): Promise<string> {
  const id = await createSpaceUser(h.prisma, user.id, { name, icon: null });
  await h.prisma.user.update({ where: { id }, data: { moduleSet: MODULES } });
  return id;
}

async function share(owner: HttpUser, spaceId: string, member: HttpUser, role: "editor" | "viewer") {
  const response = await owner.inject({ method: "POST", url: `/api/sharing/spaces/${spaceId}/members`, payload: { personId: member.id, role } });
  assert.equal(response.statusCode, 201, response.body);
}

async function createNode(user: HttpUser, templateId = "assistant") {
  const response = await user.inject({ method: "POST", url: "/api/node/nodes", payload: { templateId } });
  assert.equal(response.statusCode, 201, response.body);
  return json(response) as { node: { id: string; slug: string }; room: { id: string } };
}

async function say(user: HttpUser, roomId: string, body: string) {
  const response = await user.inject({ method: "POST", url: `/api/node/rooms/${roomId}/messages`, payload: { body } });
  assert.equal(response.statusCode, 201, response.body);
  await settleTurns();
}

async function read(user: HttpUser, roomId: string) {
  const response = await user.inject({ method: "GET", url: `/api/node/rooms/${roomId}/messages` });
  assert.equal(response.statusCode, 200, response.body);
  return json(response).messages as Array<{ id: string; kind: string; body: string; authorNodeId: string | null; data: any }>;
}

type Receipt = { name: string; state: string; error?: string; summary?: string; input?: Record<string, unknown>; space?: { id: string; name: string }; refs?: Array<{ id: string; label: string }> };

/** The tool calls on the node's latest reply in a room's shared thread. */
async function receipts(nodeId: string, roomId: string): Promise<Receipt[]> {
  const member = await h.prisma.nodeRoomMember.findFirstOrThrow({ where: { nodeId, roomId } });
  const reply = await h.prisma.assistantMessage.findFirstOrThrow({ where: { conversationId: member.conversationId!, role: "assistant" }, orderBy: { createdAt: "desc" } });
  return reply.toolCalls as Receipt[];
}

const reminder = (userId: string, title: string, dueDate: string) =>
  h.prisma.reminder.create({ data: { userId, title, titleContent: {}, dueDate, timeZone: "UTC", actionTokenHash: randomBytes(16).toString("hex") } });

/** A request a node makes for its owner in one space, through the HTTP layer like any other. */
const delegated = (request: { method: "GET" | "POST" | "PATCH" | "DELETE"; url: string; payload?: object }, headers: Record<string, string>) => h.app.inject({ ...request, headers });

test("parity: a node can call every assistant tool but the two its session tools replace, and each Hub tool takes a space", async () => {
  const mira = await person("Mira");
  const { node, room } = await createNode(mira);
  const assistant = await toolsForTurn({ app: h.app, prisma: h.prisma, userId: mira.id, actor: "agent", settings: await loadSettings(h.prisma, mira.id), modules: MODULES });
  const names = [...new Set([...TOOL_NAMES, ...assistant.map((tool) => tool.name)])];
  for (const replaced of NODE_REPLACED_TOOLS) assert.ok(TOOL_NAMES.includes(replaced), `${replaced} is still an assistant tool`);

  // Arguments that are not JSON: a tool the turn has refuses them before running; one it lacks is unknown.
  const toolsets = process.env.ENSEMBLE_ASSISTANT_TOOLSETS;
  process.env.ENSEMBLE_ASSISTANT_TOOLSETS = "off";
  try {
    script = (_turn, step) => (step === 0 ? { calls: names.map((name) => ({ name, raw: "{" })) } : { text: "Checked." });
    await say(mira, room.id, "check every tool you have");
  } finally {
    if (toolsets === undefined) delete process.env.ENSEMBLE_ASSISTANT_TOOLSETS;
    else process.env.ENSEMBLE_ASSISTANT_TOOLSETS = toolsets;
  }
  const calls = await receipts(node.id, room.id);
  assert.equal(calls.length, names.length);
  assert.ok(calls.every((call) => call.state === "failed"), "nothing ran on arguments that are not JSON");
  const missing = calls.filter((call) => /^There is no tool called/.test(call.error ?? "")).map((call) => call.name);
  assert.deepEqual(missing.sort(), [...NODE_REPLACED_TOOLS].sort(), "only the tools the session tools replace are missing");

  // Every Hub tool the turn has takes a space; the node's own tools do not.
  const wrapped = nodeSpaceGateway(h.app, { id: node.id, userId: mira.id, spaceId: null }).wrap(assistant);
  for (const spec of chatToolSpecs(wrapped) as Array<{ function: { name: string; parameters: any } }>) {
    assert.equal(spec.function.parameters.properties?.space?.type, "string", `${spec.function.name} takes a space`);
  }
  const shown = seen[0]!.specs;
  const hub = shown.filter((spec) => spec.name.startsWith("hub_"));
  assert.ok(hub.length > 50, "with toolsets off the model sees them");
  for (const spec of hub) assert.equal(spec.parameters.properties?.space?.type, "string", `${spec.name} takes a space`);
  for (const spec of shown.filter((row) => row.name.startsWith("node_"))) assert.equal(spec.parameters.properties?.space, undefined, `${spec.name} is the node's own`);
  assert.ok(shown.some((spec) => spec.name === "node_overview"), "the overview is a node tool");
  assert.match(seen[0]!.system, /Spaces: you act for Mira in every Ensemble space Mira can open/);
  assert.match(seen[0]!.system, /- “Mira's space” \[[^\]]+\]: Mira's own \(the default\)/);
  assert.doesNotMatch(seen[0]!.system, /Only this space is reachable/);
});

test("playbooks, personal skills, the write policy, Apply and Undo work for a node as for the assistant, attributed to the node", async () => {
  const mira = await person("Mira");
  const { node, room } = await createNode(mira);
  const skill = await mira.inject({ method: "POST", url: "/api/skills", payload: { name: "Release notes style", description: "Short bullet points, newest first." } });
  assert.equal(skill.statusCode, 201, skill.body);
  await saveSettings(h.prisma, mira.id, { assistant: { writePolicy: "preview" } });
  script = (turn, step) =>
    turn.transcript.includes("Your owner approved")
      ? { text: "(no reply)" }
      : step === 0
        ? { calls: [{ name: "hub_create_tasks", arguments: { tasks: [{ title: "Draw the release flow" }] } }] }
        : { text: "Ready to add “Draw the release flow”." };
  await say(mira, room.id, "add a task to draw a diagram of the release flow");

  const turn = seen[0]!;
  assert.match(turn.transcript, /<guide name="Diagrams and flowcharts">/, "the message's playbooks are routed as for the assistant");
  assert.ok(turn.tools.includes("hub_create_diagram"), "and bring their tools");
  assert.match(turn.system, /Release notes style \([0-9a-f-]{36}\): Short bullet points/, "enabled personal skills are in the instructions");
  assert.equal(await h.prisma.task.count({ where: { userId: mira.id, title: "Draw the release flow" } }), 0, "under preview nothing changes before Apply");
  const [held] = await receipts(node.id, room.id);
  assert.equal(held!.state, "awaiting_approval");
  assert.deepEqual(held!.space, { id: mira.id, name: "Mira's space" }, "the receipt records its space");

  const card = (await read(mira, room.id)).find((row) => row.kind === "approval" && row.data.type === "tools")!;
  assert.equal(card.data.calls[0].input.space, mira.id);
  assert.match(card.data.calls[0].summary, /^Add 1 task\(s\):\n- Draw the release flow$/, "the home space is not named");
  const approved = await mira.inject({ method: "POST", url: `/api/node/approvals/${card.id}`, payload: { decision: "approve" } });
  assert.equal(approved.statusCode, 200, approved.body);
  assert.equal(json(approved).message.data.status, "applied", JSON.stringify(json(approved).message.data));
  await settleTurns();

  const task = await h.prisma.task.findFirstOrThrow({ where: { userId: mira.id, title: "Draw the release flow" } });
  const entry = await h.prisma.undoEntry.findFirstOrThrow({ where: { userId: mira.id }, orderBy: { seq: "desc" } });
  assert.equal(entry.actor, "agent");
  assert.equal(entry.actorAccountId, null, "Mira's own space: her own undo history");
  assert.equal(entry.source, `node:${node.id}`, "the entry names the node that acted for her");
  const undone = await mira.inject({ method: "POST", url: "/api/undo", payload: {} });
  assert.equal(undone.statusCode, 200, undone.body);
  assert.ok((await h.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).deletedAt, "Mira's Undo takes it back");
});

test("in a space its owner edits as a member, a node creates a task there, with Undo in that space for its owner", async () => {
  const akash = await person("Akash");
  const ben = await person("Ben Ito");
  const fieldnote = await spaceOf(ben, "Fieldnote");
  await share(ben, fieldnote, akash, "editor");
  const project = await h.prisma.project.create({ data: { userId: fieldnote, name: "CSV export" } });
  const { node, room } = await createNode(akash);
  script = (_turn, step) =>
    step === 0
      ? {
          calls: [
            { name: "hub_create_tasks", arguments: { tasks: [{ title: "Write the CSV export", owner: "me" }], space: "fieldnote" } },
            { name: "hub_update_project", arguments: { projectId: project.id, summary: "Exports the board as CSV.", space: fieldnote } },
          ],
        }
      : { text: "Added it in Fieldnote." };
  await say(akash, room.id, "add a task in Fieldnote for me to write the CSV export, and describe the project");

  assert.match(seen[0]!.system, /- “Fieldnote” \[[^\]]+\]: Ben Ito's, shared with Akash: can edit/);
  const [create, update] = await receipts(node.id, room.id);
  assert.equal(create!.state, "ok", create!.error);
  assert.deepEqual(create!.space, { id: fieldnote, name: "Fieldnote" }, "a name finds the space, whatever its case");
  assert.equal(create!.input?.space, fieldnote);
  assert.match(create!.summary!, /^In “Fieldnote”: Added “Write the CSV export”/);
  const task = await h.prisma.task.findFirstOrThrow({ where: { title: "Write the CSV export" } });
  assert.equal(task.userId, fieldnote, "the task is in Ben's space");
  assert.equal(task.assigneeAccountId, akash.id, "and with Akash, the person the node acts for");
  assert.equal(update!.state, "ok", update!.error);
  assert.equal((await h.prisma.project.findUniqueOrThrow({ where: { id: project.id } })).summary, "Exports the board as CSV.", "a route-backed tool goes through the route as Akash, a member");

  const entry = await h.prisma.undoEntry.findFirstOrThrow({ where: { userId: fieldnote }, orderBy: { seq: "desc" } });
  assert.equal(entry.actorAccountId, akash.id, "the undo entry is Akash's, in Fieldnote");
  assert.equal(entry.source, `node:${node.id}`);
  assert.equal(await h.prisma.undoEntry.count({ where: { userId: akash.id } }), 0, "nothing lands in Akash's own space");
  const benUndo = await h.app.inject({ method: "POST", url: "/api/undo", headers: { cookie: `${ben.cookie}; ${SPACE_COOKIE}=${fieldnote}` }, payload: {} });
  assert.notEqual(benUndo.statusCode, 200, "Ben's undo history does not hold Akash's change");
  const undone = await h.app.inject({ method: "POST", url: "/api/undo", headers: { cookie: `${akash.cookie}; ${SPACE_COOKIE}=${fieldnote}` }, payload: {} });
  assert.equal(undone.statusCode, 200, undone.body);
  assert.ok((await h.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).deletedAt, "Akash's Undo in Fieldnote takes it back");
});

test("a call that names no space acts in the node's own space when it has one, else the owner's account", async () => {
  const akash = await person("Akash");
  const launch = await spaceOf(akash, "Launch");
  const { node, room } = await createNode(akash);
  await h.prisma.nodeAgent.update({ where: { id: node.id }, data: { spaceId: launch } });
  script = (_turn, step) => (step === 0 ? { calls: [{ name: "hub_create_tasks", arguments: { tasks: [{ title: "Write the launch post" }] } }] } : { text: "Added." });
  await say(akash, room.id, "add a task to write the launch post");
  assert.match(seen[0]!.system, /Without it a call acts in “Launch”/);
  assert.match(seen[0]!.system, /- “Launch” \[[^\]]+\]: Akash's own \(the default\)/);
  const [call] = await receipts(node.id, room.id);
  assert.deepEqual(call!.space, { id: launch, name: "Launch" });
  assert.match(call!.summary!, /^Added “Write the launch post”/, "the default space is not named in the summary");
  assert.equal((await h.prisma.task.findFirstOrThrow({ where: { title: "Write the launch post" } })).userId, launch);

  // A node space the owner can no longer open (deleted) falls back to their account.
  await h.prisma.user.delete({ where: { id: launch } });
  seen.length = 0;
  script = (_turn, step) => (step === 0 ? { calls: [{ name: "hub_create_tasks", arguments: { tasks: [{ title: "Write the launch email" }] } }] } : { text: "Added." });
  await say(akash, room.id, "and the launch email");
  assert.equal((await h.prisma.task.findFirstOrThrow({ where: { title: "Write the launch email" } })).userId, akash.id);
});

test("where its owner can only view, a node reads, and every write is refused, by tools and routes alike", async () => {
  const akash = await person("Akash");
  const ben = await person("Ben Ito");
  const board = await spaceOf(ben, "Board room");
  await share(ben, board, akash, "viewer");
  await h.prisma.task.create({ data: { userId: board, title: "Plan the offsite", owner: "me", status: "todo" } });
  const project = await h.prisma.project.create({ data: { userId: board, name: "Offsite" } });
  await saveSettings(h.prisma, akash.id, { assistant: { writePolicy: "preview" } });
  const { node, room } = await createNode(akash);
  script = (_turn, step) =>
    step === 0
      ? {
          calls: [
            { name: "hub_list_tasks", arguments: { space: "Board room" } },
            { name: "hub_create_tasks", arguments: { tasks: [{ title: "Book the venue" }], space: "Board room" } },
            { name: "hub_update_project", arguments: { projectId: project.id, summary: "Two days.", space: board } },
          ],
        }
      : { text: "I can only read Board room." };
  await say(akash, room.id, "what's on Ben's board room? add a venue task there");

  assert.match(seen[0]!.system, /- “Board room” \[[^\]]+\]: Ben Ito's, shared with Akash: view only/);
  const [list, create, update] = await receipts(node.id, room.id);
  assert.equal(list!.state, "ok", list!.error);
  assert.match(list!.summary!, /^In “Board room”: Listed 1 of 1 task/);
  assert.ok(list!.refs?.some((ref) => ref.label === "Plan the offsite"));
  for (const refused of [create!, update!]) {
    assert.equal(refused.state, "failed", `${refused.name} is refused, not held`);
    assert.match(refused.error!, /can only view “Board room”, so nothing there can be changed/);
  }
  assert.ok(!(await read(akash, room.id)).some((row) => row.kind === "approval"), "nothing waits for approval either");
  assert.equal(await h.prisma.task.count({ where: { userId: board, title: "Book the venue" } }), 0);

  const headers = nodeRequestHeaders({ accountId: akash.id, spaceId: board, nodeId: node.id });
  assert.equal((await delegated({ method: "GET", url: "/api/tasks" }, headers)).statusCode, 200, "the delegated identity reads as a viewer");
  const write = await delegated({ method: "POST", url: "/api/tasks", payload: { title: "Book the venue" } }, headers);
  assert.equal(write.statusCode, 403, write.body);
  assert.match(json(write).error, /You can view this space/);
});

test("a space owner's connected apps, reminders and syncs never reach a member's node", async () => {
  const akash = await person("Akash");
  const ben = await person("Ben Ito");
  const fieldnote = await spaceOf(ben, "Fieldnote");
  await share(ben, fieldnote, akash, "editor");
  await h.prisma.authToken.create({
    data: { userId: fieldnote, provider: "google", accessToken: "sealed-and-never-read", expiresAt: new Date("2100-01-01T00:00:00Z"), account: "ben@fieldnote.example", scopes: ["https://www.googleapis.com/auth/gmail.readonly"] },
  });
  await h.prisma.mcpConnection.create({ data: { userId: fieldnote, serverId: "custom-bens-notes", name: "Ben's notes server", url: "https://mcp.example.test/mcp", status: "connected" } });
  await reminder(fieldnote, "Ben's dentist", "2026-11-02");
  const { node, room } = await createNode(akash);
  script = (_turn, step) =>
    step === 0
      ? {
          calls: [
            { name: "hub_list_connections", arguments: { space: "Fieldnote" } },
            { name: "hub_list_app_relationships", arguments: { view: "sources", space: "Fieldnote" } },
            { name: "hub_fetch_now", arguments: { space: "Fieldnote" } },
            { name: "hub_list_reminders", arguments: { space: "Fieldnote" } },
            { name: "gmail_search", arguments: { query: "budget", space: "Fieldnote" } },
            { name: "hub_list_tasks", arguments: { space: "Fieldnote" } },
          ],
        }
      : { text: "Those are Ben's." };
  await say(akash, room.id, "what apps does Fieldnote have? search Ben's mail for the budget");

  const turn = seen[0]!;
  assert.ok(!turn.tools.some((name) => name.startsWith("gmail_") || name.startsWith("mcp_") || name.startsWith("apps_")), "none of Ben's app tools is offered");
  assert.doesNotMatch(turn.system, /ben@fieldnote|Ben's notes server|Gmail/);
  const [connections, relationships, fetch, reminders, gmail, tasks] = await receipts(node.id, room.id);
  assert.equal(connections!.state, "ok");
  assert.match(connections!.summary!, /^In “Fieldnote”: Connected apps belong to this space's owner and stay private/);
  for (const refused of [relationships!, fetch!, reminders!]) {
    assert.equal(refused.state, "failed", refused.name);
    assert.match(refused.error!, /stays private to Ben in “Fieldnote”/);
  }
  assert.match(gmail!.error!, /^There is no tool called gmail_search/);
  assert.equal(tasks!.state, "ok", "the space's own work is reachable");
});

test("a membership removed during a turn stops the next call in that space, and that space's results leave later turns", async () => {
  const akash = await person("Akash");
  const ben = await person("Ben Ito");
  const fieldnote = await spaceOf(ben, "Fieldnote");
  await share(ben, fieldnote, akash, "editor");
  await h.prisma.task.create({ data: { userId: fieldnote, title: "Zephyr launch checklist", owner: "me", status: "todo" } });
  const { node, room } = await createNode(akash);
  script = async (turn, step) => {
    if (step === 0) return { calls: [{ name: "hub_list_tasks", arguments: { space: "Fieldnote" } }] };
    if (step === 1) {
      assert.equal(turn.results[0].space, "Fieldnote", "a result says which space it came from");
      // Ben removes Akash while the turn is going on.
      const removed = await ben.inject({ method: "DELETE", url: `/api/sharing/spaces/${fieldnote}/members/${akash.id}` });
      assert.equal(removed.statusCode, 204, removed.body);
      return { calls: [{ name: "hub_list_tasks", arguments: { space: fieldnote } }] };
    }
    return { text: "Fieldnote has the Zephyr launch checklist." };
  };
  await say(akash, room.id, "what's open in Fieldnote?");
  const [first, second] = await receipts(node.id, room.id);
  assert.equal(first!.state, "ok");
  assert.ok(first!.refs?.some((ref) => ref.label === "Zephyr launch checklist"));
  assert.equal(second!.state, "failed", "the next call there is refused");
  assert.match(second!.error!, /Your owner cannot open a space/);

  seen.length = 0;
  script = () => ({ text: "(no reply)" });
  await say(akash, room.id, "anything else?");
  const later = seen[0]!;
  assert.ok(later.history.length > 0);
  assert.ok(!later.history.some((text) => text.includes("Zephyr")), "the answer built on Fieldnote is gone from history");
  assert.ok(later.history.some((text) => text.includes("An earlier answer is left out here")));
  assert.doesNotMatch(later.system, /Fieldnote/, "and the space is no longer listed");
});

test("Apply checks the space again: a held write is refused once its owner can only view there, and lands there when they can edit", async () => {
  const akash = await person("Akash");
  const ben = await person("Ben Ito");
  const fieldnote = await spaceOf(ben, "Fieldnote");
  await share(ben, fieldnote, akash, "editor");
  await saveSettings(h.prisma, akash.id, { assistant: { writePolicy: "preview" } });
  const { room } = await createNode(akash);
  script = (turn, step) =>
    turn.transcript.includes("Your owner approved")
      ? { text: "(no reply)" }
      : step === 0
        ? { calls: [{ name: "hub_create_tasks", arguments: { tasks: [{ title: "Import the March data" }], space: "Fieldnote" } }] }
        : { text: "Ready to add it in Fieldnote." };
  await say(akash, room.id, "add a task in Fieldnote to import the March data");
  const card = (await read(akash, room.id)).find((row) => row.kind === "approval" && row.data.type === "tools")!;
  assert.match(card.data.calls[0].summary, /^In “Fieldnote”: Add 1 task\(s\):/, "the card says where");

  assert.equal((await ben.inject({ method: "PATCH", url: `/api/sharing/spaces/${fieldnote}/members/${akash.id}`, payload: { role: "viewer" } })).statusCode, 200);
  const refused = await akash.inject({ method: "POST", url: `/api/node/approvals/${card.id}`, payload: { decision: "approve" } });
  assert.equal(refused.statusCode, 200, refused.body);
  assert.equal(json(refused).message.data.status, "pending", "nothing ran, so the card waits");
  assert.match(json(refused).message.data.error, /can only view “Fieldnote”/);
  assert.equal(await h.prisma.task.count({ where: { title: "Import the March data" } }), 0);

  assert.equal((await ben.inject({ method: "PATCH", url: `/api/sharing/spaces/${fieldnote}/members/${akash.id}`, payload: { role: "editor" } })).statusCode, 200);
  const applied = await akash.inject({ method: "POST", url: `/api/node/approvals/${card.id}`, payload: { decision: "approve" } });
  assert.equal(json(applied).message.data.status, "applied", applied.body);
  await settleTurns();
  const task = await h.prisma.task.findFirstOrThrow({ where: { title: "Import the March data" } });
  assert.equal(task.userId, fieldnote);
  const entry = await h.prisma.undoEntry.findFirstOrThrow({ where: { userId: fieldnote, actorAccountId: akash.id } });
  assert.match(entry.label, /Import the March data/, "Apply's undo entry is in Fieldnote, for Akash");
});

test("where other people read, a node reaches only its home space, and its overview stays private", async () => {
  const akash = await person("Akash");
  const ben = await person("Ben Ito");
  const fieldnote = await spaceOf(ben, "Fieldnote");
  await share(ben, fieldnote, akash, "editor");
  const { node } = await createNode(akash);
  const { node: bensNode } = await createNode(ben);
  const made = await akash.inject({ method: "POST", url: "/api/node/rooms", payload: { title: "Launch room", nodeIds: [node.id], invite: [ben.email] } });
  assert.equal(made.statusCode, 201, made.body);
  const group = json(made).room as { id: string };
  const invite = json(await ben.inject({ method: "GET", url: "/api/node/invites" })).invites[0];
  assert.equal((await ben.inject({ method: "POST", url: `/api/node/invites/${invite.id}/accept`, payload: { nodeIds: [bensNode.id] } })).statusCode, 201);

  script = (turn, step) =>
    turn.slug !== node.slug
      ? { text: "(no reply)" }
      : step === 0
        ? { calls: [{ name: "hub_list_tasks", arguments: { space: "Fieldnote" } }, { name: "hub_list_tasks", arguments: {} }, { name: "node_overview", arguments: {} }] }
        : { text: "I can look in Akash's own space here." };
  await say(ben, group.id, `@${node.slug} what is Akash working on in Fieldnote?`);
  const turn = seen.find((row) => row.slug === node.slug)!;
  assert.match(turn.system, /Spaces: only “Akash's space” is reachable in this conversation/);
  assert.doesNotMatch(turn.system, /Fieldnote/);
  const [elsewhere, home, overview] = await receipts(node.id, group.id);
  assert.match(elsewhere!.error!, /Only “Akash's space” is reachable here/);
  assert.equal(home!.state, "ok", "the home space still works");
  assert.match(overview!.error!, /listed only in a chat with just your owner/);
});

test("node_overview lists its owner's tasks, what is due and runs going on across three spaces, by space name", async () => {
  const akash = await person("Akash");
  const ben = await person("Ben Ito");
  const launch = await spaceOf(akash, "Launch");
  const fieldnote = await spaceOf(ben, "Fieldnote");
  await share(ben, fieldnote, akash, "editor");
  const tomorrow = new Date(Date.now() + 86_400_000);
  const task = (userId: string, title: string, extra: Record<string, unknown> = {}) => h.prisma.task.create({ data: { userId, title, owner: "me", status: "todo", ...extra } });
  await task(akash.id, "Reply to the auditors", { due: tomorrow });
  await task(launch, "Ship the beta", { status: "in_progress" });
  await task(launch, "Let the agent tidy up", { owner: "agent" });
  await task(launch, "Old launch note", { status: "done" });
  const csv = await task(fieldnote, "CSV export", { assigneeAccountId: akash.id });
  const bens = await task(fieldnote, "Ben's own review");
  await task(fieldnote, "Finished export", { assigneeAccountId: akash.id, status: "done" });
  await reminder(akash.id, "Renew the domain", tomorrow.toISOString().slice(0, 10));
  await reminder(fieldnote, "Ben's dentist", tomorrow.toISOString().slice(0, 10));
  const job = (userId: string, taskId: string, runnerAccountId: string | null) =>
    h.prisma.workspaceJob.create({ data: { userId, taskId, runnerAccountId, executionMode: "agent", model: "test-model", status: "running", provider: "claude-code" } });
  await job(fieldnote, csv.id, akash.id);
  await job(fieldnote, bens.id, null);

  const { node, room } = await createNode(akash);
  let data: any = null;
  script = (turn, step) => {
    if (step === 0) return { calls: [{ name: "node_overview", arguments: {} }] };
    data = turn.results[0].data;
    return { text: "Three spaces have your work." };
  };
  await say(akash, room.id, "what am I working on?");
  const [call] = await receipts(node.id, room.id);
  assert.equal(call!.state, "ok", call!.error);
  assert.equal(call!.space, undefined, "the node's own tool reads every space itself");
  assert.match(call!.summary!, /^3 open tasks, 2 due by \d{4}-\d{2}-\d{2} and 1 run going, in 3 of 3 spaces\.$/);
  assert.deepEqual(data.spaces.map((row: { name: string; role: string }) => `${row.name}:${row.role}`), ["Akash's space:owner", "Launch:owner", "Fieldnote:editor"]);
  assert.deepEqual(
    data.tasks.map((row: { title: string; space: string }) => `${row.title} @ ${row.space}`).sort(),
    ["CSV export @ Fieldnote", "Reply to the auditors @ Akash's space", "Ship the beta @ Launch"],
    "only open tasks that are Akash's: his own, and the one Ben gave him",
  );
  assert.deepEqual(data.due.map((row: { kind: string; title: string }) => `${row.kind}:${row.title}`).sort(), ["reminder:Renew the domain", "task:Reply to the auditors"], "Ben's reminder stays Ben's");
  assert.equal(data.runs.length, 1);
  assert.equal(data.runs[0].task, "CSV export");
  assert.equal(data.runs[0].space, "Fieldnote");
});

test("the delegated identity carries the owner's current access through routes, and never passes browser-only gates", async () => {
  const akash = await person("Akash");
  const ben = await person("Ben Ito");
  const fieldnote = await spaceOf(ben, "Fieldnote");
  const hidden = await spaceOf(ben, "Ben's private plans");
  await share(ben, fieldnote, akash, "editor");
  const { node } = await createNode(akash);
  const { node: bensNode } = await createNode(ben);
  const as = (spaceId: string, nodeId = node.id) => nodeRequestHeaders({ accountId: akash.id, spaceId, nodeId });

  const made = await delegated({ method: "POST", url: "/api/tasks", payload: { title: "From the node" } }, as(fieldnote));
  assert.equal(made.statusCode, 201, made.body);
  assert.equal((await h.prisma.task.findFirstOrThrow({ where: { title: "From the node" } })).userId, fieldnote);
  const ledger = await h.prisma.auditLedger.findFirstOrThrow({ where: { userId: fieldnote, action: "task.create" } });
  assert.deepEqual([(ledger.payload as any).byAccountId, (ledger.payload as any).byNodeId], [akash.id, node.id], "the ledger names the person and the node");
  const reminders = await delegated({ method: "GET", url: "/api/reminders" }, as(fieldnote));
  assert.equal(reminders.statusCode, 403, "Ben's private surfaces refuse it, as they refuse Akash");
  assert.match(json(reminders).error, /Only Ben can do this in their space/);
  const settings = await delegated({ method: "GET", url: "/api/settings" }, as(fieldnote));
  assert.equal(settings.statusCode, 200, "personal routes act on Akash's own account");

  // Browser-only gates refuse it, even in Akash's own space.
  const gates: Array<{ method: "GET" | "POST"; url: string; payload?: object }> = [
    { method: "GET", url: "/api/spaces" },
    { method: "POST", url: `/api/spaces/${fieldnote}/switch` },
    { method: "GET", url: "/api/sharing/overview" },
    { method: "POST", url: `/api/sharing/spaces/${akash.id}/members`, payload: { personId: ben.id, role: "viewer" } },
    { method: "POST", url: "/api/devices/pair" },
    { method: "POST", url: "/api/connect/token", payload: { name: "node key" } },
    { method: "POST", url: "/api/cli/auth/approve", payload: { code: "ABCD-EFGH" } },
    { method: "POST", url: "/api/web-terminal/passkeys/options" },
    { method: "POST", url: "/api/terminal/run", payload: { cwd: "/", line: "ls" } },
  ];
  for (const gate of gates) {
    const response = await delegated(gate, as(akash.id));
    assert.equal(response.statusCode, 403, `${gate.method} ${gate.url}: ${response.body}`);
  }

  // Only a real node of the account, only a space it can open, only with the internal token.
  assert.equal((await delegated({ method: "GET", url: "/api/tasks" }, as(fieldnote, bensNode.id))).statusCode, 401, "another account's node is no one");
  const lost = await delegated({ method: "GET", url: "/api/tasks" }, as(hidden));
  assert.equal(lost.statusCode, 404, "a space Akash cannot open answers nothing");
  assert.equal(json(lost).code, "SHARE_GONE");
  const { "x-ensemble-internal": _token, ...forged } = as(fieldnote);
  assert.equal((await delegated({ method: "GET", url: "/api/tasks" }, forged)).statusCode, 401, "the headers alone are nothing");
});
