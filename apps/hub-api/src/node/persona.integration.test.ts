/**
 * What a node is told (node/instructions.ts, from packages/prompts): the sections a DM turn and a crew
 * lead's turn get and the size of each tier, the same stable tier from one turn to the next, and on the
 * owner's AI plan the stable tier alone as the system prompt, with the context leading the message.
 */
import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import type { LightMyRequestResponse } from "fastify";
import type { Prisma } from "@prisma/client";
import { renderSection, sectionText, type SectionName } from "@ensemble/prompts";
import { createHttpHarness, type HttpUser } from "../test/http.js";
import type { RuntimeTurn } from "../lib/model-turn.js";

const h = await createHttpHarness();
const { setAskRuntimeStreamForTests } = await import("../lib/model-turn.js");
const { settleTurns } = await import("./queue.js");
const { saveSettings } = await import("../lib/settings.js");
const { RunProfile } = await import("@ensemble/shared-types");
const { sseHub } = await import("../lib/sse.js");
const { CONSTITUTION } = await import("./instructions.js");

/** The context tier's first line: a node's system message splits there into its stable and context tiers. */
const CONTEXT = sectionText("node/50-context");
const tokens = (text: string) => Math.ceil(text.length / 4);

const LEGACY_ASSISTANT = [
  "You are your owner's personal assistant in Ensemble.",
  "- Capture what they ask as tasks, pages and projects when they want it on their board, and keep them tidy.",
  "- Real work on their computer (code, files, running things) you get done yourself by running their own coding agent: start or continue a session (node_session_start, node_session_send), then report what came back.",
  "- Keep answers short. Ask one question only when a wrong guess would waste work.",
].join("\n");
after(() => h.close());

type Seen = { slug: string; systems: string[]; stable: string; context: string; transcript: string; tools: string[] };
type Call = { name: string; arguments: Record<string, unknown> };
const seen: Seen[] = [];
let script: (turn: Seen) => Call[] = () => [];

setAskRuntimeStreamForTests(async (args) => {
  const messages = args.messages as Array<{ role?: string; content?: unknown }>;
  const systems = messages.filter((row) => row.role === "system").map((row) => String(row.content));
  // The node's own system message follows the assistant's: its stable tier, then its context tier.
  const own = systems.find((text) => /\(@[a-z0-9-]+\), (?:an Ensemble Node|a temporary helper)/.test(text)) ?? "";
  const at = own.indexOf(`\n\n${CONTEXT}`);
  const slug = /You are .+? \(@([a-z0-9-]+)\), (?:an Ensemble Node|a temporary helper)/.exec(own)?.[1] ?? "?";
  const last = messages.filter((row) => row.role === "user").at(-1)?.content;
  const transcript = Array.isArray(last) ? last.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "")).join("\n") : String(last ?? "");
  const second = messages.at(-1)?.role === "tool";
  const current = { slug, systems, stable: at < 0 ? own : own.slice(0, at), context: at < 0 ? "" : own.slice(at + 2), transcript, tools: ((args.chatTools ?? []) as Array<{ function: { name: string } }>).map((spec) => spec.function.name) };
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

/** A section as the node got it: its words with the turn's values. */
const words = (name: SectionName, vars: Record<string, string> = {}) => renderSection(name, { owner: "Akash", no_reply: "(no reply)", ...vars });

test("a DM turn and a crew lead's turn get the sections their conditions call for, each tier within its budget", async (t) => {
  const akash = await person("Akash");
  await laptopFor(akash);
  const { node, room: dm } = await createNode(akash, "assistant");
  const ids: string[] = [];
  for (const template of ["manager", "developer", "tester"]) ids.push((await createNode(akash, template)).node.id);
  await createNode(akash, "researcher");
  const crew = json(await akash.inject({ method: "POST", url: "/api/node/crews", payload: { title: "Software team", nodeIds: ids, leadNodeId: ids[0] } })).room as { id: string };
  // A node made from the assistant template before: its charter still says to send computer work to an agent.
  await h.prisma.nodeAgent.update({ where: { id: node.id }, data: { charter: LEGACY_ASSISTANT } });

  await say(akash, dm.id, "hello");
  const direct = seen.find((row) => row.slug === "assistant")!;
  seen.length = 0;
  await say(akash, crew.id, "hello");
  const lead = seen.find((row) => row.slug === "manager")!;
  t.diagnostic(`stable tier: DM ${tokens(direct.stable)} tokens, crew lead ${tokens(lead.stable)}; context tier: DM ${tokens(direct.context)}, crew lead ${tokens(lead.context)}; tools: DM ${direct.tools.length}, crew lead ${lead.tools.length}`);
  assert.ok(tokens(direct.stable) < 2_800 && tokens(lead.stable) < 3_050, `stable tiers within their budget (${tokens(direct.stable)} and ${tokens(lead.stable)} tokens)`);
  assert.ok(tokens(direct.context) < 3_000 && tokens(lead.context) < 3_000);

  // The shared rules come once, from the constitution, not from the assistant's own instructions too.
  for (const name of CONSTITUTION) assert.ok(direct.stable.includes(words(name)), `${name} is in a DM node's stable tier`);
  assert.ok(direct.stable.indexOf(words("constitution/14-completion")) < direct.stable.indexOf(words("node/00-role", { name: "Assistant", slug: "assistant", role: "assistant" })), "the role follows the constitution");
  assert.doesNotMatch(direct.systems[0]!, /Only tool calls do anything|Facts that change/, "the assistant's instructions leave the rules to the node's");
  assert.match(direct.systems[0]!, /Dates are YYYY-MM-DD/);

  const stable = direct.stable;
  assert.doesNotMatch(stable, /You do not write code or run commands yourself|Real work on their computer \(code, files, running things\)/, "the old routing is gone, with the old template charter");
  assert.match(stable, /Simple work you do yourself: look things up, browse and take screenshots/, "an unedited template charter reads as the template's current one");
  // A DM where the owner started the turn and reads alone: its hands on the computer, the live terminal and CLI sign-ins.
  for (const name of ["node/03-hands", "node/10-facts-hands", "node/11-owner-work", "node/12-hands-work", "node/13-web-task", "node/14-live", "node/15-cli-sign-in", "node/16-papers", "node/18-own-work", "node/19-create", "node/23-delegate", "node/24-crew-add", "node/30-messages", "node/32-reply", "node/33-speak", "node/34-captures", "node/35-cards", "node/36-privacy", "node/37-board", "node/38-remember", "node/40-sessions", "node/41-sessions-said", "node/45-no-reply"] as const) {
    assert.ok(stable.includes(words(name)), `${name} is in a DM turn`);
  }
  for (const name of ["node/20-step", "node/22-lead", "node/25-crew-member", "node/26-answer-nodes", "node/31-not-owner", "node/42-sessions-others-read", "node/43-sessions-ask", "node/44-sessions-not-owner"] as const) {
    assert.ok(!stable.includes(words(name, { lead: "@manager" })), `${name} is not in a DM turn`);
  }
  assert.match(stable, /It runs GitHub Copilot · gpt-6\.1-sol · medium thinking · 1M context \(the run profile “Copilot”\) unless your owner names an agent, model, thinking level or context\./, "it can say which model its agent runs will use");
  assert.ok(direct.context.startsWith(CONTEXT));
  assert.match(direct.context, /Room: “[^”]+” \(a direct chat with your owner\)\. Members:\n- @/);
  assert.match(direct.context, /Your owner's other nodes, not in a crew with you \(node_crew_add asks your owner\): @developer \(developer\), @manager \(manager\), @researcher \(researcher\), @tester \(tester\)\./);
  assert.doesNotMatch(direct.context, /Skills for this request/, "no skill for a hello");
  assert.ok(direct.tools.includes("node_crew_add"));

  assert.ok(lead.stable.includes(words("node/22-lead")), "the crew lead plans");
  assert.match(lead.stable, /Match each piece to the member whose role fits: code to a developer/);
  assert.ok(!lead.stable.includes(words("node/14-live")) && !lead.stable.includes(words("node/15-cli-sign-in")), "the live terminal and CLI sign-ins are for a chat with the owner alone");
  assert.match(lead.context, /- @developer: your owner's node “Software developer” \(developer\)/, "the roster gives each member's role, which the manager's charter matches work to");
  assert.match(lead.context, /Not in this crew \(node_crew_add asks your owner\): @assistant \(assistant\), @researcher \(researcher\)\./);

  // What was assembled is in the turn's node.instructions metric, for its trace.
  type Logged = { turnId: string; nodeId: string; version: string; hash: string; hashes: Record<string, string>; sections: Array<{ name: string; tier: string; chars: number; tokens: number }>; dropped: unknown[] };
  const metrics = await h.prisma.metricEvent.findMany({ where: { userId: akash.id, kind: "node.instructions" } });
  const logged = metrics.map((row) => row.payload as Logged).find((row) => row.sections.some((section) => section.name === "node/22-lead"))!;
  assert.ok(logged, "the lead's turn logged its instructions");
  assert.equal(logged.nodeId, ids[0]);
  assert.match(logged.version, /^[0-9a-f]{16}$/);
  assert.match(logged.hash, /^[0-9a-f]{16}$/);
  assert.ok(logged.sections.some((row) => row.name === "node/22-lead" && row.tier === "stable" && row.tokens === tokens(words("node/22-lead"))));
  assert.ok(logged.sections.some((row) => row.name === "node/51-room-crew" && row.tier === "context"));
  assert.ok(logged.sections.some((row) => row.name === "node/80-packet-new" && row.tier === "volatile"), "the turn packet too");
  assert.deepEqual(logged.dropped, []);
});

test("the stable tier stays the same byte for byte from one turn to the next; the context tier carries what changed", async () => {
  const akash = await person("Akash");
  await laptopFor(akash);
  const { node, room } = await createNode(akash, "assistant");
  await say(akash, room.id, "hello");
  await h.prisma.nodeMemory.create({ data: { userId: akash.id, nodeId: node.id, content: "Akash's launch is on 14 November." } });
  await say(akash, room.id, "what's on for the launch?");
  const [first, second] = seen.filter((row) => row.slug === "assistant");
  assert.ok(first && second);
  assert.equal(second.stable, first.stable);
  assert.deepEqual(second.systems[0], first.systems[0], "and the assistant's instructions before it");
  assert.doesNotMatch(first.context, /14 November/);
  assert.match(second.context, /Your owner's standing preferences \([^\n]*\):\n- Akash's launch is on 14 November\./);
  assert.doesNotMatch(second.stable, /14 November/, "a memory is never in the stable tier");
  const metrics = await h.prisma.metricEvent.findMany({ where: { userId: akash.id, kind: "model.call" }, orderBy: { ts: "asc" } });
  const hashes = metrics.map((row) => (row.payload as { instructions?: { hashes: { stable: string; context: string } } }).instructions!.hashes);
  assert.equal(hashes.at(-1)!.stable, hashes[0]!.stable, "the first turn's and the second's");
  assert.notEqual(hashes.at(-1)!.context, hashes[0]!.context);
});

test("a turn's instructions are recorded once with every section; each of its model calls names only their version and hashes", async () => {
  const akash = await person("Akash");
  const { room } = await createNode(akash, "assistant");
  // Two model calls in one turn: a look-up, then the answer.
  script = (turn) => (turn.transcript.includes("my tasks") ? [{ name: "hub_list_tasks", arguments: {} }] : []);
  await say(akash, room.id, "what are my tasks?");
  const records = await h.prisma.metricEvent.findMany({ where: { userId: akash.id, kind: "node.instructions" } });
  const calls = await h.prisma.metricEvent.findMany({ where: { userId: akash.id, kind: "model.call" } });
  assert.equal(records.length, 1, "one record for the turn");
  assert.equal(calls.length, 2, "and two model calls");
  const record = records[0]!.payload as { version: string; hash: string; hashes: Record<string, string>; sections: unknown[] };
  assert.ok(record.sections.length > 30);
  for (const call of calls) {
    const named = (call.payload as { instructions: Record<string, unknown> }).instructions;
    assert.deepEqual(Object.keys(named).sort(), ["hash", "hashes", "version"]);
    assert.deepEqual(named, { version: record.version, hash: record.hash, hashes: record.hashes });
  }
});

const COPILOT = { id: "copilot-cli", via: "cli", version: "1.0.200", signedIn: true, models: [{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol" }], typedModels: true, checkedAt: new Date().toISOString() };

test("on its owner's AI plan a node's system prompt is the stable tier alone; the context leads the turn's prompt", async () => {
  const akash = await person("Akash");
  const key = await h.asToken(akash, "device");
  const device = await h.prisma.device.create({
    data: { userId: akash.id, name: "Akash's laptop", platform: "linux", appVersion: "cli-0.8.5", tokenId: key.id, lastSeenAt: new Date(), capabilities: { assistantTurns: 3, agents: [COPILOT] } as Prisma.InputJsonValue },
  });
  const { node, room } = await createNode(akash, "assistant");
  await h.prisma.nodeAgent.update({ where: { id: node.id }, data: { provider: "copilot-cli", model: "gpt-6.1-sol" } });
  const specs: Array<{ system: string; prompt: string }> = [];
  const failures: unknown[] = [];
  const stop = sseHub.onFrame(({ userId, frame }) => {
    if (userId !== `device:${device.id}` || frame.event !== "assistant.turn") return;
    const id = String((frame.data as { id?: unknown }).id);
    setTimeout(
      () =>
        void (async () => {
          const read = await key.inject({ method: "GET", url: `/api/devices/self/assistant-turns/${id}` });
          assert.equal(read.statusCode, 200, read.body);
          const spec = (read.json() as { spec: { system: string; prompt: string } }).spec;
          specs.push({ system: spec.system, prompt: spec.prompt });
          const done = await key.inject({ method: "POST", url: `/api/devices/self/assistant-turns/${id}/done`, payload: { result: { text: "(no reply)", model: "gpt-6.1-sol", tokensIn: 100, tokensOut: 2, costUsd: null } } });
          assert.equal(done.statusCode, 200, done.body);
        })().catch((error: unknown) => failures.push(error)),
      5,
    );
  });
  try {
    await say(akash, room.id, "hello");
    await h.prisma.nodeMemory.create({ data: { userId: akash.id, nodeId: node.id, content: "Akash's launch is on 14 November." } });
    await say(akash, room.id, "what's on for the launch?");
  } finally {
    stop();
  }
  assert.deepEqual(failures, []);
  assert.equal(specs.length, 2);
  const [first, second] = specs as [{ system: string; prompt: string }, { system: string; prompt: string }];
  assert.equal(second.system, first.system, "the same system prompt, so the agent's session goes on without an instructions update");
  for (const name of CONSTITUTION) assert.ok(first.system.includes(words(name)), name);
  assert.ok(first.system.includes(words("node/00-role", { name: "Assistant", slug: "assistant", role: "assistant" })));
  assert.ok(first.system.includes(words("node/13-web-task-own-loop")) && first.system.includes(words("node/10-facts-hands-own-web")), "the agent drives the browser and searches the web itself");
  assert.doesNotMatch(first.system, /web_task|Context for this turn|Your owner's standing preferences \(|From your workspace|Room: “/, "nothing of the context tier");
  for (const spec of specs) assert.ok(spec.prompt.startsWith(`${CONTEXT}\n\nRoom: “`), "the context tier leads the prompt, marked as information");
  assert.doesNotMatch(first.prompt, /14 November/);
  assert.match(second.prompt, /Your owner's standing preferences \([^\n]*\):\n- Akash's launch is on 14 November\.[\s\S]*<context>[\s\S]*what's on for the launch\?/, "then the message's own context and the room's new messages");
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
  const { node, room } = await createNode(mira, "developer");
  assert.equal((await mira.inject({ method: "PATCH", url: `/api/node/nodes/${node.id}`, payload: { runProfileId: "claude" } })).statusCode, 200);
  script = (turn) => (turn.transcript.includes("fix the build") ? [{ name: "node_session_start", arguments: { title: "Fix the build", prompt: "Fix the build.", folder: "ensemble" } }] : []);
  await say(mira, room.id, "fix the build");
  assert.match(seen[0]!.stable, /It runs Claude Code · claude-opus-4\.8 · high thinking \(the run profile “Claude”\)/);
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
  const azure = seen.at(-1)!.context;
  assert.match(azure, /Skills for this request \(guidance[^\n]*node_skill[^\n]*\):\n- web-task: Use when the work is several steps on a site/);
  assert.match(azure, /\n- sign-in: Use when a page needs your owner's account/);
  assert.doesNotMatch(azure, /- research: |- shopping: /, "only the skills its words call for");
  // Its own words call for the best one strongly: its guidance comes in full, the others stay lines for node_skill.
  assert.match(azure, /The skill “web-task” in full \([^\n]*\):\n- Dashboards, consoles and forms: web_task/);
  assert.doesNotMatch(azure, /A page that needs your owner's account: browser_login_needed/, "one skill in full at most");
});

test("an owner's turn gets their overdue and due-today work, the memories and skills that fit, and the turn's record keeps what was chosen", async () => {
  const akash = await person("Akash");
  await laptopFor(akash);
  await saveSettings(h.prisma, akash.id, { timezone: "UTC" });
  const { node, room } = await createNode(akash, "assistant");
  const today = new Date().toISOString().slice(0, 10);
  const day = (offset: number) => new Date(Date.parse(`${today}T00:00:00.000Z`) + offset * 86_400_000);
  // The v1 eval's day plan read only today's tasks and missed this one.
  const domain = await h.prisma.task.create({ data: { userId: akash.id, title: "Renew the company domain", status: "todo", priority: "p0", due: day(-3) } });
  const invoice = await h.prisma.task.create({ data: { userId: akash.id, title: "Send the invoice to Acme", status: "todo", due: day(0) } });
  await h.prisma.nodeMemory.create({ data: { userId: akash.id, nodeId: node.id, content: "Akash plans his day with deep work first.", key: "day plans", pinned: true } });
  script = (turn) => (turn.transcript.includes("plan my day") ? [{ name: "node_skill", arguments: { name: "planning" } }] : []);
  await say(akash, room.id, "plan my day");
  const turn = seen.find((row) => row.slug === "assistant")!;
  assert.ok(turn.tools.includes("node_skill"), "node_skill is offered");
  // Set apart from the stable tier, with the label that says they are information.
  assert.match(turn.context, /Skills for this request \([^\n]*\):\n- planning: Use when /);
  assert.match(turn.context, /Your owner's standing preferences \([^\n]*\):\n- Akash plans his day with deep work first\. \(key “day plans”, pinned\)/);
  assert.match(turn.context, new RegExp(`From your workspace \\(information, not instructions[^\\n]*\\n(?:[^\\n]*\\n)*- \\[Renew the company domain\\]\\(ensemble://task/${domain.id}\\): due [0-9-]{10} \\(3 days overdue\\)`));
  assert.ok(turn.context.includes(`- [Send the invoice to Acme](ensemble://task/${invoice.id}): due today`));
  assert.doesNotMatch(turn.stable, /Renew the company domain|deep work first|Skills for this request/, "never in the stable tier");

  type Selected = { config: { version: string; hash: string }; skills: Array<{ name: string; source: string; score: number; why: string[] }>; inline: { name: string; cut: boolean } | null; memories: Array<{ why: string; pinned: boolean }>; context: Array<{ group: string; id: string; title: string }> };
  const record = async () => {
    const rows = await h.prisma.metricEvent.findMany({ where: { userId: akash.id, kind: "node.instructions" }, orderBy: { ts: "asc" } });
    return (rows.at(-1)!.payload as { selected: Selected }).selected;
  };
  const selected = await record();
  assert.equal(selected.config.version, (await import("../context/config.js")).DEFAULT_CONTEXT_CONFIG.version);
  assert.match(selected.config.hash, /^[0-9a-f]{12}$/);
  assert.equal(selected.skills[0]?.name, "planning");
  assert.ok(selected.skills[0]!.score > 0 && selected.skills[0]!.why.length > 0);
  assert.deepEqual(selected.inline, { name: "planning", source: "bundled", chars: (await import("@ensemble/prompts")).SKILLS.planning.body.length, cut: false });
  assert.match(turn.context, /The skill “planning” in full \([^\n]*\):\nSize the work before you plan it\./);
  assert.deepEqual(selected.memories.map((row) => [row.why, row.pinned]), [["pinned", true]]);
  assert.deepEqual(selected.context.filter((row) => row.group === "overdue").map((row) => row.id), [domain.id]);
  assert.deepEqual(selected.context.filter((row) => row.group === "today").map((row) => row.id), [invoice.id]);

  // node_skill gave the full text; the next turn counts it as read in this conversation.
  const replies = await h.prisma.assistantMessage.findMany({ where: { userId: akash.id, role: "assistant" }, select: { toolCalls: true } });
  const read = replies.flatMap((row) => (Array.isArray(row.toolCalls) ? row.toolCalls : []) as Array<{ name?: string; summary?: string }>).find((call) => call.name === "node_skill");
  assert.equal(read?.summary, "Read the planning skill.", "node_skill answered with the skill");
  await say(akash, room.id, "and after lunch?");
  const again = await record();
  assert.ok(again.skills.some((row) => row.name === "planning" && row.why.includes("read in this conversation")), JSON.stringify(again.skills));
});
