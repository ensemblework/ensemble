/**
 * Sign-in v2 on the server (node/logins.ts, node/login-check.ts, node/takeovers.ts; docs/35 §8.16.1).
 * A node's browser tool reaches a sign-in or a human check; the card says which (`purpose`). When the
 * owner says in the chat that they finished, the computer checks it before the node's turn and the
 * turn's note says how it went: signed in, carry on (the node is not woken twice); still not, with why,
 * the card still waiting. A site that asks for a code turns the card to `needs_code`, and the code is
 * sent sealed like a typed login. A sign-in's takeover runs in a clean browser on a computer that can.
 * The computer is simulated: it hears its frames and answers with its device key.
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
const { RunProfile, sealFor } = await import("@ensemble/shared-types");
const { sseHub } = await import("../lib/sse.js");
const { makeSealKey } = await import("../credentials/seal-key.js");
const { saysFinished } = await import("./login-check.js");
after(() => h.close());

const NODE_SITE = "https://node.ensemblework.com";

type Call = { name: string; arguments: Record<string, unknown> };
let script: (transcript: string) => { calls?: Call[]; text?: string; then?: string } = () => ({ text: "ok" });
const transcripts: string[] = [];

setAskRuntimeStreamForTests(async (args) => {
  const messages = args.messages as Array<{ role?: string; content?: unknown }>;
  const last = messages.filter((row) => row.role === "user").at(-1)?.content;
  const transcript = Array.isArray(last) ? last.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "")).join("\n") : String(last ?? "");
  const second = messages.at(-1)?.role === "tool";
  if (!second) transcripts.push(transcript);
  const step = script(transcript);
  const calls = second ? [] : (step.calls ?? []);
  const text = second ? (step.then ?? "Done.") : calls.length ? "" : (step.text ?? "ok");
  const turn: RuntimeTurn = { text, toolCalls: calls.map((call, index) => ({ id: `call-${randomBytes(4).toString("hex")}-${index}`, name: call.name, arguments: JSON.stringify(call.arguments) })), model: "test-model", credits: 0, tokensIn: 1, tokensOut: 1, reasoning: "", raw: {}, finishReason: "stop", cutOff: false };
  if (text) args.onDelta?.(text);
  return turn;
});

afterEach(async () => {
  await settleTurns();
  transcripts.length = 0;
  script = () => ({ text: "ok" });
});

const json = (response: LightMyRequestResponse) => response.json() as any;

type Heard = { event: string; data: Record<string, unknown> };
type Answer = { status: number; body: Record<string, unknown> };

/** Mira's computer: sign-in v2 (`logins` 2), its key pinned, answering each request with `respond`. */
async function computerFor(name: string, capabilities: Record<string, unknown> = {}) {
  const user = await h.asUser();
  await h.prisma.user.update({ where: { id: user.id }, data: { name, emailVerifiedAt: new Date() } });
  const key = await h.asToken(user, "device");
  const caps = { folders: ["app"], engines: ["claude-code"], nodeTools: 1, browser: 1, capture: { browser: true }, logins: 2, takeover: 2, secrets: 2, ...capabilities };
  const laptop = await h.prisma.device.create({ data: { userId: user.id, name: `${name}'s laptop`, platform: "linux", tokenId: key.id, lastSeenAt: new Date(), capabilities: caps as never } });
  const sealKey = makeSealKey();
  assert.equal((await key.inject({ method: "POST", url: "/api/devices/self/heartbeat", payload: { capabilities: { ...caps, sealKey: sealKey.info } } })).statusCode, 200);
  await saveSettings(h.prisma, user.id, { runProfiles: [RunProfile.parse({ id: "main", name: "Main", engine: "claude-code", mode: "unattended", delivery: "local", deviceId: laptop.id })], defaultRunProfileId: "main" });
  const heard: Heard[] = [];
  const computer = {
    user,
    laptop,
    key,
    heard,
    respond: (_event: string, _data: Record<string, unknown>): Answer => ({ status: 404, body: { error: "not here" } }),
    stop: () => {},
  };
  computer.stop = sseHub.onFrame(({ userId, frame }) => {
    if (userId !== `device:${laptop.id}` || !["node.tool.request", "login.resolve", "takeover.start"].includes(frame.event)) return;
    const data = frame.data as Record<string, unknown> & { id: string };
    heard.push({ event: frame.event, data });
    setTimeout(() => void key.inject({ method: "POST", url: `/api/devices/self/code-requests/${data.id}`, payload: computer.respond(frame.event, data) }), 5);
  });
  return computer;
}

/** A tab that waits for its owner, as the computer's browser tool says it. */
const waitingTab = (origin: string, purpose?: "sign_in" | "human_check") => ({
  loginId: `lg_${randomBytes(16).toString("hex")}`,
  origin,
  tab: "t1",
  profile: null,
  reasons: [purpose === "human_check" ? "the page shows a human check" : "the page has a password field"],
  saved: false,
  display: false,
  takeover: true,
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  ...(purpose ? { purpose } : {}),
});

type Computer = Awaited<ReturnType<typeof computerFor>>;

async function say(user: HttpUser, roomId: string, body: string) {
  const response = await user.inject({ method: "POST", url: `/api/node/rooms/${roomId}/messages`, payload: { body } });
  assert.equal(response.statusCode, 201, response.body);
  await settleTurns();
}

/** The node opens a page that waits for its owner (`tab`); the sign-in card it raised. */
async function cardFor(computer: Computer, tab: ReturnType<typeof waitingTab>, ask = "open my account") {
  const created = await computer.user.inject({ method: "POST", url: "/api/node/nodes", payload: { templateId: "assistant" } });
  const { node, room } = json(created) as { node: { id: string; slug: string }; room: { id: string } };
  const before = computer.respond;
  computer.respond = (event, data) => (event === "node.tool.request" ? { status: 200, body: { ok: true, summary: "Opened t1.", evidence: [], refused: [], login: tab } } : before(event, data));
  script = (transcript) => (transcript.includes(ask) ? { calls: [{ name: "browser_open", arguments: { url: `${tab.origin}/` } }], then: "Waiting for you." } : { text: "ok" });
  await say(computer.user, room.id, ask);
  computer.respond = before;
  const rows = json(await computer.user.inject({ method: "GET", url: `/api/node/rooms/${room.id}/messages` })).messages as Array<{ id: string; kind: string; body: string; data: Record<string, any> }>;
  const card = rows.filter((row) => row.kind === "approval" && row.data.type === "login").at(-1);
  assert.ok(card, "a sign-in card was raised");
  return { node, room, card };
}

const cardNow = async (id: string) => (await h.prisma.nodeMessage.findUniqueOrThrow({ where: { id } })).data as Record<string, any>;
const resolves = (computer: Computer) => computer.heard.filter((row) => row.event === "login.resolve");

/** A box sealed in the owner's browser for the card's computer (`purpose` login), as the Node page makes it. */
async function sealedFor(user: HttpUser, cardId: string, payload: Record<string, unknown>) {
  const target = json(await user.inject({ method: "GET", url: `/api/node/logins/${cardId}` }));
  assert.equal(target.route.mode, "sealed");
  return (await sealFor(target.route.sealKey, { purpose: "login", deviceId: target.computer.id, decisionId: cardId, name: target.loginId, origin: NODE_SITE }, payload)).sealed;
}

const answer = async (user: HttpUser, cardId: string, body: Record<string, unknown>) => {
  const response = await user.inject({ method: "POST", url: `/api/node/logins/${cardId}`, headers: { origin: NODE_SITE }, payload: body });
  await settleTurns();
  return response;
};

test("the owner's words that they finished: done, I signed in, try now; not questions, plans or a no", () => {
  for (const words of ["done", "Done!", "I'm done", "ok, done", "I signed in", "logged in, try now", "try again", "all set", "passed it", "I solved the captcha", "I've logged in on my phone", "ready"]) assert.equal(saysFinished(words), true, words);
  for (const words of ["not done yet", "I haven't signed in yet", "I can't log in", "set the ZIP to 53703", "sign in to walmart for me", "try again later", "what does the dashboard show?", `done ${"and then ".repeat(40)}`]) assert.equal(saysFinished(words), false, words);
});

test("“done” in the chat: the computer checks the sign-in first, and the turn hears it is signed in and carries on, woken once", async () => {
  const computer = await computerFor("Mira");
  try {
    const { node, room, card } = await cardFor(computer, waitingTab("https://portal.azure.com"), "check my azure costs");
    assert.equal(card.body, "@assistant needs you to sign in to portal.azure.com.");
    assert.deepEqual([card.data.purpose, card.data.status, card.data.codeHint], ["sign_in", "pending", null]);
    computer.respond = (event) => (event === "login.resolve" ? { status: 200, body: { status: "signed_in" } } : { status: 404, body: {} });
    script = () => ({ text: "Here are your Azure costs." });
    transcripts.length = 0;
    await say(computer.user, room.id, "done");
    const [check] = resolves(computer);
    assert.deepEqual([check!.data.action, check!.data.loginId, check!.data.decisionId], ["check", card.data.loginId, card.id]);
    const data = await cardNow(card.id);
    assert.deepEqual([data.status, data.via], ["signed_in", "chat"]);
    const heard = transcripts.find((text) => text.includes("] done"))!;
    assert.match(heard, /Update for you: Signed in to portal\.azure\.com; carry on\. Your owner signed in to https:\/\/portal\.azure\.com on Mira's laptop \(you never see how\)\. Tab t1 is yours again/);
    assert.equal(await h.prisma.nodeTurn.count({ where: { nodeId: node.id, reason: "approval" } }), 0, "no second turn for the same news");
    // Nothing left to check: the next "done" sends nothing.
    await say(computer.user, room.id, "done");
    assert.equal(resolves(computer).length, 1);
  } finally {
    computer.stop();
  }
});

test("still not signed in: the note says why and that the card still waits; other words check nothing; an older computer is asked with I'm done", async () => {
  const computer = await computerFor("Mira");
  try {
    const { room, card } = await cardFor(computer, waitingTab("https://portal.azure.com"));
    computer.respond = (event) => (event === "login.resolve" ? { status: 200, body: { status: "waiting", message: "the page still asks for a password" } } : { status: 404, body: {} });
    transcripts.length = 0;
    await say(computer.user, room.id, "I signed in, try now");
    assert.match(transcripts.at(-1)!, /Update for you: Still not signed in to portal\.azure\.com: the page still asks for a password; the card is still waiting\./);
    const data = await cardNow(card.id);
    assert.equal(data.status, "pending");
    assert.match(data.error, /Still not signed in: the page still asks for a password/);
    await say(computer.user, room.id, "what does the dashboard show?");
    assert.equal(resolves(computer).length, 1, "only words that say they finished check");
    await h.prisma.device.update({ where: { id: computer.laptop.id }, data: { capabilities: { ...(computer.laptop.capabilities as object), logins: 1 } } });
    await say(computer.user, room.id, "done");
    assert.equal(resolves(computer).at(-1)!.data.action, "done", "a computer without `check` checks with I'm done");
  } finally {
    computer.stop();
  }
});

test("a human check says so on its card; it is passed on the page, never typed, and “I solved it” lets the node carry on", async () => {
  const computer = await computerFor("Mira");
  try {
    const { room, card } = await cardFor(computer, waitingTab("https://www.walmart.com", "human_check"), "ps5 price at walmart");
    assert.equal(card.body, "@assistant needs you to pass a human check on walmart.com.");
    assert.equal(card.data.purpose, "human_check");
    assert.equal(json(await computer.user.inject({ method: "GET", url: `/api/node/logins/${card.id}` })).purpose, "human_check");
    const typed = await answer(computer.user, card.id, { action: "typed", sealed: await sealedFor(computer.user, card.id, { origin: "https://www.walmart.com", username: "mira", password: "pw" }) });
    assert.equal(typed.statusCode, 409);
    assert.match(json(typed).error, /human check is passed on the page itself/);
    assert.equal(resolves(computer).length, 0, "nothing was sent");
    computer.respond = (event) => (event === "login.resolve" ? { status: 200, body: { status: "passed" } } : { status: 404, body: {} });
    transcripts.length = 0;
    await say(computer.user, room.id, "I solved the captcha");
    assert.match(transcripts.at(-1)!, /Update for you: Passed the human check on walmart\.com; carry on\. Your owner passed the human check on https:\/\/www\.walmart\.com/);
    assert.equal((await cardNow(card.id)).status, "passed");
  } finally {
    computer.stop();
  }
});

test("a site that asks for a code: the card asks for it, the code goes sealed for the computer, and the node is woken signed in", async () => {
  const computer = await computerFor("Mira");
  try {
    const { node, card } = await cardFor(computer, waitingTab("https://login.microsoftonline.com"));
    const early = await answer(computer.user, card.id, { action: "code", sealed: await sealedFor(computer.user, card.id, { origin: "https://login.microsoftonline.com", code: "123456" }) });
    assert.equal(early.statusCode, 409);
    assert.match(json(early).error, /not asking for a code/);
    computer.respond = (event, data) =>
      event !== "login.resolve" ? { status: 404, body: {} } : data.action === "typed" ? { status: 200, body: { status: "needs_code", message: "Enter the 6-digit code from your authenticator app" } } : data.action === "code" ? { status: 200, body: { status: "signed_in" } } : { status: 200, body: { status: "waiting" } };
    const typed = await answer(computer.user, card.id, { action: "typed", sealed: await sealedFor(computer.user, card.id, { origin: "https://login.microsoftonline.com", username: "mira@example.com", password: "pw-not-kept" }) });
    assert.equal(typed.statusCode, 200, typed.body);
    assert.equal(json(typed).result.status, "needs_code");
    const asking = await cardNow(card.id);
    assert.deepEqual([asking.status, asking.codeHint], ["needs_code", "Enter the 6-digit code from your authenticator app"]);
    assert.equal(json(await computer.user.inject({ method: "GET", url: `/api/node/logins/${card.id}` })).codeHint, "Enter the 6-digit code from your authenticator app");
    const waiting = json(await computer.user.inject({ method: "GET", url: "/api/node/approvals" })).approvals as Array<{ id: string }>;
    assert.ok(waiting.some((row) => row.id === card.id), "it still waits for the owner on Needs me");
    assert.equal(json(await computer.user.inject({ method: "GET", url: "/api/shell" })).nodeApprovals, 1);
    // The page can be opened here too while it asks.
    assert.equal((await computer.user.inject({ method: "POST", url: "/api/node/takeovers", headers: { origin: NODE_SITE }, payload: { loginCardId: card.id } })).statusCode, 200);
    const sealed = await sealedFor(computer.user, card.id, { origin: "https://login.microsoftonline.com", code: "424242" });
    const coded = await answer(computer.user, card.id, { action: "code", sealed });
    assert.equal(coded.statusCode, 200, coded.body);
    assert.equal(json(coded).result.status, "signed_in");
    const sent = resolves(computer).at(-1)!;
    assert.equal(sent.data.action, "code");
    assert.deepEqual(sent.data.sealed, sealed, "the box goes as it came");
    assert.ok(!JSON.stringify(computer.heard).includes("424242"), "the code itself never crosses the server");
    const done = await cardNow(card.id);
    assert.deepEqual([done.status, done.via, done.codeHint], ["signed_in", "code", null]);
    const woken = await h.prisma.nodeTurn.findFirstOrThrow({ where: { nodeId: node.id, reason: "approval" } });
    assert.match(woken.note ?? "", /Your owner signed in to https:\/\/login\.microsoftonline\.com on Mira's laptop/);
  } finally {
    computer.stop();
  }
});

test("a sign-in's takeover runs in a clean browser on a computer that can; an older one shows the tab itself", async () => {
  for (const [level, mode] of [[2, "clean"], [1, undefined]] as const) {
    const computer = await computerFor(level === 2 ? "Mira" : "Ada", { takeover: level });
    try {
      const { card } = await cardFor(computer, waitingTab("https://accounts.google.com"));
      const created = await computer.user.inject({ method: "POST", url: "/api/node/takeovers", headers: { origin: NODE_SITE }, payload: { loginCardId: card.id } });
      assert.equal(created.statusCode, 200, created.body);
      const { takeover, controller } = json(created) as { takeover: { id: string; tab: string; mode: string; browser: string; computer: { id: string }; sealKey: Parameters<typeof sealFor>[0] }; controller: string };
      assert.equal(takeover.browser, mode ?? "tab");
      assert.equal(takeover.mode, "control", "a sign-in's takeover is always in control");
      computer.respond = (event) => (event === "takeover.start" ? { status: 200, body: { width: 1280, height: 800 } } : { status: 404, body: {} });
      const box = await sealFor(takeover.sealKey, { purpose: "takeover", deviceId: takeover.computer.id, decisionId: takeover.id, name: takeover.tab, origin: NODE_SITE }, { k: randomBytes(32).toString("base64url") }, { ttlMs: 120_000 });
      const started = await computer.user.inject({ method: "POST", url: `/api/node/takeovers/${takeover.id}/start`, headers: { origin: NODE_SITE, "x-ensemble-takeover": controller }, payload: { sealed: box.sealed } });
      assert.equal(started.statusCode, 200, started.body);
      const start = computer.heard.find((row) => row.event === "takeover.start")!;
      assert.equal(start.data.mode, mode, `takeover ${level}`);
      assert.equal(start.data.loginId, card.data.loginId);
    } finally {
      computer.stop();
    }
  }
});

test("a sign-in the computer saw end by itself: the card follows and the node is woken, but not after its own check; only that computer moves it", async () => {
  const computer = await computerFor("Mira");
  try {
    const { node, card } = await cardFor(computer, waitingTab("https://portal.azure.com"), "check my azure usage");
    const post = (loginId: string, body: Record<string, unknown>, by = computer.key) => by.inject({ method: "POST", url: `/api/devices/self/logins/${loginId}/state`, payload: body });

    // A problem to show while it still waits.
    assert.equal((await post(card.data.loginId, { status: "waiting", message: "The site asks for an approval on your phone.", via: "takeover" })).statusCode, 200);
    assert.deepEqual([(await cardNow(card.id)).status, (await cardNow(card.id)).error], ["pending", "The site asks for an approval on your phone."]);

    // Another account's computer and an unknown sign-in move nothing.
    const other = await computerFor("Ada");
    assert.equal((await post(card.data.loginId, { status: "signed_in" }, other.key)).statusCode, 404);
    other.stop();
    assert.equal((await post(`lg_${randomBytes(16).toString("hex")}`, { status: "signed_in" })).statusCode, 404);
    assert.equal((await cardNow(card.id)).status, "pending");

    // Seen done in the remote view: signed in, and the node goes on.
    assert.equal((await post(card.data.loginId, { status: "signed_in", via: "takeover" })).statusCode, 200);
    await settleTurns();
    const data = await cardNow(card.id);
    assert.deepEqual([data.status, data.via, data.error], ["signed_in", "takeover", null]);
    assert.equal(await h.prisma.nodeTurn.count({ where: { nodeId: node.id, reason: "approval" } }), 1, "the node is woken once");
    // Late news changes nothing.
    assert.equal((await post(card.data.loginId, { status: "expired" })).statusCode, 200);
    assert.equal((await cardNow(card.id)).status, "signed_in");

    // After the node's own browser_login_check it is not woken again: the tool already told it.
    const second = await cardFor(computer, waitingTab("https://walmart.com", "human_check"), "find the ps5 at walmart");
    assert.equal((await post(second.card.data.loginId, { status: "signed_in", via: "check" })).statusCode, 200);
    await settleTurns();
    assert.deepEqual([(await cardNow(second.card.id)).status, (await cardNow(second.card.id)).via], ["passed", "check"], "a human check passes, it is never a sign-in");
    assert.equal(await h.prisma.nodeTurn.count({ where: { nodeId: second.node.id, reason: "approval" } }), 0);
  } finally {
    computer.stop();
  }
});
