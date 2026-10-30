/**
 * What a node is told (node/brain.ts persona): measured for a DM turn and a crew lead's turn, with the
 * tools a DM turn offers.
 */
import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import type { LightMyRequestResponse } from "fastify";
import { createHttpHarness, type HttpUser } from "../test/http.js";
import type { RuntimeTurn } from "../lib/model-turn.js";

const h = await createHttpHarness();
const { setAskRuntimeStreamForTests } = await import("../lib/model-turn.js");
const { settleTurns } = await import("./queue.js");
const { saveSettings } = await import("../lib/settings.js");
const { RunProfile } = await import("@ensemble/shared-types");

const LEGACY_ASSISTANT = [
  "You are your owner's personal assistant in Ensemble.",
  "- Capture what they ask as tasks, pages and projects when they want it on their board, and keep them tidy.",
  "- Real work on their computer (code, files, running things) you get done yourself by running their own coding agent: start or continue a session (node_session_start, node_session_send), then report what came back.",
  "- Keep answers short. Ask one question only when a wrong guess would waste work.",
].join("\n");
after(() => h.close());

type Seen = { slug: string; persona: string; transcript: string; tools: string[] };
type Call = { name: string; arguments: Record<string, unknown> };
const seen: Seen[] = [];
let script: (turn: Seen) => Call[] = () => [];

setAskRuntimeStreamForTests(async (args) => {
  const messages = args.messages as Array<{ role?: string; content?: unknown }>;
  const systems = messages.filter((row) => row.role === "system").map((row) => String(row.content));
  const persona = systems.find((text) => /^You are .+? \(@[a-z0-9-]+\), (?:an Ensemble Node|a temporary helper)/.test(text)) ?? "";
  const slug = /^You are .+? \(@([a-z0-9-]+)\)/.exec(persona)?.[1] ?? "?";
  const last = messages.filter((row) => row.role === "user").at(-1)?.content;
  const transcript = Array.isArray(last) ? last.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "")).join("\n") : String(last ?? "");
  const second = messages.at(-1)?.role === "tool";
  const current = { slug, persona, transcript, tools: ((args.chatTools ?? []) as Array<{ function: { name: string } }>).map((spec) => spec.function.name) };
  if (!second) seen.push(current);
  const calls = second ? [] : script(current);
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
  seen.length = 0;
  script = () => [];
});

const json = (response: LightMyRequestResponse) => response.json() as any;

async function person(name: string): Promise<HttpUser> {
  const user = await h.asUser();
  await h.prisma.user.update({ where: { id: user.id }, data: { name, emailVerifiedAt: new Date() } });
  return user;
}

async function createNode(user: HttpUser, templateId: string) {
  const response = await user.inject({ method: "POST", url: "/api/node/nodes", payload: { templateId } });
  assert.equal(response.statusCode, 201, response.body);
  return json(response) as { node: { id: string; slug: string }; room: { id: string } };
}

async function say(user: HttpUser, roomId: string, body: string) {
  const response = await user.inject({ method: "POST", url: `/api/node/rooms/${roomId}/messages`, payload: { body } });
  assert.equal(response.statusCode, 201, response.body);
  await settleTurns();
}

/** A paired computer running GitHub Copilot, and a run profile with its model, thinking level and long context. */
async function laptopFor(user: HttpUser) {
  const key = await h.asToken(user, "device");
  const laptop = await h.prisma.device.create({
    data: { userId: user.id, name: "Akash's laptop", platform: "linux", tokenId: key.id, capabilities: { folders: ["ensemble"], engines: ["copilot-cli", "claude-code"] }, lastSeenAt: new Date() },
  });
  await saveSettings(h.prisma, user.id, {
    runProfiles: [RunProfile.parse({ id: "copilot", name: "Copilot", engine: "copilot-cli", model: "gpt-6.1-sol", effort: "medium", context: "long_context", mode: "review", delivery: "local", deviceId: laptop.id })],
    defaultRunProfileId: "copilot",
  });
  return laptop;
}

test("a node does simple work itself and keeps its owner's coding agents for real coding, with the model they will use", async (t) => {
  const akash = await person("Akash");
  await laptopFor(akash);
  const { node, room: dm } = await createNode(akash, "assistant");
  const ids: string[] = [];
  for (const template of ["manager", "feature-engineer", "tester"]) ids.push((await createNode(akash, template)).node.id);
  await createNode(akash, "researcher");
  const crew = json(await akash.inject({ method: "POST", url: "/api/node/crews", payload: { title: "Software team", nodeIds: ids, leadNodeId: ids[0] } })).room as { id: string };
  // A node made from the assistant template before: its charter still says to send computer work to an agent.
  await h.prisma.nodeAgent.update({ where: { id: node.id }, data: { charter: LEGACY_ASSISTANT } });

  await say(akash, dm.id, "hello");
  const direct = seen.find((row) => row.slug === "assistant")!;
  seen.length = 0;
  await say(akash, crew.id, "hello");
  const lead = seen.find((row) => row.slug === "manager")!;
  t.diagnostic(`persona: DM ${direct.persona.length} characters, crew lead ${lead.persona.length}; tools: DM ${direct.tools.length}, crew lead ${lead.tools.length}`);

  const persona = direct.persona;
  assert.doesNotMatch(persona, /You do not write code or run commands yourself|Real work on their computer \(code, files, running things\)/, "the old routing is gone, with the old template charter");
  assert.match(persona, /Simple work you do yourself: look things up, browse and take screenshots/, "an unedited template charter reads as the template's current one");
  assert.match(persona, /your own hands on their paired computer \(a browser, a terminal, files, administrator commands with their approval\)/);
  for (const row of [
    /Facts, prices, news, “look up”, “compare”: hub_web_search first/,
    /“Screenshot of” or “show me” a site or page: browser_open, then browser_screenshot \(the viewport; for “the table”/,
    /terminal, htop or a command's output: computer_terminal_screenshot/,
    /write a report \(\.md\): computer_run or computer_files_write yourself, in your own folder unless your owner names one\. A file from the computer into this chat: node_share_file/,
    /administrator rights: computer_sudo \(your owner types their password on a card in this chat; you never see it\)/,
    /Writing or changing code in a repository[^\n]*whenever your owner names an agent[^\n]*: an agent session/,
    /Screenshots and files you capture appear with your reply by themselves\. Never say something is attached unless a tool said it will appear/,
    /When a tool says it is waiting for your owner \(a card in this chat\), stop and say nothing about it/,
    /human check[^\n]*browser_login_needed \(reason: human check\)[^\n]*US stores: United States/,
    /Asked for a table: write a Markdown table/,
  ]) assert.match(persona, row);
  assert.match(persona, /It runs GitHub Copilot · gpt-6\.1-sol · medium thinking · 1M context \(the run profile “Copilot”\) unless your owner names an agent, model, thinking level or context\./, "it can say which model its agent runs will use");
  assert.match(persona, /Your owner's other nodes, not in a crew with you \(node_crew_add asks your owner\): @builder \(engineer\), @manager \(manager\), @researcher \(researcher\), @tester \(tester\)\./);
  assert.ok(direct.tools.includes("node_crew_add"));

  assert.match(lead.persona, /node_plan, with this crew's members only/);
  assert.match(lead.persona, /Not in this crew \(node_crew_add asks your owner\): @assistant \(assistant\), @researcher \(researcher\)\./);
  assert.ok(lead.persona.length < 8_000 && persona.length < 7_000, "shorter than before (6,806 and 8,897 characters)");
});

test("a node's own run profile is what its sessions use and what it says they use; the run card names the agent, model, thinking and context", async () => {
  const mira = await person("Mira");
  const laptop = await laptopFor(mira);
  await saveSettings(h.prisma, mira.id, {
    runProfiles: [
      RunProfile.parse({ id: "copilot", name: "Copilot", engine: "copilot-cli", model: "gpt-6.1-sol", effort: "medium", context: "long_context", mode: "review", delivery: "local", deviceId: laptop.id }),
      RunProfile.parse({ id: "claude", name: "Claude", engine: "claude-code", model: "claude-opus-4.8", effort: "high", mode: "review", delivery: "local", deviceId: laptop.id }),
    ],
    defaultRunProfileId: "copilot",
  });
  const { node, room } = await createNode(mira, "feature-engineer");
  assert.equal((await mira.inject({ method: "PATCH", url: `/api/node/nodes/${node.id}`, payload: { runProfileId: "claude" } })).statusCode, 200);
  script = (turn) => (turn.transcript.includes("fix the build") ? [{ name: "node_session_start", arguments: { title: "Fix the build", prompt: "Fix the build.", folder: "ensemble" } }] : []);
  await say(mira, room.id, "fix the build");
  assert.match(seen[0]!.persona, /It runs Claude Code · claude-opus-4\.8 · high thinking \(the run profile “Claude”\)/);
  const job = await h.prisma.workspaceJob.findFirstOrThrow({ where: { userId: mira.id } });
  assert.deepEqual([job.provider, job.model, job.reasoningEffort], ["claude-code", "claude-opus-4.8", "high"], "not the default profile's Copilot");
  const card = json(await mira.inject({ method: "GET", url: `/api/node/rooms/${room.id}/messages` })).messages.find((row: { kind: string }) => row.kind === "run");
  assert.deepEqual([card.data.engine, card.data.model, card.data.effort, card.data.context], ["claude-code", "claude-opus-4.8", "high", "default"]);
});
