/**
 * Ensemble Node end to end against an in-memory database, with the model scripted: a DM turn
 * that uses Ensemble's own tools, computer work held for the owner and followed to its report,
 * a group room where a node speaks only through its owner and private threads stay private,
 * a manager delegating to its crew, and the CLI's read-only overview.
 */
import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { randomBytes } from "node:crypto";
import type { LightMyRequestResponse } from "fastify";
import { createHttpHarness, type HttpUser } from "../test/http.js";
import type { RuntimeTurn } from "../lib/model-turn.js";

const h = await createHttpHarness();
const { setAskRuntimeStreamForTests } = await import("../lib/model-turn.js");
const { settleTurns, setNodeRelevanceForTests } = await import("./queue.js");
const { pollRuns } = await import("./runs.js");
const { saveSettings } = await import("../lib/settings.js");
const { RunProfile } = await import("@ensemble/shared-types");
const { sha256 } = await import("../lib/auth.js");
after(() => h.close());

type Step = { calls?: Array<{ name: string; arguments: Record<string, unknown> }>; text?: string; then?: string };
type Seen = { slug: string; transcript: string; system: string; tools: string[] };
let script: (turn: Seen) => Step = () => ({ text: "ok" });
const seen: Seen[] = [];

setAskRuntimeStreamForTests(async (args) => {
  const messages = args.messages as Array<{ role?: string; content?: unknown }>;
  const system = messages.filter((row) => row.role === "system").map((row) => String(row.content)).join("\n");
  const slug = /You are .+? \(@([a-z0-9-]+)\), an Ensemble Node/.exec(system)?.[1] ?? "?";
  const transcript = String(messages.filter((row) => row.role === "user").at(-1)?.content ?? "");
  const second = messages.at(-1)?.role === "tool";
  const current: Seen = { slug, transcript, system, tools: ((args.chatTools ?? []) as Array<{ function: { name: string } }>).map((spec) => spec.function.name) };
  if (!second) seen.push(current);
  const step = script(current);
  const calls = second ? [] : (step.calls ?? []);
  const text = second ? (step.then ?? "Done.") : calls.length ? "" : (step.text ?? "ok");
  const turn: RuntimeTurn = {
    text,
    toolCalls: calls.map((call, index) => ({ id: `call-${randomBytes(4).toString("hex")}-${index}`, name: call.name, arguments: JSON.stringify(call.arguments) })),
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
  return turn;
});

afterEach(async () => {
  await settleTurns();
  seen.length = 0;
  setNodeRelevanceForTests(null);
});

async function person(name: string): Promise<HttpUser> {
  const user = await h.asUser();
  await h.prisma.user.update({ where: { id: user.id }, data: { name, emailVerifiedAt: new Date() } });
  return user;
}

const json = (response: LightMyRequestResponse) => response.json() as any;

async function createNode(user: HttpUser, templateId: string) {
  const response = await user.inject({ method: "POST", url: "/api/node/nodes", payload: { templateId } });
  assert.equal(response.statusCode, 201, response.body);
  return json(response) as { node: { id: string; slug: string }; room: { id: string } };
}

async function say(user: HttpUser, roomId: string, body: string, extra: Record<string, unknown> = {}) {
  const response = await user.inject({ method: "POST", url: `/api/node/rooms/${roomId}/messages`, payload: { body, ...extra } });
  assert.equal(response.statusCode, 201, response.body);
  await settleTurns();
  return json(response).message as { id: string };
}

async function read(user: HttpUser, roomId: string) {
  const response = await user.inject({ method: "GET", url: `/api/node/rooms/${roomId}/messages` });
  assert.equal(response.statusCode, 200, response.body);
  return json(response).messages as Array<{ id: string; kind: string; body: string; authorKind: string; authorNodeId: string | null; private: boolean; data: any }>;
}

test("a DM turn acts in the owner's Ensemble with the assistant's tools and reports with tool chips", async () => {
  const mira = await person("Mira");
  const { node, room } = await createNode(mira, "assistant");
  script = (turn) => (turn.slug === "assistant" ? { calls: [{ name: "hub_create_tasks", arguments: { tasks: [{ title: "Write the README" }] } }], then: "Added “Write the README”." } : {});
  await say(mira, room.id, "add a task to write the README");

  const call = seen[0]!;
  assert.match(call.transcript, /Mira \(your owner\)\] add a task to write the README/);
  assert.match(call.system, /You are Assistant \(@assistant\), an Ensemble Node: a persistent AI teammate that belongs to Mira/);
  for (const name of ["node_delegate", "node_post", "node_remember", "hub_create_tasks"]) assert.ok(call.tools.includes(name), `${name} is offered`);

  const reply = (await read(mira, room.id)).find((row) => row.authorNodeId === node.id)!;
  assert.match(reply.body, /^Added “Write the README”\./);
  assert.equal(reply.data.tools[0].name, "hub_create_tasks");
  assert.equal(reply.data.tools[0].state, "ok");
  assert.ok(await h.prisma.task.findFirst({ where: { userId: mira.id, title: "Write the README" } }), "the task is in Mira's own space");
  const turn = await h.prisma.nodeTurn.findFirstOrThrow({ where: { nodeId: node.id } });
  assert.equal(turn.status, "done");
  assert.equal(turn.reason, "dm");

  const dock = json(await mira.inject({ method: "GET", url: "/api/assistant/conversations" })).conversations as Array<{ title: string }>;
  assert.ok(!dock.some((row) => row.title.startsWith("Node ·")), "node conversations stay out of the Hub's chat list");
});

test("work on a computer waits for the owner, then the run is followed and reported back", async () => {
  const mira = await person("Mira");
  const ben = await person("Ben");
  const token = await h.prisma.apiToken.create({ data: { userId: mira.id, name: "Device · Laptop", tokenHash: sha256(`ens_${randomBytes(8).toString("hex")}`), prefix: "ens_test", scope: "device" } });
  const laptop = await h.prisma.device.create({ data: { userId: mira.id, name: "Mira's laptop", platform: "macos", tokenId: token.id, capabilities: { folders: [] }, lastSeenAt: new Date() } });
  await saveSettings(h.prisma, mira.id, { runProfiles: [RunProfile.parse({ id: "careful", name: "Careful", engine: "claude-code", mode: "ask", delivery: "local", deviceId: laptop.id })], defaultRunProfileId: "careful" });
  const task = await h.prisma.task.create({ data: { userId: mira.id, title: "Fix the login bug", boardOrder: 0, createdBy: "me" } });
  const { node, room } = await createNode(mira, "assistant");

  script = (turn) => {
    if (turn.transcript.includes("computer run for")) return { text: "The login bug is fixed: tests pass." };
    if (turn.transcript.includes("Update for you")) return { text: "(no reply)" };
    return { calls: [{ name: "hub_assign_to_agent", arguments: { taskId: task.id, computer: "any" } }], then: "Ready to start on your laptop." };
  };
  await say(mira, room.id, "fix the login bug on my laptop");
  const card = (await read(mira, room.id)).find((row) => row.kind === "approval")!;
  assert.ok(card, "a held write becomes an approval card");
  assert.equal(card.private, true);
  assert.equal(card.data.type, "tools");
  assert.equal(card.data.status, "pending");
  assert.equal(card.data.calls[0].name, "hub_assign_to_agent");
  assert.equal(await h.prisma.workspaceJob.count({ where: { taskId: task.id } }), 0, "nothing starts before approval");

  assert.equal((await ben.inject({ method: "POST", url: `/api/node/approvals/${card.id}`, payload: { decision: "approve" } })).statusCode, 404, "only the owner settles it");
  const approved = await mira.inject({ method: "POST", url: `/api/node/approvals/${card.id}`, payload: { decision: "approve" } });
  assert.equal(approved.statusCode, 200, approved.body);
  assert.equal(json(approved).message.data.status, "applied");
  assert.equal((await mira.inject({ method: "POST", url: `/api/node/approvals/${card.id}`, payload: { decision: "approve" } })).statusCode, 409, "settled once");
  await settleTurns();

  const job = await h.prisma.workspaceJob.findFirstOrThrow({ where: { taskId: task.id } });
  assert.equal(job.deviceId, laptop.id, "Ensemble's own queue runs it on the paired computer");
  const run = await h.prisma.nodeRun.findUniqueOrThrow({ where: { jobId: job.id } });
  assert.equal(run.nodeId, node.id);
  const runCard = (await read(mira, room.id)).find((row) => row.kind === "run")!;
  assert.equal(runCard.data.computer, "Mira's laptop");

  await h.prisma.workspaceJob.update({ where: { id: job.id }, data: { status: "succeeded", summary: "Fixed the null check; tests pass.", finishedAt: new Date() } });
  await pollRuns(h.app);
  await settleTurns();
  const messages = await read(mira, room.id);
  assert.equal(messages.find((row) => row.kind === "run")!.data.status, "succeeded");
  assert.ok(messages.some((row) => row.authorNodeId === node.id && row.body === "The login bug is fixed: tests pass."), "the node reports when the run ends");
  assert.ok((await h.prisma.nodeRun.findUniqueOrThrow({ where: { id: run.id } })).reportedAt);
  assert.match(seen.find((row) => row.transcript.includes("computer run for"))!.transcript, /Fixed the null check; tests pass\./);
  assert.match(seen.find((row) => row.transcript.includes("Your owner approved"))!.transcript, /“Careful” profile\. The computer run started/);
});

test("in a group, a node speaks for its owner only after approval, and private threads stay private", async () => {
  const mira = await person("Mira");
  const ben = await person("Ben");
  const { node: manager, room: dm } = await createNode(mira, "manager");
  const made = await mira.inject({ method: "POST", url: "/api/node/rooms", payload: { kind: "group", title: "Launch", nodeIds: [manager.id] } });
  assert.equal(made.statusCode, 201, made.body);
  const group = json(made).room as { id: string };
  assert.equal((await mira.inject({ method: "POST", url: `/api/node/rooms/${group.id}/people`, payload: { email: ben.email.toUpperCase() } })).statusCode, 201);
  assert.equal((await mira.inject({ method: "POST", url: `/api/node/rooms/${group.id}/people`, payload: { email: "nobody@example.test" } })).statusCode, 404);

  const benRooms = json(await ben.inject({ method: "GET", url: "/api/node/bootstrap" })).rooms as Array<{ id: string; members: any[] }>;
  assert.deepEqual(benRooms.map((row) => row.id), [group.id], "Ben sees the group, not Mira's DM");
  const managerSeenByBen = benRooms[0]!.members.find((row) => row.kind === "node")!;
  assert.equal(managerSeenByBen.node.charter, undefined, "another person's node shows only its public face");
  assert.equal((await ben.inject({ method: "GET", url: `/api/node/rooms/${dm.id}/messages` })).statusCode, 404);
  assert.equal((await ben.inject({ method: "POST", url: `/api/node/rooms/${dm.id}/messages`, payload: { body: "hi" } })).statusCode, 404);

  script = (turn) => {
    if (turn.transcript.includes("keep it under a day")) return { text: "Noted: under a day." };
    if (turn.system.includes("started by someone other than your owner")) return { text: "I'll take the login page." };
    return { text: "(no reply)" };
  };
  await say(ben, group.id, "Can someone own the login page?");
  assert.match(seen[0]!.system, /started by someone other than your owner/);
  const draft = (await read(mira, group.id)).find((row) => row.kind === "approval")!;
  assert.equal(draft.data.type, "post");
  assert.equal(draft.body, "I'll take the login page.");
  assert.ok(!(await read(ben, group.id)).some((row) => row.kind === "approval"), "Ben never sees Mira's draft");
  assert.equal((await ben.inject({ method: "POST", url: `/api/node/approvals/${draft.id}`, payload: { decision: "approve" } })).statusCode, 404);
  assert.equal((await ben.inject({ method: "GET", url: `/api/node/messages/${draft.id}` })).statusCode, 404);

  const posted = await mira.inject({ method: "POST", url: `/api/node/approvals/${draft.id}`, payload: { decision: "approve", body: "I'll take the login page (Mira's crew)." } });
  assert.equal(posted.statusCode, 200, posted.body);
  await settleTurns();
  assert.ok((await read(ben, group.id)).some((row) => row.authorNodeId === manager.id && row.body === "I'll take the login page (Mira's crew)."), "the approved words reach the room");

  seen.length = 0;
  await say(mira, group.id, "@manager keep it under a day", { private: true });
  assert.equal(seen.length, 1);
  const benView = await read(ben, group.id);
  assert.ok(!benView.some((row) => row.body.includes("under a day")), "a private message and its answer stay with Mira");
  assert.ok((await read(mira, group.id)).some((row) => row.authorNodeId === manager.id && row.body === "Noted: under a day." && row.private));

  seen.length = 0;
  await say(mira, group.id, "@manager what's the status?");
  assert.equal(seen.length, 1);
  assert.doesNotMatch(seen[0]!.transcript, /under a day/, "the shared thread never reads the private one");
  const member = await h.prisma.nodeRoomMember.findFirstOrThrow({ where: { roomId: group.id, nodeId: manager.id } });
  assert.ok(member.conversationId && member.privateConversationId && member.conversationId !== member.privateConversationId);
  const shared = await h.prisma.assistantMessage.findMany({ where: { conversationId: member.conversationId! } });
  assert.ok(!shared.some((row) => row.content.includes("under a day")), "nor does its history");

  assert.equal((await ben.inject({ method: "POST", url: `/api/node/rooms/${group.id}/nodes`, payload: { nodeId: manager.id } })).statusCode, 404, "nobody adds someone else's node");
  const { node: bensNode } = await createNode(ben, "assistant");
  assert.equal((await ben.inject({ method: "POST", url: `/api/node/rooms/${group.id}/nodes`, payload: { nodeId: bensNode.id } })).statusCode, 201);
  const routed: string[] = [];
  setNodeRelevanceForTests(async ({ prompt }) => {
    routed.push(prompt);
    return { nodes: ["assistant"] };
  });
  seen.length = 0;
  script = (turn) => (turn.slug === "assistant" ? { text: "Ben's side can review it." } : { text: "(no reply)" });
  await say(mira, group.id, "Who reviews the login page?");
  assert.equal(routed.length, 1, "two representatives: a relevance call picks");
  assert.deepEqual(seen.map((row) => row.slug), ["assistant"]);
  assert.ok((await read(ben, group.id)).some((row) => row.kind === "approval" && row.body === "Ben's side can review it."), "Ben's node drafts for Ben");
  assert.ok(!(await read(mira, group.id)).some((row) => row.body === "Ben's side can review it."));
});

test("a manager delegates to its crew, and the crew reports back by mention", async () => {
  const kofi = await person("Kofi");
  const made = await kofi.inject({ method: "POST", url: "/api/node/crews", payload: { templateId: "software-team" } });
  assert.equal(made.statusCode, 201, made.body);
  const crew = json(made).room as { id: string; members: Array<{ kind: string; handle: string }>; leadNodeIds: string[] };
  assert.deepEqual(crew.members.filter((row) => row.kind === "node").map((row) => row.handle), ["manager", "builder", "tester", "docs"]);
  script = (turn) => {
    if (turn.slug === "manager" && turn.transcript.includes("Ship the docs page")) {
      return { calls: [{ name: "node_delegate", arguments: { to: "docs", brief: "Write the release docs page. Mention @manager when done." } }], then: "Handed to the docs writer." };
    }
    if (turn.slug === "docs") return { text: "@manager Docs page drafted." };
    return { text: "(no reply)" };
  };
  await say(kofi, crew.id, "Ship the docs page");
  assert.deepEqual(seen.map((row) => row.slug), ["manager", "docs", "manager"]);
  const messages = await read(kofi, crew.id);
  const brief = messages.find((row) => row.body.startsWith("@docs Write the release docs page"))!;
  assert.ok(brief, "the brief is posted in the crew room and wakes the docs node");
  assert.ok(messages.some((row) => row.body === "@manager Docs page drafted."));
  assert.ok(!messages.some((row) => row.body === "(no reply)"), "a node with nothing to say stays quiet");
  assert.equal(json(await kofi.inject({ method: "GET", url: "/api/node/activity" })).turns.length, 3);
});

test("the CLI's Node tab reads a bridge overview; Node routes refuse narrow keys; deleting a node removes its DM", async () => {
  const dana = await person("Dana");
  const { node, room } = await createNode(dana, "researcher");
  const bridge = await h.asToken(dana, "bridge");
  const overview = await bridge.inject({ method: "GET", url: "/api/bridge/node" });
  assert.equal(overview.statusCode, 200, overview.body);
  assert.deepEqual(json(overview).nodes.map((row: { slug: string }) => row.slug), ["researcher"]);
  assert.equal(json(overview).rooms[0].id, room.id);
  assert.equal((await bridge.inject({ method: "GET", url: "/api/node/bootstrap" })).statusCode, 403);
  assert.equal((await bridge.inject({ method: "POST", url: `/api/node/rooms/${room.id}/messages`, payload: { body: "hi" } })).statusCode, 403);

  assert.equal((await dana.inject({ method: "DELETE", url: `/api/node/nodes/${node.id}` })).statusCode, 204);
  assert.equal(await h.prisma.nodeRoom.count({ where: { id: room.id } }), 0);
  assert.equal((await dana.inject({ method: "GET", url: `/api/node/rooms/${room.id}` })).statusCode, 404);
});
