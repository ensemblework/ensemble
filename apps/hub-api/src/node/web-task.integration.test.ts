/**
 * web_task (node/web-task.ts): a node's sub-agent for multi-step web work. It reads the tab
 * (browser_snapshot, interactive), asks the node's model at low thinking for one JSON action, and
 * does it with the node's own browser tools on its owner's computer. A sign-in goes to the owner's
 * card and the turn parks; a click that would delete, buy or send needs the owner's words; a human
 * check stops it; an older computer that does not know an input is asked again without it. The
 * computer is simulated (a small site), and so is the model, both for the node and its sub-agent.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after, afterEach } from "node:test";
import type { LightMyRequestResponse } from "fastify";
import { createHttpHarness, type HttpUser } from "../test/http.js";
import type { RuntimeTurn } from "../lib/model-turn.js";

const h = await createHttpHarness();
const { setAskRuntimeStreamForTests } = await import("../lib/model-turn.js");
const { settleTurns } = await import("./queue.js");
const { saveSettings } = await import("../lib/settings.js");
const { RunProfile } = await import("@ensemble/shared-types");
const { sseHub } = await import("../lib/sse.js");
const { WEB_TASK_PROMPT, labelOf, parseAction, riskyClick, secretField, signInPage, humanCheckPage } = await import("./web-task.js");
after(() => h.close());

type Call = { name: string; arguments: Record<string, unknown> };
type Asked = { system: string; last: string; tool: string; afterTools: boolean; effort?: string; tools: string[] };
let node: (asked: Asked) => { calls?: Call[]; text?: string } = () => ({ text: "ok" });
let web: (page: string) => string = () => '{"action":"stop","reason":"no script"}';
const asked: Asked[] = [];

setAskRuntimeStreamForTests(async (args) => {
  const messages = args.messages as Array<{ role?: string; content?: unknown }>;
  const text = (content: unknown) => (Array.isArray(content) ? content.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "")).join("\n") : String(content ?? ""));
  const current: Asked = {
    system: messages.filter((row) => row.role === "system").map((row) => text(row.content)).join("\n"),
    last: text(messages.filter((row) => row.role === "user").at(-1)?.content),
    tool: messages.at(-1)?.role === "tool" ? text(messages.at(-1)!.content) : "",
    afterTools: messages.at(-1)?.role === "tool",
    effort: args.reasoningEffort,
    tools: ((args.chatTools ?? []) as Array<{ function: { name: string } }>).map((spec) => spec.function.name),
  };
  asked.push(current);
  const sub = current.system === WEB_TASK_PROMPT;
  const reply = sub ? { text: web(current.last) } : node(current);
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
  if (turn.text && !sub) args.onDelta?.(turn.text);
  return turn;
});

afterEach(async () => {
  await settleTurns();
  asked.length = 0;
  node = () => ({ text: "ok" });
  web = () => '{"action":"stop","reason":"no script"}';
});

const json = (response: LightMyRequestResponse) => response.json() as any;
const subAgent = () => asked.filter((row) => row.system === WEB_TASK_PROMPT);

async function person(name: string): Promise<HttpUser> {
  const user = await h.asUser();
  await h.prisma.user.update({ where: { id: user.id }, data: { name, emailVerifiedAt: new Date() } });
  return user;
}

async function setUp() {
  const mira = await person("Mira");
  const key = await h.asToken(mira, "device");
  const laptop = await h.prisma.device.create({ data: { userId: mira.id, name: "Mira's laptop", platform: "linux", tokenId: key.id, lastSeenAt: new Date(), capabilities: { folders: ["app"], engines: ["claude-code"], nodeTools: 2, browser: 1, logins: 1, capture: { browser: true } } as never } });
  await saveSettings(h.prisma, mira.id, { runProfiles: [RunProfile.parse({ id: "main", name: "Main", engine: "claude-code", mode: "unattended", delivery: "local", deviceId: laptop.id })], defaultRunProfileId: "main" });
  const created = await mira.inject({ method: "POST", url: "/api/node/nodes", payload: { templateId: "assistant" } });
  assert.equal(created.statusCode, 201, created.body);
  const { node: made, room } = json(created) as { node: { id: string; slug: string }; room: { id: string } };
  return { mira, key, laptop, node: made, room };
}

async function say(user: HttpUser, roomId: string, body: string) {
  const response = await user.inject({ method: "POST", url: `/api/node/rooms/${roomId}/messages`, payload: { body } });
  assert.equal(response.statusCode, 201, response.body);
  await settleTurns();
}

type Row = { id: string; kind: string; body: string; authorNodeId: string | null; data: Record<string, any> };
const rows = async (user: HttpUser, roomId: string) => json(await user.inject({ method: "GET", url: `/api/node/rooms/${roomId}/messages` })).messages as Row[];

/** The small site the simulated computer browses: each page's title and interactive snapshot. */
const PAGES: Record<string, { title: string; snapshot: string; click?: Record<string, string> }> = {
  "https://portal.example.test/": {
    title: "Portal",
    snapshot: '- heading "Portal" [ref=e1]\n- link "Usage" [ref=e3]\n- link "Billing" [ref=e4]\n- button "Delete resource group" [ref=e5]',
    click: { e3: "https://portal.example.test/usage", e5: "https://portal.example.test/deleted" },
  },
  "https://portal.example.test/usage": { title: "Usage", snapshot: '- heading "Usage" [ref=e1]\n- table "Daily usage"\n  - row "Yesterday 42 GB" [ref=e7]' },
  "https://portal.example.test/deleted": { title: "Deleted", snapshot: '- heading "Resource group deleted" [ref=e1]' },
  "https://login.microsoftonline.com/common/oauth2": { title: "Sign in to your account", snapshot: '- heading "Sign in" [ref=e1]\n- textbox "Email, phone, or Skype" [ref=e2]\n- button "Next" [ref=e3]' },
  "https://shop.example.test/": { title: "Robot or human?", snapshot: '- heading "Robot or human?" [ref=e1]\n- button "Press & Hold" [ref=e2]' },
};

/** The simulated computer: a tab per node, the pages above; `old` refuses inputs it does not know (an older Ensemble). */
function computer(laptopId: string, key: { inject: HttpUser["inject"] }, options: { old?: boolean } = {}) {
  const heard: Array<{ name: string; input: Record<string, unknown> }> = [];
  let url = "";
  const page = () => PAGES[url] ?? { title: "Not found", snapshot: '- heading "Not found" [ref=e1]' };
  const answer = (data: { name: string; input: Record<string, unknown> }): Record<string, unknown> => {
    const { name, input } = data;
    if (options.old && ("mode" in input || "purpose" in input)) return { ok: false, error: { code: "bad_input", message: `input: Unrecognized key(s) in object: '${"mode" in input ? "mode" : "purpose"}'` } };
    if (name === "browser_open") {
      url = String(input.url);
      return { ok: true, summary: `Opened t1: ${page().title}.`, result: { tab: "t1", url, title: page().title, status: 200 } };
    }
    if (name === "browser_snapshot") return { ok: true, summary: `${page().title}\n${page().snapshot}`, result: { tab: "t1", url, title: page().title, snapshot: page().snapshot, truncated: false } };
    if (name === "browser_click") {
      const next = page().click?.[String(input.ref)];
      if (next) url = next;
      return { ok: true, summary: `Clicked ${input.ref}; the tab shows ${page().title}.`, result: { tab: "t1", url, title: page().title } };
    }
    if (name === "browser_login_needed") {
      const login = { loginId: `lg_${randomBytes(16).toString("hex")}`, origin: new URL(url).origin, tab: "t1", profile: null, reasons: [String(input.reason ?? "")], saved: false, display: false, takeover: false, expiresAt: new Date(Date.now() + 600_000).toISOString() };
      return { ok: true, summary: "The tab waits for the owner to sign in.", result: { login }, login };
    }
    return { ok: true, summary: "Done.", result: { tab: "t1", url, title: page().title } };
  };
  const stop = sseHub.onFrame(({ userId, frame }) => {
    if (userId !== `device:${laptopId}` || frame.event !== "node.tool.request") return;
    const data = frame.data as { id: string; name: string; input: Record<string, unknown> };
    heard.push({ name: data.name, input: data.input });
    setTimeout(() => void key.inject({ method: "POST", url: `/api/devices/self/code-requests/${data.id}`, payload: { status: 200, body: { evidence: [], refused: [], ...answer(data) } } }), 5);
  });
  return { heard, stop };
}

/** The node: on its owner's words it starts web_task; after it, it says what web_task returned. */
const startsWebTask = (trigger: string, input: Record<string, unknown>) => (turn: Asked) =>
  turn.afterTools ? { text: `Result: ${String(JSON.parse(turn.tool).summary ?? "nothing").split("\n")[0]}` } : turn.last.includes(trigger) ? { calls: [{ name: "web_task", arguments: input }] } : { text: "ok" };

test("web_task reads the tab, asks the model for one action at a time, and returns what it found", async () => {
  const { mira, key, laptop, node: made, room } = await setUp();
  const device = computer(laptop.id, key);
  try {
    node = startsWebTask("yesterday's usage", { goal: "Find yesterday's usage on the portal", url: "https://portal.example.test/" });
    web = (page) => (page.includes("Yesterday 42 GB") ? '{"action":"done","answer":"Yesterday\'s usage was 42 GB."}' : page.includes('link "Usage" [ref=e3]') ? '```json\n{"action":"click","ref":"e3"}\n```' : '{"action":"stop","reason":"lost"}');
    await say(mira, room.id, "check yesterday's usage on my portal");
    assert.deepEqual(device.heard.map((row) => row.name), ["browser_open", "browser_snapshot", "browser_click", "browser_snapshot"]);
    assert.deepEqual(device.heard[1]!.input, { tab: "t1", mode: "interactive", maxChars: 6000 });
    assert.deepEqual(device.heard[2]!.input, { tab: "t1", ref: "e3" });
    const steps = subAgent();
    assert.equal(steps.length, 2, "one model call per step");
    assert.ok(steps.every((row) => row.effort === "low" && row.tools.length === 0));
    assert.match(steps[0]!.last, /^Goal: Find yesterday's usage on the portal\n\nStep 1 of 8\./);
    assert.match(steps[0]!.last, /Page now \(https:\/\/portal\.example\.test\/ — Portal\):\nPortal\n- heading "Portal"/);
    assert.match(steps[1]!.last, /Done so far:\n1\. goto https:\/\/portal\.example\.test\/ → Opened t1: Portal\.\n2\. click e3 → Clicked e3; the tab shows Usage\./);
    const reply = (await rows(mira, room.id)).filter((row) => row.authorNodeId === made.id && row.kind === "text").at(-1)!;
    assert.equal(reply.body, "Result: web_task done: Yesterday's usage was 42 GB.");
    assert.deepEqual([reply.data.tools[0].name, reply.data.tools[0].state], ["web_task", "ok"]);
    const metered = await h.prisma.metricEvent.findMany({ where: { userId: mira.id, kind: "model.call" } });
    assert.equal(metered.filter((row) => String((row.payload as { title?: unknown }).title).startsWith("web_task: Find yesterday's usage")).length, 2, "each step's call is metered");
  } finally {
    device.stop();
  }
});

test("a sign-in goes to the owner's card and the turn parks; nothing is typed", async () => {
  const { mira, key, laptop, room } = await setUp();
  const device = computer(laptop.id, key);
  try {
    node = startsWebTask("Azure", { goal: "Check yesterday's resource usage in the Azure portal", url: "https://login.microsoftonline.com/common/oauth2" });
    await say(mira, room.id, "log in to my Azure console and check yesterday's resource usage");
    assert.deepEqual(device.heard.map((row) => row.name), ["browser_open", "browser_snapshot", "browser_login_needed"]);
    assert.deepEqual(device.heard[2]!.input, { tab: "t1", reason: "Sign in for: Check yesterday's resource usage in the Azure portal", purpose: "sign_in" });
    assert.equal(subAgent().length, 0, "an identity provider's page needs no model to see it");
    const card = (await rows(mira, room.id)).find((row) => row.kind === "approval" && row.data.type === "login")!;
    assert.ok(card, "the owner's sign-in card");
    assert.equal(card.data.origin, "https://login.microsoftonline.com");
    const parked = await h.prisma.assistantMessage.findFirstOrThrow({ where: { userId: mira.id, role: "assistant" }, orderBy: { createdAt: "desc" } });
    assert.match(parked.content, /^Waiting for Mira to sign in to https:\/\/login\.microsoftonline\.com/);
    assert.match(JSON.stringify(parked.toolCalls), /web_task sign in needed: Sign in to your account asks to sign in\. Your owner is asked on a card in this chat to sign in; call web_task again with tab t1/);
    assert.equal((await rows(mira, room.id)).filter((row) => row.kind === "text" && row.authorNodeId).length, 0, "no reply while it waits");
  } finally {
    device.stop();
  }
});

test("a click that would delete needs the owner's words; a human check stops it; an older computer is asked again without new inputs", async () => {
  const { mira, key, laptop, node: made, room } = await setUp();
  const device = computer(laptop.id, key);
  try {
    node = startsWebTask("resources", { goal: "Tidy the portal's resources", url: "https://portal.example.test/" });
    web = () => '{"action":"click","ref":"e5"}';
    await say(mira, room.id, "look at my portal's resources");
    assert.ok(!device.heard.some((row) => row.name === "browser_click"), "nothing deleted");
    const reply = (await rows(mira, room.id)).filter((row) => row.authorNodeId === made.id && row.kind === "text").at(-1)!;
    assert.equal(reply.body, "Result: web_task blocked: Stopped before “Delete resource group”: that would delete or cancel, and your owner's words do not ask for it. Ask them first.");

    device.heard.length = 0;
    node = startsWebTask("delete the old resource group", { goal: "Delete the old resource group", url: "https://portal.example.test/" });
    web = (page) => (page.includes("Resource group deleted") ? '{"action":"done","answer":"Deleted."}' : '{"action":"click","ref":"e5"}');
    await say(mira, room.id, "delete the old resource group on my portal");
    assert.deepEqual(device.heard.find((row) => row.name === "browser_click")?.input, { tab: "t1", ref: "e5" }, "the owner asked for it");

    device.heard.length = 0;
    asked.length = 0;
    node = startsWebTask("walmart", { goal: "Find the PS5 price", url: "https://shop.example.test/" });
    await say(mira, room.id, "find the PS5 price on walmart");
    assert.equal(subAgent().length, 0);
    assert.match((await rows(mira, room.id)).filter((row) => row.authorNodeId === made.id && row.kind === "text").at(-1)!.body, /web_task human check: The page shows a human check/);
  } finally {
    device.stop();
  }

  const older = computer(laptop.id, key, { old: true });
  try {
    node = startsWebTask("usage again", { goal: "Find yesterday's usage", url: "https://portal.example.test/" });
    web = (page) => (page.includes("Yesterday 42 GB") ? '{"action":"done","answer":"42 GB."}' : '{"action":"click","ref":"e3"}');
    await say(mira, room.id, "usage again please");
    const snapshots = older.heard.filter((row) => row.name === "browser_snapshot").map((row) => "mode" in row.input);
    assert.deepEqual(snapshots, [true, false, false], "asked once with mode, then without it");
    assert.match((await rows(mira, room.id)).filter((row) => row.authorNodeId === made.id && row.kind === "text").at(-1)!.body, /web_task done: 42 GB\./);
  } finally {
    older.stop();
  }
});

test("web_task's own rules: one JSON action, sign-in and human-check pages, secret fields and risky clicks", () => {
  assert.deepEqual(parseAction('{"action":"type","ref":"e7","text":"Madison","submit":true}'), { action: "type", ref: "e7", text: "Madison", submit: true });
  assert.ok("error" in parseAction("I will click the usage link."));
  assert.ok("error" in parseAction('{"action":"hover","ref":"e1"}'));
  assert.ok(signInPage("https://accounts.google.com/v3/signin", "- heading \"Sign in\""));
  assert.ok(signInPage("https://example.com/account", '- textbox "Password" [ref=e4]'));
  assert.ok(!signInPage("https://example.com/", '- link "Forgot password?" [ref=e4]'));
  assert.ok(humanCheckPage('- heading "Verify you are human" [ref=e1]'));
  assert.ok(!humanCheckPage("- text: This site is protected by reCAPTCHA"));
  assert.equal(labelOf('- textbox "Verification code" [ref=e8]\n- button "Verify" [ref=e9]', "e8"), 'textbox "Verification code"');
  assert.ok(secretField('textbox "Verification code"') && secretField('textbox "Card number"') && !secretField('textbox "ZIP code"'));
  assert.equal(riskyClick('button "Place order"', "check my cart total"), "buy or pay");
  assert.equal(riskyClick('button "Place order"', "order the PS5 for me"), null);
  assert.equal(riskyClick('link "Usage"', ""), null);
});
