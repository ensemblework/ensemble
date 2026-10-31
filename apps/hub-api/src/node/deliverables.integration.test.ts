/**
 * The node's answer check (node/deliverables.ts, through `runAssistantTurn`'s verify hook): what the
 * owner asked for in a conversation turn is checked against the reply before it is posted, and what
 * is missing goes back to the model as a user message, at most twice. Four screenshots asked and
 * three taken: one more round, and the fourth comes. "Add it to my files" with nothing saved: the
 * file is saved. A link the model made up: sent back. A request already met: no round. The model's
 * own checklist call (when on) adds what the rules do not see. The computer is simulated, and
 * hub_save_file is the contract's (C4): a stand-in here when this build has none.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test, { after, afterEach } from "node:test";
import type { LightMyRequestResponse } from "fastify";
import { z } from "zod";
import { createHttpHarness, type HttpUser } from "../test/http.js";
import type { RuntimeTurn } from "../lib/model-turn.js";

const h = await createHttpHarness();
const { setAskRuntimeStreamForTests } = await import("../lib/model-turn.js");
const { settleTurns } = await import("./queue.js");
const { saveSettings } = await import("../lib/settings.js");
const { RunProfile } = await import("@ensemble/shared-types");
const { sseHub } = await import("../lib/sse.js");
const { registerAppToolSource } = await import("../assistant/apps.js");
const { getTool } = await import("../assistant/registry.js");
const { defineTool, toolOk, ToolBlockedError } = await import("../assistant/types.js");
const { saveFile } = await import("../files/store.js");
const { CHECKLIST_PROMPT, FEEDBACK_END } = await import("./deliverables.js");
after(() => h.close());

type Call = { name: string; arguments: Record<string, unknown> };
/** One model call: its system prompt, the last user message, the last tool result (when it follows one), its thinking level and tools. */
type Asked = { system: string; last: string; afterTools: boolean; tool: string; effort?: string; tools: string[] };
type Reply = { calls?: Call[]; text?: string };
let script: (asked: Asked) => Reply = () => ({ text: "ok" });
const asked: Asked[] = [];

setAskRuntimeStreamForTests(async (args) => {
  const messages = args.messages as Array<{ role?: string; content?: unknown }>;
  const text = (content: unknown) => (Array.isArray(content) ? content.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "")).join("\n") : String(content ?? ""));
  const current: Asked = {
    system: messages.filter((row) => row.role === "system").map((row) => text(row.content)).join("\n"),
    last: text(messages.filter((row) => row.role === "user").at(-1)?.content),
    afterTools: messages.at(-1)?.role === "tool",
    tool: messages.at(-1)?.role === "tool" ? text(messages.at(-1)!.content) : "",
    effort: args.reasoningEffort,
    tools: ((args.chatTools ?? []) as Array<{ function: { name: string } }>).map((spec) => spec.function.name),
  };
  asked.push(current);
  const reply = script(current);
  const calls = reply.calls ?? [];
  const turn: RuntimeTurn = {
    text: calls.length ? "" : (reply.text ?? "ok"),
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
  if (turn.text) args.onDelta?.(turn.text);
  return turn;
});

afterEach(async () => {
  await settleTurns();
  asked.length = 0;
  script = () => ({ text: "ok" });
});

const json = (response: LightMyRequestResponse) => response.json() as any;
/** The node's own model calls (not its checklist call). */
const nodeCalls = () => asked.filter((row) => /an Ensemble Node/.test(row.system));
/** The rounds of feedback the node's model was given (each once, not again with the tool results that follow). */
const feedbacks = () => nodeCalls().filter((row) => !row.afterTools && row.last.startsWith("Not done yet:"));

async function person(name: string): Promise<HttpUser> {
  const user = await h.asUser();
  await h.prisma.user.update({ where: { id: user.id }, data: { name, emailVerifiedAt: new Date() } });
  return user;
}

async function laptopFor(user: HttpUser) {
  const key = await h.asToken(user, "device");
  const laptop = await h.prisma.device.create({ data: { userId: user.id, name: "Mira's laptop", platform: "linux", tokenId: key.id, lastSeenAt: new Date(), capabilities: { folders: ["app"], engines: ["claude-code"], nodeTools: 2, browser: 1, logins: 1, capture: { browser: true } } as never } });
  await saveSettings(h.prisma, user.id, { runProfiles: [RunProfile.parse({ id: "main", name: "Main", engine: "claude-code", mode: "unattended", delivery: "local", deviceId: laptop.id })], defaultRunProfileId: "main" });
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

type Row = { id: string; kind: string; body: string; authorNodeId: string | null; data: Record<string, any> };
const replies = async (user: HttpUser, roomId: string, nodeId: string) =>
  (json(await user.inject({ method: "GET", url: `/api/node/rooms/${roomId}/messages` })).messages as Row[]).filter((row) => row.authorNodeId === nodeId && row.kind === "text");

/** Evidence the computer uploaded for the node's own operation, as the evidence route keeps it. */
async function uploaded(owner: string, nodeId: string, laptopId: string, kind: string, name: string, mime = "image/png", bytes = new Uint8Array([1, 2, 3])) {
  const id = randomUUID();
  await h.prisma.jobEvidence.create({ data: { id, userId: owner, nodeId, operation: `node:${nodeId}:own`, deviceId: laptopId, kind, name, mime, size: bytes.length, sha256: "c".repeat(64), storageKey: id, bytes } });
  return id;
}

/** The simulated computer: every browser call answers at once; a screenshot comes back as a new picture. */
function computer(owner: string, nodeId: string, laptopId: string, key: { inject: HttpUser["inject"] }) {
  const heard: Array<Record<string, unknown>> = [];
  const stop = sseHub.onFrame(({ userId, frame }) => {
    if (userId !== `device:${laptopId}` || frame.event !== "node.tool.request") return;
    const data = frame.data as Record<string, unknown> & { id: string; name?: string };
    heard.push(data);
    setTimeout(async () => {
      const shot = data.name === "browser_screenshot" ? await uploaded(owner, nodeId, laptopId, "screenshot", `shot-${heard.length}.png`) : null;
      const body = { ok: true, summary: shot ? "Saved the screenshot." : "Done.", evidence: shot ? [{ id: shot, name: `shot-${heard.length}.png`, kind: "screenshot", held: false, local: false }] : [], refused: [] };
      await key.inject({ method: "POST", url: `/api/devices/self/code-requests/${data.id}`, payload: { status: 200, body } });
    }, 5);
  });
  return { heard, stop };
}

/**
 * hub_save_file as the contract has it (C4), for these turns: `evidence` → a file in Ensemble Files and
 * its `ensemble://file/<id>` link. This build's own tool runs this stand-in while a test uses it.
 */
function saveFileTool() {
  const run = async (ctx: { prisma: typeof h.prisma; userId: string }, input: { evidence?: string; url?: string; name?: string }) => {
    if (!input.evidence) throw new ToolBlockedError("Only evidence here.");
    const row = await ctx.prisma.jobEvidence.findFirst({ where: { id: input.evidence, userId: ctx.userId } });
    if (!row?.bytes) throw new ToolBlockedError("No such evidence.");
    const file = await saveFile(ctx.prisma, ctx.userId, { filename: input.name ?? row.name, mediaType: row.mime, bytes: row.bytes }, { summarize: false });
    return toolOk(`Saved “${file.filename}” to Ensemble Files.`, { file: { id: file.id, name: file.filename, size: file.byteSize, mime: file.mediaType }, link: `ensemble://file/${file.id}` });
  };
  const own = getTool("hub_save_file") as unknown as { run: typeof run; isWrite: boolean } | undefined;
  if (own) {
    const before = { run: own.run, isWrite: own.isWrite };
    Object.assign(own, { run, isWrite: false });
    return () => Object.assign(own, before);
  }
  const tool = defineTool({
    name: "hub_save_file",
    area: "apps",
    description: "Save a file into Ensemble Files.",
    input: z.object({ url: z.string().optional(), evidence: z.string().optional(), name: z.string().optional() }).strict(),
    isWrite: false,
    risk: "low",
    run: (ctx, input) => run(ctx, input),
  });
  return registerAppToolSource(async () => [tool]);
}

test("4 screenshots asked and 3 taken: the reply goes back once, and the fourth comes with it", async () => {
  const mira = await person("Mira");
  const { laptop, key } = await laptopFor(mira);
  const { node, room } = await createNode(mira);
  const device = computer(mira.id, node.id, laptop.id, key);
  const shot = (name: string): Call => ({ name: "browser_screenshot", arguments: { tab: "t1", name } });
  try {
    script = (turn) => {
      if (turn.afterTools) return { text: turn.last.startsWith("Not done yet") ? "Here are all four charts." : "Here are the charts for Microsoft, Amazon and Nvidia." };
      if (turn.last.startsWith("Not done yet")) return { calls: [shot("apple")] };
      return { calls: [shot("microsoft"), shot("amazon"), shot("nvidia")] };
    };
    await say(mira, room.id, "send me 4 screenshots: Microsoft, Amazon, Nvidia, Apple stock charts");
    assert.equal(feedbacks().length, 1, "one round");
    assert.equal(
      feedbacks()[0]!.last,
      `Not done yet: 4 screenshots were asked for (Microsoft, Amazon, Nvidia, Apple stock charts) and 3 will show with your reply. ${FEEDBACK_END}`,
    );
    const reply = (await replies(mira, room.id, node.id)).at(-1)!;
    assert.equal(reply.body, "Here are all four charts.", "the answer after the round");
    assert.equal(reply.data.media.length, 4);
    assert.deepEqual(device.heard.map((row) => (row.input as { name?: string }).name), ["microsoft", "amazon", "nvidia", "apple"]);
    assert.equal(reply.data.tools.length, 4, "every call is on the reply");
  } finally {
    device.stop();
  }
});

test("“add it to my Ensemble files” with nothing saved: the node is told, saves it, and links only what the tool returned", async () => {
  const mira = await person("Mira");
  const { laptop } = await laptopFor(mira);
  const { node, room } = await createNode(mira);
  const paper = await uploaded(mira.id, node.id, laptop.id, "report", "BMD-45.md", "text/markdown", new TextEncoder().encode("# BMD-45\n\nA CVPR paper.\n"));
  const restore = saveFileTool();
  try {
    script = (turn) => {
      if (turn.afterTools) return { text: `Saved it: [BMD-45.md](${/ensemble:\/\/file\/[0-9a-f-]{36}/.exec(turn.tool)?.[0]})` };
      if (turn.last.startsWith("Not done yet")) return { calls: [{ name: "hub_save_file", arguments: { evidence: paper, name: "BMD-45.md" } }] };
      return { text: "Here is the paper: https://openaccess.thecvf.com/content/CVPR2026/papers/BMD-45.pdf" };
    };
    await say(mira, room.id, "fetch the BMD-45 CVPR paper from CVF and add it to my Ensemble files");
    assert.equal(feedbacks().length, 1, "one round, and the saved file's link stands");
    assert.match(feedbacks()[0]!.last, /^Not done yet: the file was to be added to your owner's Ensemble Files and nothing was saved there \(hub_save_file/);
    const file = await h.prisma.document.findFirstOrThrow({ where: { userId: mira.id } });
    assert.equal(file.filename, "BMD-45.md");
    const reply = (await replies(mira, room.id, node.id)).at(-1)!;
    assert.ok(reply.body.includes(file.id) || reply.data.refs?.some((ref: { id: string }) => ref.id === file.id), "the reply names the saved file");
    assert.deepEqual([reply.data.tools.at(-1).name, reply.data.tools.at(-1).state], ["hub_save_file", "ok"]);
  } finally {
    restore();
  }
});

test("a link the model made up is sent back; a link to the owner's own file stands", async () => {
  const mira = await person("Mira");
  const { laptop } = await laptopFor(mira);
  const { node, room } = await createNode(mira);
  const invented = randomUUID();
  script = (turn) => (turn.last.startsWith("Not done yet") ? { text: "It is not in your Ensemble Files yet; I can add it if you want." } : { text: `Here it is: [BMD-45.pdf](ensemble://file/${invented})` });
  await say(mira, room.id, "where is the BMD-45 paper?");
  assert.equal(feedbacks().length, 1);
  assert.equal(feedbacks()[0]!.last, `Not done yet: the link ensemble://file/${invented} leads nowhere (no such file in your owner's Ensemble): link only what a tool returned. ${FEEDBACK_END}`);
  assert.equal((await replies(mira, room.id, node.id)).at(-1)!.body, "It is not in your Ensemble Files yet; I can add it if you want.");

  const notes = await uploaded(mira.id, node.id, laptop.id, "report", "notes.md", "text/markdown", new TextEncoder().encode("# Notes\n"));
  const restore = saveFileTool();
  try {
    asked.length = 0;
    script = (turn) => (turn.afterTools ? { text: "Saved." } : { calls: [{ name: "hub_save_file", arguments: { evidence: notes } }] });
    await say(mira, room.id, "save the notes to my files");
    assert.equal(feedbacks().length, 0);
    const file = await h.prisma.document.findFirstOrThrow({ where: { userId: mira.id, filename: "notes.md" } });
    asked.length = 0;
    script = () => ({ text: `Your notes: [notes.md](ensemble://file/${file.id})` });
    await say(mira, room.id, "link me the notes");
    assert.equal(feedbacks().length, 0, "a real file's link is fine");
  } finally {
    restore();
  }
});

test("a request the reply already meets gets no round; a stubborn model is told at most twice", async () => {
  const mira = await person("Mira");
  const { laptop, key } = await laptopFor(mira);
  const { node, room } = await createNode(mira);
  const device = computer(mira.id, node.id, laptop.id, key);
  try {
    script = (turn) => (turn.afterTools ? { text: "Here is the screenshot." } : { calls: [{ name: "browser_screenshot", arguments: { tab: "t1" } }] });
    await say(mira, room.id, "send me a screenshot of example.com");
    assert.equal(feedbacks().length, 0);
    assert.equal(nodeCalls().length, 2, "the call and the answer, nothing more");
    assert.equal((await replies(mira, room.id, node.id)).at(-1)!.data.media.length, 1);

    asked.length = 0;
    script = () => ({ text: "Here are the screenshots." });
    await say(mira, room.id, "send me 3 screenshots of example.com, example.org and example.net");
    assert.equal(feedbacks().length, 2, "two rounds at most");
    assert.match(feedbacks()[0]!.last, /3 screenshots were asked for \(example\.com, example\.org, example\.net\) and none will show with your reply; your reply says something is attached or shown, but nothing will show with it/);
    assert.equal(nodeCalls().length, 3);
    assert.equal((await replies(mira, room.id, node.id)).at(-1)!.body, "Here are the screenshots.", "the last answer is posted as it is");
  } finally {
    device.stop();
  }
});

test("a reply that says plainly what could not be done stands; a table asked for is checked", async () => {
  const mira = await person("Mira");
  await laptopFor(mira);
  const { node, room } = await createNode(mira);
  script = (turn) => (turn.last.startsWith("Not done yet") ? { text: "| Store | Price |\n| --- | --- |\n| Walmart | $499 |" } : { text: "Walmart has it for $499." });
  await say(mira, room.id, "give me a table of PS5 prices at Walmart");
  assert.equal(feedbacks().length, 1);
  assert.match(feedbacks()[0]!.last, /a table was asked for: write it as a Markdown table in your reply/);
  assert.match((await replies(mira, room.id, node.id)).at(-1)!.body, /^\| Store \| Price \|/);

  // The screenshot failed and the reply says so: that answer stands.
  asked.length = 0;
  script = (turn) => (turn.afterTools ? { text: "I could not take the screenshot: Walmart blocked automated browsing." } : { calls: [{ name: "browser_screenshot", arguments: { tab: "walmart" } }] });
  await say(mira, room.id, "send me a screenshot of the PS5 page at walmart.com");
  assert.equal(feedbacks().length, 0);
  assert.match((await replies(mira, room.id, node.id)).at(-1)!.body, /^I could not take the screenshot/);
});

test("with the checklist call on, the model's checklist adds what the rules miss; chit-chat makes no call", async () => {
  process.env.ENSEMBLE_NODE_CHECKLIST_MODEL = "on";
  const mira = await person("Mira");
  const { laptop, key } = await laptopFor(mira);
  const { node, room } = await createNode(mira);
  const device = computer(mira.id, node.id, laptop.id, key);
  try {
    script = (turn) => {
      if (turn.system === CHECKLIST_PROMPT) return { text: '{"checks":[{"kind":"screenshots","count":2},{"kind":"bogus"}]}' };
      if (turn.afterTools) return { text: "Here are both." };
      if (turn.last.startsWith("Not done yet")) return { calls: [{ name: "browser_screenshot", arguments: { tab: "t1" } }, { name: "browser_screenshot", arguments: { tab: "t2" } }] };
      return { text: "The Willis Tower and the Trump Tower are the tallest." };
    };
    await say(mira, room.id, "grab pictures of the two tallest buildings in Chicago for me");
    const checklist = asked.filter((row) => row.system === CHECKLIST_PROMPT);
    assert.equal(checklist.length, 1, "one checklist call");
    assert.equal(checklist[0]!.effort, "low");
    assert.deepEqual(checklist[0]!.tools, [], "no tools");
    assert.match(checklist[0]!.last, /two tallest buildings in Chicago/);
    assert.equal(feedbacks().length, 1);
    assert.match(feedbacks()[0]!.last, /2 screenshots were asked for and none will show with your reply/);
    assert.equal((await replies(mira, room.id, node.id)).at(-1)!.data.media.length, 2);
    const metric = await h.prisma.metricEvent.findFirst({ where: { userId: mira.id, kind: "model.call", payload: { path: ["title"], equals: "Checklist" } } });
    assert.ok(metric, "the checklist call is metered");

    asked.length = 0;
    script = (turn) => (turn.system === CHECKLIST_PROMPT ? { text: '{"checks":[]}' } : { text: "You're welcome." });
    await say(mira, room.id, "thanks!");
    assert.equal(asked.filter((row) => row.system === CHECKLIST_PROMPT).length, 0, "no call for chit-chat");
  } finally {
    device.stop();
    process.env.ENSEMBLE_NODE_CHECKLIST_MODEL = "off";
  }
});
