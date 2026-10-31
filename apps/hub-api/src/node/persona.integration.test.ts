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
    /Facts, news, “look up”: hub_web_search first/,
    /Prices, “compare” stores, “where to buy”: browser_shop \(product, stores, location\) in one call; reply with a Markdown table/,
    /“Screenshot of” or “show me” a page: browser_view \(url; focus: what was asked[^\n]*\), one call per screenshot/,
    /Steps on a site \(a dashboard, “log in to my Azure portal and check …”\): web_task with the goal; sign-ins go to your owner's card, not Connections\./,
    /A sign-in or human check[^\n]*: browser_login_needed \(your owner does it on a card, even from their phone; never ask for passwords or codes\)\. They say done: browser_login_check/,
    /A paper or PDF into your owner's Ensemble Files: hub_save_file \(url: the direct file link\); link only what it returns/,
    /A terminal screenshot \(htop, a command's output\): computer_terminal_screenshot/,
    /a report \(\.md\): computer_run or computer_files_write yourself, in your own folder unless your owner names one\. A file into this chat: node_share_file/,
    /administrator rights: computer_sudo \(your owner types their password on a card here; you never see it\)/,
    /Writing or changing code in a repository[^\n]*whenever your owner names an agent[^\n]*: an agent session/,
    /What you capture shows with your reply by itself: never say something is attached unless a tool said it will appear/,
    /When a tool says it is waiting for your owner \(a card in this chat\), stop and say nothing about it/,
    /Asked for a table: write a Markdown table/,
    /Lasting preferences and facts your owner tells you \(“only use the MAI model”, “always …”\): node_remember at once/,
    /node_crew_add asks them on a card \(another node, or you to a crew they name\)/,
    /A node or crew they ask for: node_create \(each new node\), then node_create_group/,
  ]) assert.match(persona, row);
  assert.doesNotMatch(persona, /Skills for this request/, "no skill for a hello");
  assert.match(persona, /It runs GitHub Copilot · gpt-6\.1-sol · medium thinking · 1M context \(the run profile “Copilot”\) unless your owner names an agent, model, thinking level or context\./, "it can say which model its agent runs will use");
  assert.match(persona, /Your owner's other nodes, not in a crew with you \(node_crew_add asks your owner\): @builder \(engineer\), @manager \(manager\), @researcher \(researcher\), @tester \(tester\)\./);
  assert.ok(direct.tools.includes("node_crew_add"));

  assert.match(lead.persona, /node_plan, with this crew's members only/);
  assert.match(lead.persona, /Not in this crew \(node_crew_add asks your owner\): @assistant \(assistant\), @researcher \(researcher\)\./);
  assert.ok(lead.persona.length < 8_000 && persona.length < 6_800, `as short as before (6,479 and 7,892 characters before the web routing rows; now ${persona.length} and ${lead.persona.length})`);
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

test("a conversation turn offers the advanced browser and capture tools only for app or video work, and the skills its words call for", async (t) => {
  const { ADVANCED_TOOLS } = await import("./skills.js");
  const akash = await person("Akash");
  await laptopFor(akash);
  const { room } = await createNode(akash, "assistant");
  await say(akash, room.id, "hello");
  const plain = seen.at(-1)!;
  await say(akash, room.id, "test the sign-up page of my web app and record a video of it");
  const testing = seen.at(-1)!;
  t.diagnostic(`tools: a DM turn ${plain.tools.length} (${plain.tools.length + ADVANCED_TOOLS.size} with the advanced ones), a DM turn about testing a web app ${testing.tools.length}`);
  for (const name of ADVANCED_TOOLS) {
    assert.ok(!plain.tools.includes(name), `${name} only for app or video work`);
    assert.ok(testing.tools.includes(name), `${name} when testing a web app`);
  }
  for (const name of ["browser_open", "browser_snapshot", "browser_screenshot", "browser_login_needed", "web_task", "computer_run", "computer_terminal_screenshot"]) assert.ok(plain.tools.includes(name), `${name} always`);

  // A question about what it did keeps the tools its last reply used.
  script = (turn) => (turn.transcript.includes("open the dev tools console") ? [{ name: "browser_console", arguments: { tab: "t1" } }] : []);
  await say(akash, room.id, "open the dev tools console");
  await say(akash, room.id, "and what did it say?");
  assert.ok(seen.at(-1)!.tools.includes("browser_console"), "the conversation's last tools stay");

  await say(akash, room.id, "log in to my Azure console and check yesterday's resource usage");
  const azure = seen.at(-1)!.persona;
  assert.match(azure, /Skills for this request:\nMulti-step web work:\n- Dashboards, consoles and forms: web_task/);
  assert.match(azure, /Sign-in and human checks:\n- A page that needs your owner's account: browser_login_needed/);
  assert.doesNotMatch(azure, /Research and facts:/, "at most two skills");
});
