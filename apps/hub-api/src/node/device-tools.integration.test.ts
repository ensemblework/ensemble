/**
 * A node's own tools on its owner's computer, from the server's side (node/device-tools.ts): each call
 * goes to the computer as `node.tool.request` and comes back as its answer. The first use of a folder
 * asks on an owner-only card in the chat; the call waits for the answer and goes again by itself, hears
 * no, or (not answered in time, or the owner wrote meanwhile) parks its turn without a reply until the
 * answer wakes it with the call to make again; a plan step waiting so stays working. Public pages need
 * no answer unless the owner asks before browsing; a node's tool operation is its own across
 * conversations; what it captures comes with its reply; terminal screenshots and shared files go as
 * their requests; unattended calls say so; an older computer is asked to update; a long command runs
 * on in the background and wakes its node once when it ends. Node runs get only the secrets they name.
 * The computer is simulated: it hears frames on its event stream and answers with its device key.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test, { after, afterEach } from "node:test";
import type { LightMyRequestResponse } from "fastify";
import { createHttpHarness, type HttpUser } from "../test/http.js";
import type { RuntimeTurn } from "../lib/model-turn.js";

// A call waits this long for its owner here; tests that let it run out set less.
process.env.ENSEMBLE_NODE_PERMISSION_WAIT_MS = "60000";
const h = await createHttpHarness();
const { setAskRuntimeStreamForTests } = await import("../lib/model-turn.js");
const { settleTurns } = await import("./queue.js");
const { saveSettings } = await import("../lib/settings.js");
const { RunProfile } = await import("@ensemble/shared-types");
const { sseHub } = await import("../lib/sse.js");
const { deviceTools } = await import("./device-tools.js");
const { postMessage } = await import("./store.js");
after(() => h.close());

type Call = { name: string; arguments: Record<string, unknown> };
type Seen = { slug: string; transcript: string; tools: string[] };
let script: (turn: Seen) => { calls?: Call[]; text?: string; then?: string } = () => ({ text: "ok" });
const seen: Seen[] = [];

setAskRuntimeStreamForTests(async (args) => {
  const messages = args.messages as Array<{ role?: string; content?: unknown }>;
  const system = messages.filter((row) => row.role === "system").map((row) => String(row.content)).join("\n");
  const slug = /You are .+? \(@([a-z0-9-]+)\), (?:an Ensemble Node|a temporary helper)/.exec(system)?.[1] ?? "?";
  const last = messages.filter((row) => row.role === "user").at(-1)?.content;
  const transcript = Array.isArray(last) ? last.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "")).join("\n") : String(last ?? "");
  const second = messages.at(-1)?.role === "tool";
  const current: Seen = { slug, transcript, tools: ((args.chatTools ?? []) as Array<{ function: { name: string } }>).map((spec) => spec.function.name) };
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
  script = () => ({ text: "ok" });
});

const json = (response: LightMyRequestResponse) => response.json() as any;

async function person(name: string): Promise<HttpUser> {
  const user = await h.asUser();
  await h.prisma.user.update({ where: { id: user.id }, data: { name, emailVerifiedAt: new Date() } });
  return user;
}

/** Mira's computer, new enough for node tools, with her run profile in the mode given. */
async function laptopFor(user: HttpUser, mode: "ask" | "unattended" = "ask", capabilities: Record<string, unknown> = { nodeTools: 1 }) {
  const key = await h.asToken(user, "device");
  const laptop = await h.prisma.device.create({ data: { userId: user.id, name: "Mira's laptop", platform: "linux", tokenId: key.id, lastSeenAt: new Date(), capabilities: { folders: ["app"], engines: ["claude-code"], ...capabilities } as never } });
  await saveSettings(h.prisma, user.id, { runProfiles: [RunProfile.parse({ id: "main", name: "Main", engine: "claude-code", mode, delivery: "local", deviceId: laptop.id })], defaultRunProfileId: "main" });
  return { laptop, key };
}

async function createNode(user: HttpUser) {
  const response = await user.inject({ method: "POST", url: "/api/node/nodes", payload: { templateId: "assistant" } });
  assert.equal(response.statusCode, 201, response.body);
  return json(response) as { node: { id: string; slug: string }; room: { id: string } };
}

async function say(user: HttpUser, roomId: string, body: string) {
  const response = await user.inject({ method: "POST", url: `/api/node/rooms/${roomId}/messages`, payload: { body } });
  assert.equal(response.statusCode, 201, response.body);
  await settleTurns();
}

async function lastReply(user: HttpUser, roomId: string, nodeId: string) {
  const response = await user.inject({ method: "GET", url: `/api/node/rooms/${roomId}/messages` });
  const rows = json(response).messages as Array<{ authorNodeId: string | null; body: string; data: { tools?: Array<{ name: string; state: string; summary: string | null }> } }>;
  return rows.filter((row) => row.authorNodeId === nodeId).at(-1)!;
}

/** The simulated computer: answers each node tool request with `answer(data)`, and records what it heard. */
function computer(laptopId: string, key: { inject: HttpUser["inject"] }, answer: (data: Record<string, unknown>) => { status: number; body: Record<string, unknown> } | Promise<{ status: number; body: Record<string, unknown> }>) {
  const heard: Array<Record<string, unknown>> = [];
  const stop = sseHub.onFrame(({ userId, frame }) => {
    if (userId !== `device:${laptopId}` || frame.event !== "node.tool.request") return;
    const data = frame.data as Record<string, unknown> & { id: string };
    heard.push(data);
    setTimeout(async () => {
      const reply = await answer(data);
      await key.inject({ method: "POST", url: `/api/devices/self/code-requests/${data.id}`, payload: reply });
    }, 5);
  });
  return { heard, stop };
}

const gitStatus = { calls: [{ name: "computer_git", arguments: { folder: "app", op: "status" } }], then: "Checked." };

/** Posts a message without waiting for the turns it starts (one may wait for its owner). */
async function post(user: HttpUser, roomId: string, body: string) {
  const response = await user.inject({ method: "POST", url: `/api/node/rooms/${roomId}/messages`, payload: { body } });
  assert.equal(response.statusCode, 201, response.body);
  return json(response).message as { id: string };
}

async function until<T>(check: () => Promise<T | null | undefined | false>, what: string, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

type Card = { id: string; kind: string; body: string; private: boolean; authorNodeId: string | null; data: Record<string, any> };

async function rows(user: HttpUser, roomId: string): Promise<Card[]> {
  return json(await user.inject({ method: "GET", url: `/api/node/rooms/${roomId}/messages` })).messages as Card[];
}

/** The computer card in a room, once it is there. */
const computerCard = (user: HttpUser, roomId: string, status = "pending") =>
  until(async () => (await rows(user, roomId)).find((row) => row.kind === "approval" && row.data.type === "computer" && row.data.status === status), `a ${status} computer card`);

/** The node's text messages in a room (its replies; cards and run cards aside). */
const replies = async (user: HttpUser, roomId: string, nodeId: string) => (await rows(user, roomId)).filter((row) => row.authorNodeId === nodeId && row.kind === "text");

/** A computer that asks its owner about a folder (or address) until a call carries their answer for it; it keeps "This mission" and "Always" itself. */
function askingComputer(laptopId: string, key: { inject: HttpUser["inject"] }, ask: Record<string, unknown>, ok: (data: Record<string, unknown>) => Record<string, unknown> = () => ({ exitCode: 0, output: "## main\n M src/app.ts\n" })) {
  let kept = false;
  return computer(laptopId, key, (data) => {
    const grants = (data.grants as Array<{ id: string; scope: string; target: string }>).filter((grant) => grant.target === ask.target);
    if (!grants.length && !kept) return { status: 428, body: { ask } };
    if (grants.some((grant) => grant.scope !== "once")) kept = true;
    return { status: 200, body: { ...ok(data), ...(grants.length ? { grantsUsed: grants.map((grant) => grant.id) } : {}) } };
  });
}

const waitSetting = process.env.ENSEMBLE_NODE_PERMISSION_WAIT_MS;
const nodeOrigin = process.env.ENSEMBLE_NODE_WEB_ORIGIN;
afterEach(() => {
  if (waitSetting === undefined) delete process.env.ENSEMBLE_NODE_PERMISSION_WAIT_MS;
  else process.env.ENSEMBLE_NODE_PERMISSION_WAIT_MS = waitSetting;
  if (nodeOrigin === undefined) delete process.env.ENSEMBLE_NODE_WEB_ORIGIN;
  else process.env.ENSEMBLE_NODE_WEB_ORIGIN = nodeOrigin;
});

test("the first use of a folder asks on a card in the chat; the call waits, and once allowed it goes again by itself", async () => {
  process.env.ENSEMBLE_NODE_WEB_ORIGIN = "https://node.example.test";
  const mira = await person("Mira");
  const { laptop, key } = await laptopFor(mira);
  const { node, room } = await createNode(mira);
  const ask = { capability: "git", target: "/home/mira/projects/app", label: "app", scope: "folder", weak: false };
  const device = askingComputer(laptop.id, key, ask);
  const statuses: Array<Record<string, unknown>> = [];
  const listen = sseHub.onFrame(({ userId, frame }) => {
    if (userId === `node:${mira.id}` && frame.event === "node.status") statuses.push(frame.data as Record<string, unknown>);
  });
  try {
    script = (turn) => (turn.transcript.includes("what changed") ? gitStatus : { text: "ok" });
    await post(mira, room.id, "what changed in app?");
    const card = await computerCard(mira, room.id);
    assert.ok(seen[0]!.tools.includes("computer_run") && seen[0]!.tools.includes("computer_git") && seen[0]!.tools.includes("computer_terminal_screenshot") && seen[0]!.tools.includes("node_share_file") && seen[0]!.tools.includes("computer_sudo"), "a DM with its owner has the computer tools");
    assert.equal(device.heard.length, 1);
    assert.equal(device.heard[0]!.attended, true, "the owner's profile asks first");
    assert.equal(device.heard[0]!.tool, "git");
    assert.equal(device.heard[0]!.nodeSlug, node.slug, "the computer knows the node's own folder by its handle");
    const decisions = await h.prisma.agentDecision.findMany({ where: { userId: mira.id, toolName: "Computer tools" } });
    assert.equal(decisions.length, 1);
    assert.match(decisions[0]!.title, /@assistant wants to read git in app on Mira's laptop/);
    // The card: in this chat, for the owner only, naming the call and the answers.
    assert.equal(card.private, true);
    assert.deepEqual((await h.prisma.nodeMessage.findUniqueOrThrow({ where: { id: card.id } })).visibleTo, [mira.id]);
    assert.equal(card.authorNodeId, node.id);
    const { answeredAt: _answeredAt, ...shape } = card.data;
    assert.deepEqual(shape, { type: "computer", status: "pending", decisionId: decisions[0]!.id, capability: "git", label: "app", scope: "folder", deviceName: "Mira's laptop", call: "git status", options: ["Once", "This mission", "Always for this folder"], answer: null, private: false });
    assert.match(card.body, /@assistant wants to read git in app on Mira's laptop/);
    const notice = await h.prisma.notification.findFirstOrThrow({ where: { userId: mira.id, kind: "decision" } });
    assert.equal(notice.url, `https://node.example.test/r/${room.id}#m-${card.id}`, "the notification opens the card in the Node chat");
    assert.ok(statuses.some((row) => row.state === "waiting" && row.cardId === card.id && row.roomId === room.id), "the node shows as waiting for its owner");

    // Its decision is the Hub's and the CLI's Needs me entry; the card itself is only in the Node chat.
    const needs = json(await mira.inject({ method: "GET", url: "/api/decisions" })).decisions as Array<{ id: string; canAnswer: boolean }>;
    assert.ok(needs.some((row) => row.id === decisions[0]!.id && row.canAnswer), "answerable in the Hub, the CLI and the phone");
    assert.ok(!(json(await mira.inject({ method: "GET", url: "/api/node/approvals" })).approvals as Array<{ id: string }>).some((row) => row.id === card.id), "not listed twice in the Hub");
    assert.equal(json(await mira.inject({ method: "GET", url: "/api/shell" })).nodeApprovals, 0);
    const bridge = await h.asToken(mira, "bridge");
    assert.deepEqual(json(await bridge.inject({ method: "GET", url: "/api/bridge/node" })).approvals, [], "nor by the CLI");
    assert.ok((json(await mira.inject({ method: "GET", url: "/api/node/activity" })).approvals as Array<{ id: string }>).some((row) => row.id === card.id), "Node's own activity keeps it");

    // The owner answers on the card (as the Node chat sends it): the waiting call goes again with the answer and returns.
    const answered = await mira.inject({ method: "POST", url: `/api/decisions/${decisions[0]!.id}/decide`, payload: { decision: "allow", scope: "once", reason: "This mission" } });
    assert.equal(answered.statusCode, 200, answered.body);
    await settleTurns();
    assert.equal(device.heard.length, 2);
    assert.deepEqual(device.heard[1]!.grants, [{ id: decisions[0]!.id, scope: "mission", target: ask.target }]);
    const reply = (await replies(mira, room.id, node.id)).at(-1)!;
    assert.equal(reply.body, "Checked.");
    assert.deepEqual(reply.data.tools!.map((tool: { name: string; state: string }) => [tool.name, tool.state]), [["computer_git", "ok"]]);
    assert.ok(!JSON.stringify(reply).includes("Needs me"));
    const settled = (await rows(mira, room.id)).find((row) => row.id === card.id)!;
    assert.deepEqual([settled.data.status, settled.data.answer, typeof settled.data.answeredAt], ["allowed", "This mission", "string"]);
    const detail = (await h.prisma.agentDecision.findUniqueOrThrow({ where: { id: decisions[0]!.id } })).detail as { nodeTool: { delivered: boolean; announced: boolean } };
    assert.deepEqual([detail.nodeTool.delivered, detail.nodeTool.announced], [true, true]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await settleTurns();
    assert.equal(await h.prisma.nodeTurn.count({ where: { nodeId: node.id } }), 1, "the answer does not wake the node a second time");

    // Once used, the answer is the computer's to keep: it is not sent again.
    await say(mira, room.id, "what changed in app?");
    assert.deepEqual(device.heard.at(-1)!.grants, []);
  } finally {
    listen();
    device.stop();
  }
});

test("no on the card: the call hears it and the node goes on without it", async () => {
  const mira = await person("Mira");
  const { laptop, key } = await laptopFor(mira);
  const { node, room } = await createNode(mira);
  const device = askingComputer(laptop.id, key, { capability: "run", target: "/home/mira/projects/app", label: "app", scope: "folder", weak: false });
  try {
    script = (turn) => (turn.transcript.includes("run the tests") ? { calls: [{ name: "computer_run", arguments: { folder: "app", command: "npm test" } }], then: "I could not run them: you said no." } : { text: "ok" });
    await post(mira, room.id, "run the tests in app");
    const card = await computerCard(mira, room.id);
    assert.equal(card.data.call, "Run: npm test");
    const denied = await mira.inject({ method: "POST", url: `/api/decisions/${card.data.decisionId}/decide`, payload: { decision: "deny", scope: "once" } });
    assert.equal(denied.statusCode, 200, denied.body);
    await settleTurns();
    assert.equal(device.heard.length, 1, "nothing ran");
    const reply = (await replies(mira, room.id, node.id)).at(-1)!;
    assert.match(reply.data.tools[0].summary, /Your owner chose not to allow this call \(Run: npm test\) in app on Mira's laptop/);
    const after = (await rows(mira, room.id)).find((row) => row.id === card.id)!;
    assert.deepEqual([after.data.status, after.data.answer], ["denied", "No"]);
  } finally {
    device.stop();
  }
});

test("not answered in time: the turn parks without a reply, and the answer later wakes the node with the call to make again", async () => {
  process.env.ENSEMBLE_NODE_PERMISSION_WAIT_MS = "300";
  const mira = await person("Mira");
  const { laptop, key } = await laptopFor(mira);
  const { node, room } = await createNode(mira);
  const ask = { capability: "git", target: "/home/mira/projects/app", label: "app", scope: "folder", weak: false };
  const device = askingComputer(laptop.id, key, ask);
  try {
    script = (turn) => (turn.transcript.includes("what changed") || turn.transcript.includes("Make this call again now") ? gitStatus : { text: "ok" });
    await say(mira, room.id, "what changed in app?");
    const card = await computerCard(mira, room.id);
    assert.deepEqual(await replies(mira, room.id, node.id), [], "no reply: nothing like “please approve”");
    const turn = await h.prisma.nodeTurn.findFirstOrThrow({ where: { nodeId: node.id } });
    assert.equal(turn.status, "done");
    const conversation = (await h.prisma.nodeRoomMember.findFirstOrThrow({ where: { roomId: room.id, nodeId: node.id } })).conversationId!;
    const note = await h.prisma.assistantMessage.findFirstOrThrow({ where: { conversationId: conversation, role: "assistant" }, orderBy: { createdAt: "desc" } });
    assert.equal(note.content, "Waiting for Mira to answer the card about git status (in app on Mira's laptop).", "the next turn knows what it waits for");

    // The owner answers later, here in the Hub: the card says so, and the node is woken with the exact call.
    const answered = await mira.inject({ method: "POST", url: `/api/decisions/${card.data.decisionId}/decide`, payload: { decision: "allow", scope: "once", reason: "Always for this folder" } });
    assert.equal(answered.statusCode, 200, answered.body);
    await until(async () => seen.some((row) => row.transcript.includes("Make this call again now")), "the node to be woken");
    await settleTurns();
    const woken = seen.find((row) => row.transcript.includes("Make this call again now"))!;
    assert.match(woken.transcript, /Your owner allowed your computer tools in app on Mira's laptop from now on\. Make this call again now: computer_git \{"folder":"app","op":"status","args":\[\]\}/);
    assert.deepEqual(device.heard.at(-1)!.grants, [{ id: card.data.decisionId, scope: "always", target: ask.target }]);
    assert.equal((await replies(mira, room.id, node.id)).at(-1)!.body, "Checked.");
    const after = (await rows(mira, room.id)).find((row) => row.id === card.id)!;
    assert.deepEqual([after.data.status, after.data.answer], ["allowed", "Always for this folder"]);
  } finally {
    device.stop();
  }
});

test("two steps of one plan parked on one question: the answer wakes each with its own call", async () => {
  process.env.ENSEMBLE_NODE_PERMISSION_WAIT_MS = "300";
  const mira = await person("Mira");
  const { laptop, key } = await laptopFor(mira);
  const lead = json(await mira.inject({ method: "POST", url: "/api/node/nodes", payload: { templateId: "manager" } })).node as { id: string; slug: string };
  const worker = await createNode(mira);
  const crew = await mira.inject({ method: "POST", url: "/api/node/crews", payload: { title: "App", nodeIds: [lead.id, worker.node.id], leadNodeId: lead.id } });
  assert.equal(crew.statusCode, 201, crew.body);
  const crewRoom = json(crew).room as { id: string };
  const target = "/home/mira/projects/app";
  let kept = false;
  // The second step's question comes a little later, so it finds the first one waiting.
  const device = computer(laptop.id, key, async (data) => {
    const grants = (data.grants as Array<{ id: string; scope: string; target: string }>).filter((grant) => grant.target === target);
    if (grants.some((grant) => grant.scope !== "once")) kept = true;
    if (!grants.length && !kept) {
      if (data.op === "log") await new Promise((resolve) => setTimeout(resolve, 150));
      return { status: 428, body: { ask: { capability: "git", target, label: "app", scope: "folder", weak: false } } };
    }
    return { status: 200, body: { exitCode: 0, output: data.op === "log" ? "abc123 Fix\n" : "## main\n", ...(grants.length ? { grantsUsed: grants.map((grant) => grant.id) } : {}) } };
  });
  const git = (op: string) => ({ name: "computer_git", arguments: { folder: "app", op } });
  const report = (summary: string) => ({ name: "node_step_report", arguments: { outcome: "done", summary } });
  try {
    script = (turn) => {
      if (turn.transcript.includes("Make this call again now")) return { calls: turn.transcript.includes('"op":"log"') ? [git("log"), report("The log is read.")] : [git("status"), report("The status is read.")], then: "(no reply)" };
      if (turn.transcript.includes("Read the git status in app")) return { calls: [git("status")], then: "(no reply)" };
      if (turn.transcript.includes("Read the git log in app")) return { calls: [git("log")], then: "(no reply)" };
      if (turn.transcript.includes("look at app")) {
        return { calls: [{ name: "node_delegate", arguments: { to: worker.node.slug, brief: "Read the git status in app.", kind: "research" } }, { name: "node_delegate", arguments: { to: worker.node.slug, brief: "Read the git log in app.", kind: "research" } }], then: "Planned." };
      }
      return { text: "Both are read." };
    };
    await say(mira, crewRoom.id, `@${lead.slug} look at app`);
    const questions = await h.prisma.agentDecision.findMany({ where: { userId: mira.id } });
    assert.equal(questions.length, 1, "one question for the plan's folder");
    const parked = (questions[0]!.detail as { nodeTool: { parked: Array<{ planStep: string; retry: string }> } }).nodeTool.parked;
    assert.equal(parked.length, 2, "both steps wait on it");
    const mission = await h.prisma.nodeMission.findFirstOrThrow({ where: { userId: mira.id } });
    assert.deepEqual((await h.prisma.nodeStep.findMany({ where: { missionId: mission.id } })).map((row) => row.status), ["working", "working"]);

    const answered = await mira.inject({ method: "POST", url: `/api/decisions/${questions[0]!.id}/decide`, payload: { decision: "allow", scope: "once", reason: "This mission" } });
    assert.equal(answered.statusCode, 200, answered.body);
    await until(async () => (await h.prisma.nodeStep.findMany({ where: { missionId: mission.id } })).every((row) => row.status === "done"), "both steps to finish");
    await settleTurns();
    const woken = seen.filter((row) => row.transcript.includes("Make this call again now"));
    assert.equal(woken.length, 2, "each step is woken once");
    assert.ok(woken.some((row) => row.transcript.includes('"op":"status"')) && woken.some((row) => row.transcript.includes('"op":"log"')), "each with its own call");
  } finally {
    device.stop();
  }
});

test("a new message from the owner ends the wait: the waiting turn parks and the message is answered next", async () => {
  const mira = await person("Mira");
  const { laptop, key } = await laptopFor(mira);
  const { node, room } = await createNode(mira);
  const device = askingComputer(laptop.id, key, { capability: "run", target: "/home/mira/projects/app", label: "app", scope: "folder", weak: false });
  try {
    script = (turn) => (turn.transcript.includes("build app") ? { calls: [{ name: "computer_run", arguments: { folder: "app", command: "npm run build" } }], then: "Built." } : turn.transcript.includes("how is it going") ? { text: "Still waiting for your answer on the card." } : { text: "ok" });
    await post(mira, room.id, "build app");
    const card = await computerCard(mira, room.id);
    const started = Date.now();
    await say(mira, room.id, "how is it going?");
    assert.ok(Date.now() - started < 10_000, "the wait ended at once, not after its time");
    const said = await replies(mira, room.id, node.id);
    assert.deepEqual(said.map((row) => row.body), ["Still waiting for your answer on the card."], "the first turn parked without a reply; the new message got one");
    assert.equal((await rows(mira, room.id)).find((row) => row.id === card.id)!.data.status, "pending", "the card still waits");
    assert.equal(device.heard.length, 1);
  } finally {
    device.stop();
  }
});

test("a plan step waiting for its owner stays working: it is not nudged or blocked, and the answer carries it on", async () => {
  process.env.ENSEMBLE_NODE_PERMISSION_WAIT_MS = "300";
  const mira = await person("Mira");
  const { laptop, key } = await laptopFor(mira);
  const lead = await mira.inject({ method: "POST", url: "/api/node/nodes", payload: { templateId: "manager" } });
  const worker = await createNode(mira);
  const crew = await mira.inject({ method: "POST", url: "/api/node/crews", payload: { title: "Release", nodeIds: [json(lead).node.id, worker.node.id], leadNodeId: json(lead).node.id } });
  assert.equal(crew.statusCode, 201, crew.body);
  const crewRoom = json(crew).room as { id: string };
  const ask = { capability: "git", target: "/home/mira/projects/app", label: "app", scope: "folder", weak: false };
  const device = askingComputer(laptop.id, key, ask);
  try {
    script = (turn) => {
      if (turn.transcript.includes("Make this call again now")) return { calls: [gitStatus.calls[0]!, { name: "node_step_report", arguments: { outcome: "done", summary: "app has one change: src/app.ts." } }], then: "(no reply)" };
      if (turn.transcript.includes("Read git status in app")) return gitStatus;
      if (turn.transcript.includes("check app")) return { calls: [{ name: "node_delegate", arguments: { to: worker.node.slug, brief: "Read git status in app and report it.", kind: "research" } }], then: "Planned." };
      return { text: "app has one change." };
    };
    await say(mira, crewRoom.id, `@${json(lead).node.slug} check app`);
    const card = await computerCard(mira, crewRoom.id);
    const mission = await h.prisma.nodeMission.findFirstOrThrow({ where: { userId: mira.id } });
    const step = await h.prisma.nodeStep.findFirstOrThrow({ where: { missionId: mission.id } });
    assert.deepEqual(card.data.plan, { id: mission.id, step: step.id }, "the card names its step");
    assert.equal(step.status, "working", "the step waits for its owner, not blocked");
    assert.equal(step.nudged, false);
    assert.match(step.progress ?? "", /Waiting for Mira's answer on a card/);
    const { stepCardsWaiting } = await import("./plans.js");
    assert.equal(await stepCardsWaiting(h.prisma, mission.id, step.id), 1);

    const answered = await mira.inject({ method: "POST", url: `/api/decisions/${card.data.decisionId}/decide`, payload: { decision: "allow", scope: "once", reason: "Once" } });
    assert.equal(answered.statusCode, 200, answered.body);
    await until(async () => (await h.prisma.nodeStep.findFirstOrThrow({ where: { missionId: mission.id } })).status === "done", "the step to finish");
    await settleTurns();
    assert.deepEqual(device.heard.at(-1)!.grants, [{ id: card.data.decisionId, scope: "once", target: ask.target }]);
  } finally {
    device.stop();
  }
});

test("the computer decides about public pages; the owner's choice to be asked goes with each call; the node's tabs are its own across conversations", async () => {
  const mira = await person("Mira");
  const { laptop, key } = await laptopFor(mira, "ask", { nodeTools: 2, browser: 1, capture: { browser: true } });
  const { node, room } = await createNode(mira);
  const device = computer(laptop.id, key, () => ({ status: 200, body: { ok: true, summary: "Opened t1: Example Domain.", evidence: [], refused: [] } }));
  try {
    script = (turn) => (turn.transcript.includes("open example") ? { calls: [{ name: "browser_open", arguments: { url: "https://www.example.com/pricing?plan=pro" } }], then: "Opened." } : { text: "ok" });
    await say(mira, room.id, "open example.com");
    const first = device.heard[0]!;
    assert.equal(first.tool, "browser");
    // No answer is made up on the web: the computer allows public pages itself and asks for its own and its network's (device-tools/policy.ts).
    assert.deepEqual(first.grants, []);
    assert.equal(first.askBeforeBrowsing, undefined);
    assert.equal(first.operation, `node:${node.id}:own`, "one operation per node");
    assert.equal((await replies(mira, room.id, node.id)).at(-1)!.data.tools[0].state, "ok");
    assert.equal(await h.prisma.agentDecision.count({ where: { userId: mira.id } }), 0);

    // The same node in a crew: the same operation, so its tabs carry across.
    const crew = await mira.inject({ method: "POST", url: "/api/node/crews", payload: { title: "Research", nodeIds: [node.id], leadNodeId: node.id } });
    assert.equal(crew.statusCode, 201, crew.body);
    await say(mira, json(crew).room.id, `@${node.slug} open example.com`);
    assert.equal(device.heard[1]!.operation, `node:${node.id}:own`);

    // The owner asks to be asked before a node opens a new website: the computer hears it with the call.
    const saved = await mira.inject({ method: "PATCH", url: "/api/settings", payload: { node: { askBeforeBrowsing: true } } });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(json(saved).settings.node.askBeforeBrowsing, true);
    await say(mira, room.id, "open example.com");
    assert.equal(device.heard[2]!.askBeforeBrowsing, true);
  } finally {
    device.stop();
  }
});

/** Evidence the computer uploaded for the node's operation, as the evidence route would keep it. */
async function uploaded(owner: string, nodeId: string, laptopId: string, kind: string, name: string, mime = "image/png") {
  const id = randomUUID();
  await h.prisma.jobEvidence.create({ data: { id, userId: owner, nodeId, operation: `node:${nodeId}:own`, deviceId: laptopId, kind, name, mime, size: 3, sha256: "c".repeat(64), storageKey: id, bytes: new Uint8Array([1, 2, 3]) } });
  return id;
}

test("what the node captures comes with its reply by itself; its own choice with node_show wins", async () => {
  const mira = await person("Mira");
  const { laptop, key } = await laptopFor(mira, "unattended", { nodeTools: 2, browser: 1, capture: { browser: true } });
  const { node, room } = await createNode(mira);
  const shots: string[] = [];
  const device = computer(laptop.id, key, async () => {
    const id = await uploaded(mira.id, node.id, laptop.id, "screenshot", `shot-${shots.length + 1}.png`);
    shots.push(id);
    return { status: 200, body: { ok: true, summary: "Captured.", evidence: [{ id, name: `shot-${shots.length}.png`, kind: "screenshot", held: false, local: false }], refused: [] } };
  });
  try {
    const shoot = { name: "capture_screenshot", arguments: { target: "web", url: "https://example.com/" } };
    script = (turn) => (turn.transcript.includes("screenshot of example") ? { calls: [shoot, shoot], then: "Here is example.com." } : { text: "ok" });
    await say(mira, room.id, "send me a screenshot of example.com");
    const reply = (await replies(mira, room.id, node.id)).at(-1)!;
    assert.deepEqual(reply.data.media.map((item: { evidenceId: string }) => item.evidenceId), [shots[0], shots[1]], "in the order taken, without node_show");
    assert.match(reply.data.tools[0].summary, /This screenshot will appear with your reply\./);

    // A model that says nothing after its tools is asked once for its reply; nothing it captured is lost.
    script = (turn) =>
      turn.transcript.includes("one more of example") ? { calls: [shoot], then: "" } : turn.transcript.includes("you wrote nothing") ? { text: "Here it is." } : { text: "ok" };
    await say(mira, room.id, "one more of example.com");
    const answered = (await replies(mira, room.id, node.id)).at(-1)!;
    assert.equal(answered.body, "Here it is.");
    assert.deepEqual(answered.data.media.map((item: { evidenceId: string }) => item.evidenceId), [shots.at(-1)]);
    assert.ok(seen.some((row) => row.transcript.includes("Your tools have answered, but you wrote nothing.")));

    const older = await uploaded(mira.id, node.id, laptop.id, "screenshot", "older.png");
    script = (turn) => (turn.transcript.includes("the older one") ? { calls: [shoot, { name: "node_show", arguments: { evidence: [older] } }], then: "Here is the older one." } : { text: "ok" });
    await say(mira, room.id, "show me the older one");
    const chosen = (await replies(mira, room.id, node.id)).at(-1)!;
    assert.deepEqual(chosen.data.media.map((item: { evidenceId: string }) => item.evidenceId), [older], "node_show chose");
  } finally {
    device.stop();
  }
});

test("a terminal screenshot and a shared file: their requests, the screen as text, and the files with the reply", async () => {
  const mira = await person("Mira");
  const { laptop, key } = await laptopFor(mira, "unattended", { nodeTools: 2 });
  const { node, room } = await createNode(mira);
  const device = computer(laptop.id, key, async (data) => {
    if (data.tool === "terminal") {
      const id = await uploaded(mira.id, node.id, laptop.id, "screenshot", "htop.png");
      return { status: 200, body: { ok: true, summary: "Captured the terminal.", result: { screen: "  PID USER      PR  NI\n    1 root      20   0", exitCode: null, ended: false }, evidence: [{ id, name: "htop.png", kind: "screenshot", held: false, local: false }], refused: [] } };
    }
    if (data.tool === "files" && data.action === "share") {
      const id = await uploaded(mira.id, node.id, laptop.id, "report", "report.md", "text/markdown");
      return { status: 200, body: { ok: true, summary: "Shared report.md.", evidence: [{ id, name: "report.md", kind: "report", held: false, local: false }], refused: [] } };
    }
    return { status: 200, body: { exitCode: 0, output: "ok\n" } };
  });
  try {
    script = (turn) => (turn.transcript.includes("htop") ? { calls: [{ name: "computer_terminal_screenshot", arguments: { command: "htop", seconds: 2 } }], then: "Here is htop." } : { text: "ok" });
    await say(mira, room.id, "send me a screenshot of htop");
    const asked = device.heard[0]!;
    assert.deepEqual([asked.tool, asked.command, asked.seconds, asked.columns, asked.rows, asked.folder, asked.operation, asked.nodeSlug], ["terminal", "htop", 2, 120, 32, undefined, `node:${node.id}:own`, node.slug]);
    assert.match(String(asked.uploadId), /^[0-9a-f-]{36}$/);
    let reply = (await replies(mira, room.id, node.id)).at(-1)!;
    assert.equal(reply.data.media.length, 1);
    assert.match(reply.data.tools[0].summary, /This screenshot will appear with your reply/);
    const call = await h.prisma.assistantMessage.findFirstOrThrow({ where: { role: "assistant", userId: mira.id }, orderBy: { createdAt: "desc" } });
    assert.match(JSON.stringify(call.toolCalls), /computer_terminal_screenshot/);

    script = (turn) => (turn.transcript.includes("the report") ? { calls: [{ name: "computer_files_write", arguments: { path: "report.md", content: "# Report\n" } }, { name: "node_share_file", arguments: { path: "report.md", caption: "The weekly report" } }], then: "The report is attached." } : { text: "ok" });
    await say(mira, room.id, "write the report and send it here");
    const [write, share] = device.heard.slice(1);
    assert.deepEqual([write!.tool, write!.action, write!.folder, write!.nodeSlug], ["files", "write", undefined, node.slug], "no folder: the node's own folder");
    assert.deepEqual([share!.tool, share!.action, share!.path, share!.caption, share!.operation], ["files", "share", "report.md", "The weekly report", `node:${node.id}:own`]);
    reply = (await replies(mira, room.id, node.id)).at(-1)!;
    assert.deepEqual(reply.data.media.map((item: { kind: string; name: string }) => [item.kind, item.name]), [["report", "report.md"]]);

    // The hard floor is checked before anything is sent.
    const heard = device.heard.length;
    script = (turn) => (turn.transcript.includes("wipe") ? { calls: [{ name: "computer_run", arguments: { command: "rm -rf /" } }], then: "Refused." } : { text: "ok" });
    await say(mira, room.id, "wipe the disk");
    assert.equal(device.heard.length, heard);
    assert.match((await replies(mira, room.id, node.id)).at(-1)!.data.tools[0].summary, /Refused by Ensemble's hard floor/);

    // An older computer: asked to update for what it lacks.
    await h.prisma.device.update({ where: { id: laptop.id }, data: { capabilities: { folders: ["app"], engines: ["claude-code"], nodeTools: 1 } } });
    script = (turn) => (turn.transcript.includes("htop again") ? { calls: [{ name: "computer_terminal_screenshot", arguments: { command: "htop" } }, { name: "computer_run", arguments: { command: "ls" } }], then: "Could not." } : { text: "ok" });
    await say(mira, room.id, "htop again");
    const tools = (await replies(mira, room.id, node.id)).at(-1)!.data.tools as Array<{ summary: string }>;
    assert.match(tools[0]!.summary, /Update Ensemble on Mira's laptop \(`ensemble update`, or the desktop app's update\) to take terminal screenshots there/);
    assert.match(tools[1]!.summary, /to work in your own folder there/);
    assert.equal(device.heard.length, heard, "nothing was sent to it");
  } finally {
    device.stop();
  }
});

test("unattended calls say so; the computer's refusal is the node's answer; an older computer is asked to update", async () => {
  const mira = await person("Mira");
  const { laptop, key } = await laptopFor(mira, "unattended");
  const { node, room } = await createNode(mira);
  const device = computer(laptop.id, key, (data) => (data.op === "show" ? { status: 403, body: { error: "~/.ssh holds keys, sign-ins or browser data." } } : { status: 200, body: { exitCode: 0, output: "## main\n" } }));
  try {
    script = () => gitStatus;
    await say(mira, room.id, "status of app?");
    assert.equal(device.heard[0]!.attended, false);
    assert.equal(await h.prisma.agentDecision.count({ where: { userId: mira.id } }), 0, "nothing to ask unattended");
    script = () => ({ calls: [{ name: "computer_git", arguments: { folder: "app", op: "show" } }], then: "Refused." });
    await say(mira, room.id, "show the key");
    const refused = (await lastReply(mira, room.id, node.id)).data.tools![0]!;
    assert.equal(refused.state, "failed");
    assert.match(refused.summary!, /refused: ~\/\.ssh holds keys/);
  } finally {
    device.stop();
  }

  await h.prisma.device.update({ where: { id: laptop.id }, data: { capabilities: { folders: ["app"], engines: ["claude-code"] } } });
  script = () => gitStatus;
  await say(mira, room.id, "status of app?");
  assert.match((await lastReply(mira, room.id, node.id)).data.tools![0]!.summary!, /Update Ensemble on Mira's laptop/);
});

test("the computer tools are the owner's alone: not in a turn someone else started or that others read", async () => {
  const mira = await person("Mira");
  const { node, room } = await createNode(mira);
  const row = await h.prisma.nodeAgent.findUniqueOrThrow({ where: { id: node.id } });
  const scopeRoom = await h.prisma.nodeRoom.findUniqueOrThrow({ where: { id: room.id } });
  const scope = { prisma: h.prisma, node: row, room: scopeRoom, lineage: { rootMessageId: null, botDepth: 0, fromNonOwner: false }, privateTo: null, ownerOnly: true, redis: h.app.redis as never, dispatch: async () => undefined, turnId: "t", plan: null };
  assert.ok(deviceTools(scope).some((tool) => tool.name === "computer_run"));
  assert.deepEqual(deviceTools({ ...scope, lineage: { ...scope.lineage, fromNonOwner: true } }), []);
  assert.deepEqual(deviceTools({ ...scope, ownerOnly: false }), []);
});

test("a long command runs on in the background and wakes its node once when it ends; its output stays readable", async () => {
  const mira = await person("Mira");
  const { laptop, key } = await laptopFor(mira, "unattended");
  const { node, room } = await createNode(mira);
  let runId = "";
  const post = (seq: number, text: string, done = false) =>
    key.inject({ method: "POST", url: `/api/devices/self/tool-runs/${runId}/output`, payload: { seq, text, done, ...(done ? { exitCode: 0, wake: true } : {}) } });
  const device = computer(laptop.id, key, (data) => {
    runId = String(data.runId);
    return { status: 202, body: { runId, background: true, output: "building…\n" } };
  });
  try {
    script = (turn) =>
      turn.transcript.includes("ended after")
        ? { calls: [{ name: "computer_run_output", arguments: { run: runId } }], then: "The build passed." }
        : { calls: [{ name: "computer_run", arguments: { folder: "app", command: "npm run build", timeoutSec: 900 } }], then: "It is building; I will say when it ends." };
    await say(mira, room.id, "build app");
    assert.equal(device.heard[0]!.tool, "run");
    assert.match((await lastReply(mira, room.id, node.id)).data.tools![0]!.summary!, /running in the background/);
    const turnsBefore = await h.prisma.nodeTurn.count({ where: { nodeId: node.id } });
    assert.equal((await post(0, "step 1 of 2\n")).statusCode, 200);
    assert.equal((await post(1, "built in 5 min\n", true)).statusCode, 200);
    // The end arrives twice (a retried post): the node wakes once.
    assert.equal((await post(1, "built in 5 min\n", true)).statusCode, 409);
    assert.equal((await post(2, "", true)).statusCode, 200);
    await settleTurns();
    const woken = seen.filter((turn) => turn.transcript.includes("ended after"));
    assert.equal(woken.length, 1);
    assert.match(woken[0]!.transcript, /`npm run build` in app on Mira's laptop ended after .*, exit code 0/);
    assert.equal(await h.prisma.nodeTurn.count({ where: { nodeId: node.id } }), turnsBefore + 1);
    const read = (await lastReply(mira, room.id, node.id)).data.tools![0]!;
    assert.equal(read.name, "computer_run_output");
    assert.equal(read.state, "ok");
    // Another computer cannot write into this run's output.
    const other = await person("Tom");
    const tomKey = await h.asToken(other, "device");
    await h.prisma.device.create({ data: { userId: other.id, name: "Tom's PC", platform: "linux", tokenId: tomKey.id, lastSeenAt: new Date() } });
    assert.equal((await tomKey.inject({ method: "POST", url: `/api/devices/self/tool-runs/${runId}/output`, payload: { seq: 3, text: "x" } })).statusCode, 410);
  } finally {
    device.stop();
  }
});

test("a node's agent run gets only the secrets it names: none by default, a saved request's name once saved", async () => {
  const mira = await person("Mira");
  const { key } = await laptopFor(mira, "ask", { secrets: 1 });
  const { node, room } = await createNode(mira);
  script = () => ({ calls: [{ name: "node_session_start", arguments: { title: "Test payments", prompt: "Run the payment tests.", folder: "app" } }], then: "Started." });
  await say(mira, room.id, "run the payment tests");
  const first = await h.prisma.workspaceJob.findFirstOrThrow({ where: { userId: mira.id }, orderBy: { createdAt: "desc" } });
  assert.deepEqual((first.context as { secrets?: unknown }).secrets, [], "no saved secret by default");
  const claim = await key.inject({ method: "POST", url: "/api/devices/self/claim" });
  assert.equal(claim.statusCode, 200, claim.body);
  assert.deepEqual(json(claim).secrets, [], "the computer is told: none");

  await postMessage(h.prisma, { roomId: room.id, userId: mira.id, authorKind: "node", authorNodeId: node.id, kind: "approval", body: "To call the payments API.", data: { type: "secret", status: "saved", name: "STRIPE_KEY", deviceId: "x", computer: "Mira's laptop" }, visibleTo: [mira.id] });
  await say(mira, room.id, "run them again with the key");
  const second = await h.prisma.workspaceJob.findFirstOrThrow({ where: { userId: mira.id, id: { not: first.id } }, orderBy: { createdAt: "desc" } });
  assert.deepEqual((second.context as { secrets?: unknown }).secrets, ["STRIPE_KEY"]);
});
