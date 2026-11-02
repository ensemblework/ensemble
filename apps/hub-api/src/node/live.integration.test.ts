/**
 * Live terminals and live views, end to end (C3, docs/35 §8.17): a node opens a terminal on its
 * owner's computer and gives them a live view of it; a simulated owner's browser (the Node page's own
 * channel code: sealFor and takeover.ts, in WebCrypto) opens the card through the real Node routes
 * (`POST /api/node/takeovers {liveCardId}`), watches frames of the screen only it can open, types in it
 * while watching, takes control (the node's typing waits) and hands it back, while the computer's real
 * terminal sessions run a shell in its sandbox; the card ends with the session. The same for a node's
 * browser tab: watching shows the tab while the node keeps using it and ignores the owner's clicks,
 * control pauses the node on it and applies them. The view follows a window the tab opens (a payment
 * popup) and comes back when it closes; the node ends a view itself, or closes the tab, and the card
 * says the node did; frames come as a stream too. A computer too old for it is told to update.
 * Terminal parts skip without an OS sandbox or `script`; browser parts without a Chromium.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import test, { after, afterEach } from "node:test";
import type { LightMyRequestResponse } from "fastify";
import type { HttpUser } from "../test/http.js";
import type { RuntimeTurn } from "../lib/model-turn.js";

const scratch = mkdtempSync(join(homedir(), ".ensemble-live-"));
process.env.ENSEMBLE_REMOTE_STATE_DIR = join(scratch, "computer");
process.env.ENSEMBLE_WORKSPACE_ROOT = join(scratch, "ensemble-workspace");
process.env.ENSEMBLE_SECRET_KEY = randomBytes(32).toString("base64");

const { createHttpHarness } = await import("../test/http.js");
const h = await createHttpHarness();
const { setAskRuntimeStreamForTests } = await import("../lib/model-turn.js");
const { settleTurns } = await import("./queue.js");
const { saveSettings } = await import("../lib/settings.js");
const { RunProfile, sealFor, takeoverKeys, sealMessage, openMessage, unpackMessage, channelBase64Url } = await import("@ensemble/shared-types");
const { sseHub } = await import("../lib/sse.js");
const { updateSettings } = await import("../remote/store.js");
const { makeSealKey, saveSealKey } = await import("../credentials/seal-key.js");
const { answerNodeToolRequest } = await import("../device-tools/answer.js");
const { closeAllSessions } = await import("../device-tools/terminal-sessions.js");
const { answerTakeoverControl, answerTakeoverEnd, answerTakeoverStart, endAllTakeovers, takeoverExtend, takeoverInput, takeoverStats } = await import("../takeover/session.js");
const { answerLoginResolve } = await import("../logins/answer.js");
const { configureBrowser, browserBroker, shutdownBrowser } = await import("../browser/index.js");
const { prepareSandbox } = await import("../workspace/sandbox/spawn.js");
const { findOnPath } = await import("../capture/system.js");

const SITE_HOST = "counter.example.test";
configureBrowser({ privacy: async () => ({}), env: { ...process.env, DISPLAY: "", WAYLAND_DISPLAY: "" }, args: [`--host-resolver-rules=MAP ${SITE_HOST} 127.0.0.1`] });
const noBrowser = browserBroker().chromium(true) ? false : "no Chromium on this computer (`ensemble capture setup` installs one)";
const sandbox = await prepareSandbox();
const noTerminal = !sandbox.osSandbox ? `no OS sandbox here: ${sandbox.reason}` : process.platform === "win32" || !findOnPath("script") ? "no `script` here" : false;

let clicks = 0;
const site = createServer((request, response) => {
  response.setHeader("content-type", "text/html");
  if (request.url === "/cart") return void response.end(`<!doctype html><html><head><title>Your cart</title></head><body><button onclick="window.open('/pay', 'pay', 'width=500,height=600')">Continue</button></body></html>`);
  if (request.url === "/pay") return void response.end(`<!doctype html><html><head><title>Payment</title></head><body style="background:#123"><h1 style="color:#fff">Pay with UPI</h1></body></html>`);
  if (request.url === "/click") clicks += 1;
  response.end(`<!doctype html><html><head><title>Counter</title></head><body style="margin:0"><a href="/click" style="display:block;width:100vw;height:100vh;font:40px sans-serif">Clicks: ${clicks}</a></body></html>`);
});
await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
const SITE = `http://${SITE_HOST}:${(site.address() as { port: number }).port}`;
const NODE_SITE = "https://node.ensemblework.com";

const redisWrites: string[] = [];
for (const name of ["set", "setex", "publish", "rpush", "lpush", "hset", "sadd"]) {
  const redis = h.app.redis as unknown as Record<string, unknown>;
  const original = redis[name];
  if (typeof original !== "function") continue;
  redis[name] = (...args: unknown[]) => {
    redisWrites.push(JSON.stringify(args));
    return (original as (...a: unknown[]) => unknown).apply(redis, args);
  };
}

after(async () => {
  await endAllTakeovers("stopped").catch(() => undefined);
  await closeAllSessions("stopped").catch(() => undefined);
  await shutdownBrowser().catch(() => undefined);
  site.close();
  await h.close();
  rmSync(scratch, { recursive: true, force: true });
});

type Call = { name: string; arguments: Record<string, unknown> };
let script: (transcript: string) => { calls?: Call[]; text?: string; then?: string } = () => ({ text: "ok" });
const modelInputs: string[] = [];
setAskRuntimeStreamForTests(async (args) => {
  const messages = args.messages as Array<{ role?: string; content?: unknown }>;
  modelInputs.push(JSON.stringify(messages));
  const last = messages.filter((row) => row.role === "user").at(-1)?.content;
  const transcript = Array.isArray(last) ? last.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "")).join("\n") : String(last ?? "");
  const second = messages.at(-1)?.role === "tool";
  const step = script(transcript);
  const calls = second ? [] : (step.calls ?? []);
  const text = second ? (step.then ?? "Done.") : calls.length ? "" : (step.text ?? "ok");
  const turn: RuntimeTurn = { text, toolCalls: calls.map((call, index) => ({ id: `call-${randomBytes(4).toString("hex")}-${index}`, name: call.name, arguments: JSON.stringify(call.arguments) })), model: "test-model", credits: 0, tokensIn: 1, tokensOut: 1, reasoning: "", raw: {}, finishReason: "stop", cutOff: false };
  if (text) args.onDelta?.(text);
  return turn;
});
afterEach(async () => {
  await settleTurns();
  script = () => ({ text: "ok" });
});

const json = (response: LightMyRequestResponse) => response.json() as any;

async function person(name: string): Promise<HttpUser> {
  const user = await h.asUser();
  await h.prisma.user.update({ where: { id: user.id }, data: { name, emailVerifiedAt: new Date() } });
  return user;
}

/** The owner's computer with its key pinned, able to keep terminals and show them live, answering with the real device code. */
async function computerFor(user: HttpUser, extra: Record<string, unknown> = {}) {
  const key = await h.asToken(user, "device");
  const capabilities = { folders: ["app"], engines: ["claude-code"], nodeTools: 2, browser: 2, capture: { browser: true }, logins: 2, takeover: 3, live: 1, secrets: 2, ...extra };
  const laptop = await h.prisma.device.create({ data: { userId: user.id, name: "Mira's laptop", platform: "linux", tokenId: key.id, lastSeenAt: new Date(), capabilities: capabilities as never } });
  const sealed = saveSealKey(makeSealKey(), laptop.id);
  updateSettings({ deviceId: laptop.id, apiBase: "https://api.ensemblework.com", pairedAt: new Date().toISOString() });
  assert.equal((await key.inject({ method: "POST", url: "/api/devices/self/heartbeat", payload: { capabilities: { ...capabilities, sealKey: sealed.info } } })).statusCode, 200);
  await saveSettings(h.prisma, user.id, { runProfiles: [RunProfile.parse({ id: "main", name: "Main", engine: "claude-code", mode: "unattended", delivery: "local", deviceId: laptop.id })], defaultRunProfileId: "main" });
  const posted: string[] = [];
  const client = {
    answerCode: async (id: string, answer: unknown) => {
      await key.inject({ method: "POST", url: `/api/devices/self/code-requests/${id}`, payload: answer as never });
    },
    uploadEvidenceFile: async () => ({ result: "stored" as const }),
    toolOutput: async () => true,
    takeoverFrame: async (id: string, message: unknown) => {
      posted.push(JSON.stringify(message));
      return (await key.inject({ method: "POST", url: `/api/devices/self/takeovers/${id}/frames`, payload: message as never })).statusCode < 400;
    },
    takeoverState: async (id: string, body: unknown) => {
      await key.inject({ method: "POST", url: `/api/devices/self/takeovers/${id}/state`, payload: body as never });
    },
    liveEnded: async (liveId: string, body: unknown) => {
      await key.inject({ method: "POST", url: `/api/devices/self/live/${liveId}/ended`, payload: body as never });
    },
  };
  const db = { jobEvidence: { findMany: async () => [], count: async () => 0 }, decisionRule: { findFirst: async () => null, findMany: async () => [] }, runSecret: { findMany: async () => [] } };
  const stop = sseHub.onFrame(({ userId, frame }) => {
    if (userId !== `device:${laptop.id}`) return;
    const data = frame.data as Record<string, unknown>;
    if (frame.event === "node.tool.request") void answerNodeToolRequest({ prisma: db } as never, client as never, data);
    if (frame.event === "takeover.start") void answerTakeoverStart(client as never, data, () => null);
    if (frame.event === "takeover.input") takeoverInput(data);
    if (frame.event === "takeover.end") void answerTakeoverEnd(client as never, data);
    if (frame.event === "takeover.control") void answerTakeoverControl(client as never, data);
    if (frame.event === "takeover.extend") takeoverExtend(data);
    if (frame.event === "login.resolve") void answerLoginResolve(client as never, data);
  });
  return { key, laptop, posted, stop };
}

/** A node in the person's DM, and what it says after a message (its tools' summaries). */
async function nodeOf(user: HttpUser) {
  const node = json(await user.inject({ method: "POST", url: "/api/node/nodes", payload: { templateId: "assistant" } })) as { node: { id: string; slug: string }; room: { id: string } };
  const messages = async () => json(await user.inject({ method: "GET", url: `/api/node/rooms/${node.room.id}/messages` })).messages as Array<{ id: string; kind: string; authorNodeId: string | null; data: Record<string, any>; body: string; private: boolean }>;
  return {
    ...node,
    messages,
    async say(body: string) {
      assert.equal((await user.inject({ method: "POST", url: `/api/node/rooms/${node.room.id}/messages`, payload: { body } })).statusCode, 201);
      await settleTurns();
      const reply = (await messages()).filter((row) => row.authorNodeId && row.data?.tools).at(-1);
      return (reply?.data.tools ?? []) as Array<{ name: string; state: string; summary: string | null }>;
    },
    async cards() {
      return (await messages()).filter((row) => row.data?.type === "live");
    },
  };
}

/** The owner's browser, as the Node page runs it: opens the live card's view (or a sign-in card's), seals the secret, reads frames, sends input, switches control. */
async function ownerBrowser(user: HttpUser, liveCardId: string, target: Record<string, string> = { liveCardId }) {
  const created = await user.inject({ method: "POST", url: "/api/node/takeovers", headers: { origin: NODE_SITE }, payload: target });
  assert.equal(created.statusCode, 200, created.body);
  const { takeover, controller } = json(created) as { takeover: Record<string, any> & { id: string; tab: string; computer: { id: string }; sealKey: { kid: string; spki: string } }; controller: string };
  const headers = { origin: NODE_SITE, "x-ensemble-takeover": controller };
  const secret = new Uint8Array(randomBytes(32));
  const keys = await takeoverKeys(secret, takeover.id);
  let outSeq = 0;
  let inSeq = 0;
  return {
    takeover,
    headers,
    async start() {
      const box = await sealFor(takeover.sealKey, { purpose: "takeover", deviceId: takeover.computer.id, decisionId: takeover.id, name: takeover.tab, origin: NODE_SITE }, { k: channelBase64Url(secret) }, { ttlMs: 120_000 });
      return user.inject({ method: "POST", url: `/api/node/takeovers/${takeover.id}/start`, headers, payload: { sealed: box.sealed } });
    },
    async frame() {
      const response = await user.inject({ method: "GET", url: `/api/node/takeovers/${takeover.id}/frames?after=${inSeq}`, headers });
      assert.equal(response.statusCode, 200, response.body);
      const body = json(response) as { state: string; reason?: string; frame: { seq: number; iv: string; ct: string } | null };
      if (!body.frame) return { state: body.state, reason: body.reason, frame: null };
      inSeq = body.frame.seq;
      const opened = unpackMessage(await openMessage(keys.d2w, takeover.id, "d2w", body.frame));
      return { state: body.state, frame: { header: opened.header, payload: Buffer.from(opened.payload) } };
    },
    async send(events: unknown[]) {
      outSeq += 1;
      const message = await sealMessage(keys.w2d, takeover.id, "w2d", outSeq, new TextEncoder().encode(JSON.stringify({ events })));
      return user.inject({ method: "POST", url: `/api/node/takeovers/${takeover.id}/input`, headers, payload: message });
    },
    control(on: boolean) {
      return user.inject({ method: "POST", url: `/api/node/takeovers/${takeover.id}/control`, headers, payload: { on } });
    },
    extend() {
      return user.inject({ method: "POST", url: `/api/node/takeovers/${takeover.id}/extend`, headers });
    },
    end() {
      return user.inject({ method: "POST", url: `/api/node/takeovers/${takeover.id}/end`, headers, payload: { done: false } });
    },
    /** The frames as a stream: its events, as they come, opened here. */
    async stream(after = 0) {
      const response = await user.inject({ method: "GET", url: `/api/node/takeovers/${takeover.id}/stream?after=${after}`, headers: { ...headers, "accept-encoding": "identity" }, payloadAsStream: true });
      const events: Array<{ event: string; data: string; header?: Record<string, unknown> }> = [];
      let buffer = "";
      const done = (async () => {
        for await (const chunk of response.stream()) {
          buffer += String(chunk);
          for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const event = /^event: (\S+)/m.exec(block)?.[1] ?? "comment";
            const data = /^data: (.*)$/m.exec(block)?.[1] ?? "";
            const row: (typeof events)[number] = { event, data };
            if (event === "frame") row.header = unpackMessage(await openMessage(keys.d2w, takeover.id, "d2w", JSON.parse(data))).header;
            events.push(row);
          }
        }
      })();
      return { response, events, done };
    },
    seen(seq: number) {
      return user.inject({ method: "POST", url: `/api/node/takeovers/${takeover.id}/seen`, headers, payload: { seq } });
    },
  };
}

async function until(check: () => Promise<boolean> | boolean, what: string, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const screenText = (payload: Buffer) => (JSON.parse(payload.toString("utf8")) as { rows: Array<Array<{ t: string }>> }).rows.map((row) => row.map((run) => run.t).join("")).join("\n");

test("a live terminal: the node opens it, the owner watches and types from the web, takes control and hands it back; the card ends with the session", { skip: noTerminal, timeout: 180_000 }, async () => {
  const mira = await person("Mira");
  const computer = await computerFor(mira);
  try {
    const node = await nodeOf(mira);
    let session = "";
    script = (transcript) => (transcript.includes("open a terminal") ? { calls: [{ name: "terminal_open", arguments: { title: "Deploy" } }], then: "Open." } : { text: "ok" });
    const opened = await node.say("open a terminal");
    assert.equal(opened[0]?.name, "terminal_open");
    session = /Terminal (ts[0-9a-f]{12}) is open/.exec(opened[0]?.summary ?? "")?.[1] ?? "";
    assert.ok(session, opened[0]?.summary ?? "no summary");

    script = (transcript) => (transcript.includes("let me watch") ? { calls: [{ name: "live_view", arguments: { kind: "terminal", session } }], then: "The card is above." } : { text: "ok" });
    await node.say("let me watch it");
    await node.say("let me watch it again");
    const cards = await node.cards();
    assert.equal(cards.length, 1, "one card per session");
    const card = cards[0]!;
    assert.equal(card.kind, "text");
    assert.equal(card.private, true, "owner-only");
    assert.deepEqual(Object.keys(card.data).sort(), ["computer", "deviceId", "kind", "liveId", "session", "startedAt", "status", "title", "type"]);
    assert.deepEqual([card.data.type, card.data.kind, card.data.status, card.data.liveId, card.data.session, card.data.title, card.data.computer, card.data.deviceId], ["live", "terminal", "open", session, session, "Deploy", "Mira's laptop", computer.laptop.id]);

    // The owner opens it: watching, a terminal, sealed for the session.
    const owner = await ownerBrowser(mira, card.id);
    assert.deepEqual([owner.takeover.kind, owner.takeover.mode, owner.takeover.tab, owner.takeover.session, owner.takeover.liveCardId], ["terminal", "watch", session, session, card.id]);
    const started = await owner.start();
    assert.equal(started.statusCode, 200, started.body);
    assert.equal(json(started).takeover.state, "live");
    let first = await owner.frame();
    for (let tries = 0; !first.frame && first.state === "live" && tries < 4; tries += 1) first = await owner.frame();
    assert.ok(first.frame, "a frame came");
    assert.deepEqual([first.frame.header.t, first.frame.header.kind, first.frame.header.cols, first.frame.header.rows, first.frame.header.title], ["frame", "terminal", 120, 32, "Deploy"]);
    assert.deepEqual(Object.keys(first.frame.header.cursor as object).sort(), ["x", "y"]);
    // More time works for a terminal view too.
    const longer = await owner.extend();
    assert.equal(longer.statusCode, 200, longer.body);
    assert.equal(Date.parse(json(longer).takeover.endsAt) - Date.parse(json(started).takeover.endsAt), 15 * 60_000);

    // The owner types while watching: it is their shell.
    assert.equal((await owner.send([{ t: "tty", text: "echo owner-$((6*7))" }, { t: "tty-key", key: "Enter" }])).statusCode, 200);
    let seen = "";
    await until(async () => {
      const next = await owner.frame();
      if (next.frame) seen = screenText(next.frame.payload);
      return /^owner-42$/m.test(seen);
    }, "the owner's command on the screen");

    // The node keeps using it meanwhile, and the owner sees that too.
    script = (transcript) => (transcript.includes("run the check") ? { calls: [{ name: "terminal_send", arguments: { session, text: "echo node-$((7*6))\n" } }], then: "Done." } : { text: "ok" });
    const sent = await node.say("run the check");
    assert.equal(sent[0]?.state, "ok", JSON.stringify(sent));
    await until(async () => {
      const next = await owner.frame();
      if (next.frame) seen = screenText(next.frame.payload);
      return /^node-42$/m.test(seen);
    }, "the node's command on the screen");

    // Control: the node's typing waits; handed back, it goes on.
    const controlled = await owner.control(true);
    assert.equal(controlled.statusCode, 200, controlled.body);
    assert.equal(json(controlled).takeover.mode, "control");
    const waited = await node.say("run the check");
    assert.match(waited[0]?.summary ?? "", /taken control/);
    assert.equal(json(await owner.control(false)).takeover.mode, "watch");
    assert.equal((await node.say("run the check"))[0]?.state, "ok");

    // Stop leaves the terminal going; the node closes it and the card ends.
    assert.equal((await owner.end()).statusCode, 200);
    script = (transcript) => (transcript.includes("close it") ? { calls: [{ name: "terminal_close", arguments: { session } }], then: "Closed." } : { text: "ok" });
    await node.say("close it");
    const ended = (await node.cards())[0]!;
    assert.equal(ended.data.status, "ended");
    assert.ok(Date.parse(ended.data.endedAt) > 0);
    const again = await mira.inject({ method: "POST", url: "/api/node/takeovers", headers: { origin: NODE_SITE }, payload: { liveCardId: card.id } });
    assert.equal(again.statusCode, 410);

    // A shell that exits on the computer (the owner typed exit) ends its card through the computer.
    // Opened with live: true, its card comes at once, without a live_view call.
    script = (transcript) => (transcript.includes("another terminal") ? { calls: [{ name: "terminal_open", arguments: { live: true } }], then: "Open." } : { text: "ok" });
    const second = /Terminal (ts[0-9a-f]{12}) is open/.exec((await node.say("another terminal I can watch"))[0]?.summary ?? "")?.[1] ?? "";
    const secondCard = (await node.cards()).find((row) => row.data.session === second)!;
    assert.ok(secondCard, "the live card came with terminal_open");
    const viewer = await ownerBrowser(mira, secondCard.id);
    assert.equal((await viewer.start()).statusCode, 200);
    await viewer.send([{ t: "tty", text: "exit\r" }]);
    await until(async () => (await node.cards()).find((row) => row.id === secondCard.id)!.data.status === "ended", "the card ended by the computer");
    let gone = await viewer.frame();
    for (let tries = 0; gone.state !== "ended" && tries < 10; tries += 1) gone = await viewer.frame();
    assert.deepEqual([gone.state, gone.reason], ["ended", "ended"]);

    // The relay held no screen in the clear: only ciphertext of the latest frame.
    const relay = [redisWrites.join("\n"), computer.posted.join("\n")].join("\n");
    for (const plain of ["owner-42", "node-42"]) assert.ok(!relay.includes(Buffer.from(plain).toString("base64url")) && !relay.includes(`"${plain}`), `no ${plain} on the relay`);
    assert.ok(!modelInputs.join("\n").includes(`"kind":"terminal","cols"`), "no frame reached a model");
  } finally {
    computer.stop();
  }
});

test("a live view of the node's tab: watching shows it while the node works and ignores the owner's clicks; control pauses the node and applies them; the card ends with the tab", { skip: noBrowser, timeout: 180_000 }, async () => {
  const mira = await person("Mira");
  const computer = await computerFor(mira);
  try {
    const node = await nodeOf(mira);
    script = (transcript) => (transcript.includes("open the counter") ? { calls: [{ name: "browser_open", arguments: { url: SITE } }], then: "Open." } : { text: "ok" });
    await node.say("open the counter");
    const tab = browserBroker().status().tabs ? (await browserBroker().list(`node:${node.node.id}:own`))[0]!.tab : "";
    assert.match(tab, /^t\d+$/);
    script = (transcript) => (transcript.includes("show me live") ? { calls: [{ name: "live_view", arguments: { kind: "browser", tab } }], then: "The card is above." } : { text: "ok" });
    await node.say("show me live");
    const card = (await node.cards())[0]!;
    assert.deepEqual(Object.keys(card.data).sort(), ["computer", "deviceId", "kind", "liveId", "startedAt", "status", "tab", "title", "type"]);
    assert.deepEqual([card.data.kind, card.data.status, card.data.tab, card.data.title], ["browser", "open", tab, "Counter"]);
    assert.match(card.data.liveId, /^lv[0-9a-f]{16}$/);

    const owner = await ownerBrowser(mira, card.id);
    assert.deepEqual([owner.takeover.kind, owner.takeover.mode, owner.takeover.browser, owner.takeover.tab], ["browser", "watch", "tab", tab]);
    assert.equal((await owner.start()).statusCode, 200);
    let first = await owner.frame();
    for (let tries = 0; !first.frame && first.state === "live" && tries < 4; tries += 1) first = await owner.frame();
    assert.ok(first.frame, "a frame came");
    assert.deepEqual([first.frame.payload[0], first.frame.payload[1]], [0xff, 0xd8], "a JPEG of the tab");
    assert.equal(browserBroker().ownerTab(tab).sensitive, false, "the node keeps the tab while its owner watches");

    // Watching: a click is ignored; the node reads the page.
    const click = [{ t: "mouse", type: "down", x: 0.5, y: 0.5 }, { t: "mouse", type: "up", x: 0.5, y: 0.5 }];
    await owner.send(click);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(clicks, 0, "watching takes no input");
    script = (transcript) => (transcript.includes("read it") ? { calls: [{ name: "browser_snapshot", arguments: { tab } }], then: "Read." } : { text: "ok" });
    assert.equal((await node.say("read it"))[0]?.state, "ok");

    // Control: the node is paused on the tab; the owner's click lands.
    assert.equal(json(await owner.control(true)).takeover.mode, "control");
    assert.equal(browserBroker().ownerTab(tab).sensitive, true);
    const paused = await node.say("read it");
    assert.match(paused[0]?.summary ?? "", /sign-in or takeover/);
    await owner.send(click);
    await until(() => clicks === 1, "the owner's click");
    assert.equal(json(await owner.control(false)).takeover.mode, "watch");
    assert.equal(browserBroker().ownerTab(tab).sensitive, false, "handed back");
    assert.equal((await node.say("read it"))[0]?.state, "ok");

    // More time, as for any takeover: its end moves on the computer too.
    const extended = await owner.extend();
    assert.equal(extended.statusCode, 200, extended.body);
    assert.ok(json(extended).takeover.maxEndsAt);
    await until(() => takeoverStats(owner.takeover.id)?.endsAt === json(extended).takeover.endsAt, "the view's end moved on the computer");

    // A sign-in on the tab the owner watches: the watch makes way for the sign-in's remote view.
    script = (transcript) => (transcript.includes("sign in there") ? { calls: [{ name: "browser_login_needed", arguments: { tab, reason: "the counter needs an account" } }], then: "Waiting." } : { text: "ok" });
    await node.say("sign in there");
    const login = (await node.messages()).find((row) => row.kind === "approval" && row.data.type === "login")!;
    assert.ok(login, "the sign-in card");
    const signIn = await ownerBrowser(mira, card.id, { loginCardId: login.id });
    assert.equal((await signIn.start()).statusCode, 200);
    let made = await owner.frame();
    for (let tries = 0; made.state !== "ended" && tries < 10; tries += 1) made = await owner.frame();
    assert.deepEqual([made.state, made.reason], ["ended", "sign_in"]);
    assert.equal((await signIn.end()).statusCode, 200);
    assert.equal((await mira.inject({ method: "POST", url: `/api/node/logins/${login.id}`, headers: { origin: NODE_SITE }, payload: { action: "decline" } })).statusCode, 200);
    await settleTurns();

    // The node closes its tab: the view and the card end.
    script = (transcript) => (transcript.includes("close the tab") ? { calls: [{ name: "browser_close", arguments: { tab } }], then: "Closed." } : { text: "ok" });
    await node.say("close the tab");
    let ended = await owner.frame();
    for (let tries = 0; ended.state !== "ended" && tries < 10; tries += 1) ended = await owner.frame();
    assert.equal(ended.state, "ended");
    await until(async () => (await node.cards())[0]!.data.status === "ended", "the card ended", 20_000);
  } finally {
    computer.stop();
  }
});

test("a live view follows a window the tab opens and comes back when it closes; the node ends the view itself or closes the tab, and the card says so; frames come as a stream", { skip: noBrowser, timeout: 180_000 }, async () => {
  const mira = await person("Mira");
  const computer = await computerFor(mira);
  try {
    const node = await nodeOf(mira);
    const operation = `node:${node.node.id}:own`;
    script = (transcript) => (transcript.includes("open the cart") ? { calls: [{ name: "browser_open", arguments: { url: `${SITE}/cart` } }], then: "Open." } : { text: "ok" });
    await node.say("open the cart");
    const cart = (await browserBroker().list(operation)).find((tab) => tab.title === "Your cart")!.tab;
    script = (transcript) => (transcript.includes("show me live") ? { calls: [{ name: "live_view", arguments: { kind: "browser", tab: cart } }], then: "There." } : { text: "ok" });
    await node.say("show me live");
    const card = (await node.cards()).at(-1)!;
    const owner = await ownerBrowser(mira, card.id);
    assert.equal((await owner.start()).statusCode, 200);

    // The stream sends what /frames would, a frame at a time while the page keeps up, and says when it ends.
    // Only for the browser that opened the view, as /frames.
    const foreign = await mira.inject({ method: "GET", url: `/api/node/takeovers/${owner.takeover.id}/stream`, headers: { origin: NODE_SITE } });
    assert.deepEqual([foreign.statusCode, foreign.json().code], [403, "controller"]);
    const stream = await owner.stream();
    assert.equal(stream.response.headers["content-type"], "text/event-stream; charset=utf-8");
    assert.equal(stream.response.headers["cache-control"], "no-store, no-transform");
    assert.equal(stream.response.headers["x-accel-buffering"], "no");
    await until(() => stream.events.some((row) => row.event === "frame"), "a frame on the stream");
    assert.equal(stream.events[0]!.event, "comment", "a first comment opens it through proxies");
    assert.equal(stream.events.find((row) => row.event === "frame")!.header!.popup, false);

    // The node's click opens a payment window: it hears which tab, and the owner's view shows it.
    const ref = /button "Continue" \[ref=(\w+)\]/.exec((await browserBroker().snapshot(operation, cart)).snapshot)![1]!;
    script = (transcript) => (transcript.includes("continue") ? { calls: [{ name: "browser_click", arguments: { tab: cart, ref } }], then: "It opened." } : { text: "ok" });
    const clicked = await node.say("continue");
    const pay = /It opened a new window (t\d+) \(Payment, [^)]+\): use tab \1\./.exec(clicked[0]?.summary ?? "")?.[1];
    assert.ok(pay, clicked[0]?.summary ?? "no summary");
    await owner.seen(Number.MAX_SAFE_INTEGER);
    let shown = await owner.frame();
    for (let tries = 0; !(shown.frame?.header.popup === true) && tries < 20; tries += 1) shown = await owner.frame();
    assert.deepEqual([shown.frame?.header.popup, shown.frame?.header.title, shown.frame?.header.site], [true, "Payment", SITE_HOST]);
    // Its owner takes control: the popup is paused for the node too, and given back after.
    assert.equal(json(await owner.control(true)).takeover.mode, "control");
    await until(() => browserBroker().ownerTab(pay).sensitive, "the popup paused for the node");
    assert.equal(json(await owner.control(false)).takeover.mode, "watch");
    await until(() => !browserBroker().ownerTab(pay).sensitive, "the popup given back");

    // The window closes: the view shows its opener again.
    script = (transcript) => (transcript.includes("close the payment") ? { calls: [{ name: "browser_close", arguments: { tab: pay } }], then: "Closed." } : { text: "ok" });
    await node.say("close the payment");
    shown = await owner.frame();
    for (let tries = 0; !(shown.frame && shown.frame.header.popup === false) && tries < 20; tries += 1) shown = await owner.frame();
    assert.deepEqual([shown.frame?.header.popup, shown.frame?.header.title], [false, "Your cart"]);
    assert.equal((await node.cards()).at(-1)!.data.status, "open", "closing the popup leaves the view of its opener");

    // The node ends the view itself: the card says so, the view and the stream end, the tab stays.
    script = (transcript) => (transcript.includes("stop showing") ? { calls: [{ name: "live_view", arguments: { kind: "browser", tab: cart, stop: true } }], then: "Stopped." } : { text: "ok" });
    const stopped = await node.say("stop showing it");
    assert.match(stopped[0]?.summary ?? "", new RegExp(`Ended the live view of tab ${cart}; the tab stays open`));
    const ended = (await node.cards()).at(-1)!;
    assert.deepEqual([ended.data.status, ended.data.endedBy, ended.data.endReason], ["ended", "node", "stopped"]);
    let after = await owner.frame();
    for (let tries = 0; after.state !== "ended" && tries < 10; tries += 1) after = await owner.frame();
    assert.deepEqual([after.state, after.reason], ["ended", "live_stopped"]);
    await stream.done;
    assert.deepEqual(JSON.parse(stream.events.at(-1)!.data), { state: "ended", reason: "live_stopped" });
    assert.equal(stream.events.at(-1)!.event, "end");
    assert.equal(browserBroker().ownerTab(cart).sensitive, false, "the tab stays the node's");

    // A new view of it, then the node closes the tab: the view ends and the card says the node closed it.
    script = (transcript) => (transcript.includes("show me again") ? { calls: [{ name: "live_view", arguments: { kind: "browser", tab: cart } }], then: "There." } : { text: "ok" });
    await node.say("show me again");
    const again = (await node.cards()).at(-1)!;
    assert.notEqual(again.id, card.id);
    assert.notEqual(again.data.liveId, card.data.liveId, "a new live id after the node ended the last view");
    const viewer = await ownerBrowser(mira, again.id);
    assert.equal((await viewer.start()).statusCode, 200);
    script = (transcript) => (transcript.includes("close it") ? { calls: [{ name: "browser_close", arguments: { tab: cart } }], then: "Closed." } : { text: "ok" });
    await node.say("okay, close it");
    let closed = await viewer.frame();
    for (let tries = 0; closed.state !== "ended" && tries < 10; tries += 1) closed = await viewer.frame();
    assert.deepEqual([closed.state, closed.reason], ["ended", "closed_by_node"]);
    await until(async () => (await node.cards()).at(-1)!.data.endReason === "closed", "the card says the node closed it");
    assert.equal((await node.cards()).at(-1)!.data.endedBy, "node");
  } finally {
    computer.stop();
  }
});

test("a computer too old for live sessions: the node is told to update it, and an open card cannot be viewed", async () => {
  const old = await person("Old");
  const computer = await computerFor(old, { live: undefined, takeover: 2 });
  try {
    const node = await nodeOf(old);
    script = (transcript) => (transcript.includes("open a terminal") ? { calls: [{ name: "terminal_open", arguments: {} }], then: "Could not." } : { text: "ok" });
    const tools = await node.say("open a terminal");
    assert.match(tools[0]?.summary ?? "", /Update Ensemble on Mira's laptop/);
    // A card from before the computer went back to an older Ensemble.
    const { postMessage } = await import("./store.js");
    const { message } = await postMessage(h.prisma, { roomId: node.room.id, userId: old.id, authorKind: "node", authorNodeId: node.node.id, kind: "text", body: "live", data: { type: "live", kind: "terminal", status: "open", liveId: "ts0123456789ab", deviceId: computer.laptop.id, computer: "Mira's laptop", title: "bash", session: "ts0123456789ab", startedAt: new Date().toISOString() }, visibleTo: [old.id] });
    const refused = await old.inject({ method: "POST", url: "/api/node/takeovers", headers: { origin: NODE_SITE }, payload: { liveCardId: message.id } });
    assert.equal(refused.statusCode, 409);
    assert.equal(json(refused).code, "update");
    assert.match(json(refused).error, /Update Ensemble on Mira's laptop/);
  } finally {
    computer.stop();
  }
});
