/**
 * Taking over a tab from the web, end to end (B21, docs/35 §8.16.2), against a local site whose
 * sign-in asks for a password and then a one-time code. A node's tab waits for its owner to sign in
 * (B11); a simulated owner's browser (the Node and Hub pages' own channel code: sealFor and
 * takeover.ts, in WebCrypto) opens it through the real Node routes, while the computer's real broker,
 * takeover and login code run against a headless Chromium. The owner sees the sign-in, in the clean
 * browser the computer opens at the tab's page, in frames only their browser can open, signs in with the
 * code from their phone; the computer sees it done, moves the session into the node's tab and ends the
 * takeover, and the node carries on.
 * Also: a second browser cannot take control, a replayed or changed input is refused, the relay holds
 * no readable frame, key or keystroke, no model sees a frame or a credential, and expiry, sign-out and
 * unpairing end it. Browser parts skip without a Chromium.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test, { after, afterEach } from "node:test";
import type { LightMyRequestResponse } from "fastify";
import type { HttpUser } from "../test/http.js";
import type { RuntimeTurn } from "../lib/model-turn.js";

const scratch = mkdtempSync(join(homedir(), ".ensemble-takeover-"));
process.env.ENSEMBLE_REMOTE_STATE_DIR = join(scratch, "computer");
process.env.ENSEMBLE_SECRET_KEY = randomBytes(32).toString("base64");

const logged: string[] = [];
const logStream = new Writable({
  write(chunk, _encoding, done) {
    logged.push(String(chunk));
    done();
  },
});
for (const stream of [process.stdout, process.stderr] as const) {
  const write = stream.write.bind(stream) as (...args: unknown[]) => boolean;
  stream.write = ((chunk: unknown, ...rest: unknown[]) => {
    logged.push(typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    return write(chunk, ...rest);
  }) as typeof stream.write;
}

const { createHttpHarness } = await import("../test/http.js");
const h = await createHttpHarness({ logger: { level: "trace", stream: logStream } });
const { setAskRuntimeStreamForTests } = await import("../lib/model-turn.js");
const { settleTurns } = await import("./queue.js");
const { saveSettings } = await import("../lib/settings.js");
const { RunProfile, sealFor, takeoverKeys, sealMessage, openMessage, unpackMessage, channelBase64Url } = await import("@ensemble/shared-types");
const { sseHub } = await import("../lib/sse.js");
const { updateSettings } = await import("../remote/store.js");
const { makeSealKey, saveSealKey } = await import("../credentials/seal-key.js");
const { answerNodeToolRequest } = await import("../device-tools/answer.js");
const { answerLoginResolve } = await import("../logins/answer.js");
const { answerTakeoverEnd, answerTakeoverStart, endAllTakeovers, takeoverCleanSignIn, takeoverExtend, takeoverInput, takeoverStats } = await import("../takeover/session.js");
const { closeCleanBrowsers } = await import("../logins/clean-signin.js");
const { takeoverKeys: deviceKeys } = await import("../takeover/channel.js");
const { configureBrowser, browserBroker, shutdownBrowser } = await import("../browser/index.js");
const { sha256, SESSION_COOKIE } = await import("../lib/auth.js");

const SITE_HOST = "bank.example.test";
configureBrowser({ privacy: async () => ({}), env: { ...process.env, DISPLAY: "", WAYLAND_DISPLAY: "" }, args: [`--host-resolver-rules=MAP ${SITE_HOST} 127.0.0.1`] });
const chromium = browserBroker().chromium(true);
const noBrowser = chromium ? false : "no Chromium on this computer (`ensemble capture setup` installs one)";

const USER = "mira@example.test";
const CANARY = `pw-CANARY-${randomBytes(12).toString("hex")}`;
let code = "";
const pending = new Set<string>();
const sessions = new Set<string>();

async function form(request: IncomingMessage): Promise<URLSearchParams> {
  let text = "";
  for await (const chunk of request) text += String(chunk);
  return new URLSearchParams(text);
}
const page = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title><style>body{font:16px sans-serif;margin:24px} input{display:block;margin:8px 0;padding:8px;width:280px}</style></head><body>${body}</body></html>`;

const site = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://site");
  const cookies = request.headers.cookie ?? "";
  const session = /(?:^|;\s*)session=([a-f0-9]+)/.exec(cookies)?.[1];
  const step = /(?:^|;\s*)step=([a-f0-9]+)/.exec(cookies)?.[1];
  response.setHeader("content-type", "text/html");
  if (url.pathname === "/login" && request.method === "POST") {
    void form(request).then((fields) => {
      if (fields.get("email") !== USER || fields.get("password") !== CANARY) return void response.end(page("Sign in", "<p>Wrong email or password.</p>"));
      const token = randomBytes(16).toString("hex");
      pending.add(token);
      code = `C0DE${randomBytes(4).toString("hex").toUpperCase()}`;
      response.writeHead(303, { "set-cookie": `step=${token}; Path=/`, location: "/login/code" });
      response.end();
    });
    return;
  }
  if (url.pathname === "/login") return void response.end(page("Sign in", `<h1>Sign in to the bank</h1><form method="post" action="/login"><input name="email" type="email" autocomplete="username" aria-label="Email"><input name="password" type="password" aria-label="Password"><button>Next</button></form>`));
  if (url.pathname === "/login/code" && request.method === "POST") {
    void form(request).then((fields) => {
      if (!step || !pending.has(step) || fields.get("code") !== code) return void response.end(page("Code", "<p>That code is not right.</p>"));
      pending.delete(step);
      const token = randomBytes(16).toString("hex");
      sessions.add(token);
      response.writeHead(303, { "set-cookie": `session=${token}; Path=/; HttpOnly`, location: "/accounts" });
      response.end();
    });
    return;
  }
  if (url.pathname === "/login/code") return void response.end(page("Code", `<h1>Enter the code from your phone</h1><form method="post" action="/login/code"><input name="code" autocomplete="one-time-code" inputmode="numeric" aria-label="Code" autofocus><button>Verify</button></form>`));
  if (url.pathname === "/accounts") {
    if (!session || !sessions.has(session)) {
      response.writeHead(302, { location: "/login" });
      return void response.end();
    }
    return void response.end(page("Accounts", "<h1>Your accounts</h1><p>Current account: 2 payments waiting.</p>"));
  }
  response.statusCode = 404;
  response.end(page("Not found", "<p>Not here.</p>"));
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
  await closeCleanBrowsers().catch(() => undefined);
  await shutdownBrowser().catch(() => undefined);
  site.close();
  await h.close();
  rmSync(scratch, { recursive: true, force: true });
});

type Call = { name: string; arguments: Record<string, unknown> };
let script: (transcript: string) => { calls?: Call[]; text?: string; then?: string } = () => ({ text: "ok" });
const transcripts: string[] = [];
const modelInputs: string[] = [];
setAskRuntimeStreamForTests(async (args) => {
  const messages = args.messages as Array<{ role?: string; content?: unknown }>;
  modelInputs.push(JSON.stringify(messages));
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
  script = () => ({ text: "ok" });
  sessions.clear();
  delete process.env.ENSEMBLE_TAKEOVER_SECONDS;
});

const json = (response: LightMyRequestResponse) => response.json() as any;

async function person(name: string): Promise<HttpUser> {
  const user = await h.asUser();
  await h.prisma.user.update({ where: { id: user.id }, data: { name, emailVerifiedAt: new Date() } });
  return user;
}

/** The same person in another browser: another session cookie. */
async function anotherBrowser(user: HttpUser): Promise<HttpUser> {
  const token = randomUUID();
  const modules = (await h.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).moduleSet;
  await h.prisma.session.create({ data: { id: sha256(token), userId: user.id, expiresAt: new Date(Date.now() + 86_400_000), modules } });
  const cookie = `${SESSION_COOKIE}=${token}`;
  return { ...user, cookie, inject: (request) => h.app.inject({ ...request, headers: { ...request.headers, cookie } }) };
}

async function everyTable(): Promise<string> {
  const tables = (await h.prisma.$queryRawUnsafe(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`)) as Array<{ table_name: string }>;
  const parts: string[] = [];
  for (const { table_name } of tables) {
    const rows = (await h.prisma.$queryRawUnsafe(`SELECT row_to_json(t)::text AS row FROM "${table_name}" t`)) as Array<{ row: string }>;
    parts.push(...rows.map((item) => item.row));
  }
  return parts.join("\n");
}

const encodings = (bytes: Buffer) => [bytes.toString("base64"), bytes.toString("base64url"), bytes.toString("hex"), bytes.toString("latin1")].filter((value) => value.length >= 8);

/** Mira's computer, with its key pinned, able to take over, answering with the real device code. */
async function computerFor(user: HttpUser, extra: Record<string, unknown> = {}) {
  const key = await h.asToken(user, "device");
  const capabilities = { folders: ["app"], engines: ["claude-code"], nodeTools: 1, browser: 1, capture: { browser: true }, logins: 1, takeover: 1, secrets: 2, ...extra };
  const laptop = await h.prisma.device.create({ data: { userId: user.id, name: "Mira's laptop", platform: "linux", tokenId: key.id, lastSeenAt: new Date(), capabilities: capabilities as never } });
  const sealed = saveSealKey(makeSealKey(), laptop.id);
  updateSettings({ deviceId: laptop.id, apiBase: "https://api.ensemblework.com", pairedAt: new Date().toISOString() });
  assert.equal((await key.inject({ method: "POST", url: "/api/devices/self/heartbeat", payload: { capabilities: { ...capabilities, sealKey: sealed.info } } })).statusCode, 200);
  await saveSettings(h.prisma, user.id, { runProfiles: [RunProfile.parse({ id: "main", name: "Main", engine: "claude-code", mode: "unattended", delivery: "local", deviceId: laptop.id })], defaultRunProfileId: "main" });
  const frames: string[] = [];
  const posted: string[] = [];
  /** When each frame left the computer, by its number, and its size. */
  const postedAt = new Map<number, { at: number; bytes: number }>();
  const client = {
    answerCode: async (id: string, answer: unknown) => {
      await key.inject({ method: "POST", url: `/api/devices/self/code-requests/${id}`, payload: answer as never });
    },
    uploadEvidenceFile: async () => ({ result: "stored" as const }),
    toolOutput: async () => true,
    takeoverFrame: async (id: string, message: unknown) => {
      posted.push(JSON.stringify(message));
      const sent = message as { seq: number; ct: string };
      postedAt.set(sent.seq, { at: performance.now(), bytes: Math.floor((sent.ct.length * 3) / 4) });
      const response = await key.inject({ method: "POST", url: `/api/devices/self/takeovers/${id}/frames`, payload: message as never });
      return response.statusCode < 400;
    },
    takeoverState: async (id: string, body: unknown) => {
      await key.inject({ method: "POST", url: `/api/devices/self/takeovers/${id}/state`, payload: body as never });
    },
  };
  const db = { jobEvidence: { findMany: async () => [], count: async () => 0 }, decisionRule: { findFirst: async () => null, findMany: async () => [] }, runSecret: { findMany: async () => [] } };
  const stop = sseHub.onFrame(({ userId, frame }) => {
    if (userId !== `device:${laptop.id}`) return;
    frames.push(JSON.stringify(frame));
    const data = frame.data as Record<string, unknown>;
    if (frame.event === "node.tool.request") void answerNodeToolRequest({ prisma: db } as never, client as never, data);
    if (frame.event === "login.resolve") void answerLoginResolve(client as never, data);
    if (frame.event === "takeover.start") void answerTakeoverStart(client as never, data, () => null);
    if (frame.event === "takeover.input") takeoverInput(data);
    if (frame.event === "takeover.extend") takeoverExtend(data);
    if (frame.event === "takeover.end") void answerTakeoverEnd(client as never, data);
  });
  return { key, laptop, sealKey: sealed.info, frames, posted, postedAt, stop };
}

/** A node in Mira's DM opens the bank's accounts page; the sign-in card is raised. */
async function signInCard(user: HttpUser) {
  const node = json(await user.inject({ method: "POST", url: "/api/node/nodes", payload: { templateId: "assistant" } })) as { node: { id: string }; room: { id: string } };
  script = (transcript) => (transcript.includes("check my accounts") ? { calls: [{ name: "browser_open", arguments: { url: `${SITE}/accounts` } }], then: "Waiting for you to sign in." } : { text: "ok" });
  assert.equal((await user.inject({ method: "POST", url: `/api/node/rooms/${node.room.id}/messages`, payload: { body: "check my accounts" } })).statusCode, 201);
  await settleTurns();
  const messages = json(await user.inject({ method: "GET", url: `/api/node/rooms/${node.room.id}/messages` })).messages as Array<{ id: string; kind: string; data: Record<string, any> }>;
  const card = messages.find((row) => row.kind === "approval" && row.data.type === "login");
  assert.ok(card, "the sign-in card");
  return { node, card };
}

/** The owner's browser, as the Node page runs it: opens the takeover, seals the secret, reads frames, sends input. */
async function ownerBrowser(user: HttpUser, cardId: string) {
  const created = await user.inject({ method: "POST", url: "/api/node/takeovers", headers: { origin: NODE_SITE }, payload: { loginCardId: cardId } });
  assert.equal(created.statusCode, 200, created.body);
  const { takeover, controller } = json(created) as { takeover: { id: string; tab: string; computer: { id: string }; sealKey: { kid: string; spki: string } }; controller: string };
  const headers = { origin: NODE_SITE, "x-ensemble-takeover": controller };
  const secret = new Uint8Array(randomBytes(32));
  const keys = await takeoverKeys(secret, takeover.id);
  let outSeq = 0;
  let inSeq = 0;
  const seen: Array<{ header: Record<string, unknown>; jpeg: Buffer }> = [];
  return {
    takeover,
    controller,
    headers,
    secret: Buffer.from(secret),
    async start() {
      const box = await sealFor(takeover.sealKey, { purpose: "takeover", deviceId: takeover.computer.id, decisionId: takeover.id, name: takeover.tab, origin: NODE_SITE }, { k: channelBase64Url(secret) }, { ttlMs: 120_000 });
      return user.inject({ method: "POST", url: `/api/node/takeovers/${takeover.id}/start`, headers, payload: { sealed: box.sealed } });
    },
    /** The next frame, opened here. */
    async frame() {
      const response = await user.inject({ method: "GET", url: `/api/node/takeovers/${takeover.id}/frames?after=${inSeq}`, headers });
      assert.equal(response.statusCode, 200, response.body);
      const body = json(response) as { state: string; reason?: string; frame: { seq: number; iv: string; ct: string } | null };
      if (!body.frame) return { state: body.state, reason: body.reason, frame: null };
      inSeq = body.frame.seq;
      const opened = unpackMessage(await openMessage(keys.d2w, takeover.id, "d2w", body.frame));
      const frame = { header: opened.header, jpeg: Buffer.from(opened.payload) };
      seen.push(frame);
      return { state: body.state, frame, raw: body.frame };
    },
    /** An input message sealed with the next number, not sent yet (to send several at once, in any order). */
    async seal(events: unknown[]) {
      outSeq += 1;
      return sealMessage(keys.w2d, takeover.id, "w2d", outSeq, new TextEncoder().encode(JSON.stringify({ events })));
    },
    /** One input message; returns it as sent, to replay. */
    async send(events: unknown[], seq?: number) {
      outSeq = seq ?? outSeq + 1;
      const message = await sealMessage(keys.w2d, takeover.id, "w2d", outSeq, new TextEncoder().encode(JSON.stringify({ events })));
      const response = await user.inject({ method: "POST", url: `/api/node/takeovers/${takeover.id}/input`, headers, payload: message });
      return { response, message };
    },
    async raw(message: unknown) {
      return user.inject({ method: "POST", url: `/api/node/takeovers/${takeover.id}/input`, headers, payload: message as never });
    },
    end(done: boolean) {
      return user.inject({ method: "POST", url: `/api/node/takeovers/${takeover.id}/end`, headers, payload: { done } });
    },
    seen,
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

/** The clean browser's page the takeover shows. */
const shown = (takeoverId: string) => takeoverCleanSignIn(takeoverId)!.current!;

/** Where an element is on the page shown, as the owner would click it on the frame: a fraction of the page. */
async function spot(takeoverId: string, selector: string) {
  const page = shown(takeoverId);
  let box = await page.find(selector);
  for (let tries = 0; !box && tries < 100; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    box = await page.find(selector);
  }
  assert.ok(box, `${selector} on the page`);
  const size = await page.viewport();
  return { x: box.x / size.width, y: box.y / size.height };
}

/** A field's value on the page shown, read from a DOM snapshot by the test (Ensemble's own code never reads one). */
async function value(takeoverId: string, selector: string): Promise<string> {
  const page = shown(takeoverId) as unknown as { send(method: string, params?: Record<string, unknown>): Promise<Record<string, any>> };
  const doc = await page.send("DOM.getDocument", { depth: 0 });
  const found = await page.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
  if (!found.nodeId) return "";
  const backend = (await page.send("DOM.describeNode", { nodeId: found.nodeId })).node.backendNodeId as number;
  const snapshot = await page.send("DOMSnapshot.captureSnapshot", { computedStyles: [] });
  for (const document of snapshot.documents as Array<{ nodes: { backendNodeId: number[]; inputValue: { index: number[]; value: number[] } } }>) {
    const node = document.nodes.backendNodeId.indexOf(backend);
    if (node < 0) continue;
    const at = document.nodes.inputValue.index.indexOf(node);
    return at < 0 || document.nodes.inputValue.value[at]! < 0 ? "" : (snapshot.strings as string[])[document.nodes.inputValue.value[at]!]!;
  }
  return "";
}

test("the owner signs in from the web with a one-time code, in a clean browser: frames only their browser opens, input in order, seen done and the session moved into the node's tab; nothing readable stays on the relay", { skip: noBrowser, timeout: 240_000 }, async () => {
  const mira = await person("Mira");
  const computer = await computerFor(mira);
  const { node, card } = await signInCard(mira);
  assert.equal(card.data.takeover, true, "the card offers the browser from here");
  const tab = card.data.tab as string;
  try {
    const owner = await ownerBrowser(mira, card.id);
    // One controller at a time: the same person in another browser is refused, and a key cannot open one.
    const second = await anotherBrowser(mira);
    const refused = await second.inject({ method: "POST", url: "/api/node/takeovers", headers: { origin: NODE_SITE }, payload: { loginCardId: card.id } });
    assert.equal(refused.statusCode, 409);
    assert.equal(json(refused).code, "controlled");
    const token = await h.asToken(mira, "full");
    assert.equal((await token.inject({ method: "POST", url: "/api/node/takeovers", payload: { loginCardId: card.id } })).statusCode, 403, "never with a key");
    assert.equal((await second.inject({ method: "POST", url: `/api/node/takeovers/${owner.takeover.id}/start`, headers: owner.headers, payload: { sealed: {} } })).statusCode, 400);
    assert.equal((await second.inject({ method: "GET", url: `/api/node/takeovers/${owner.takeover.id}/frames`, headers: owner.headers })).statusCode, 403, "the capability is bound to the browser that opened it");
    assert.equal((await mira.inject({ method: "GET", url: `/api/node/takeovers/${owner.takeover.id}/frames`, headers: { ...owner.headers, "x-ensemble-takeover": "not-it" } })).statusCode, 403);

    const started = await owner.start();
    assert.equal(started.statusCode, 200, started.body);
    assert.equal(json(started).takeover.state, "live");
    assert.equal((await owner.start()).statusCode, 409, "a capability starts once");

    // The tab, as only the owner's browser can see it. A page keeps asking until the first frame comes, as here:
    // on a busy machine the first screencast frame can take longer than one long poll.
    let first = await owner.frame();
    for (let tries = 0; !first.frame && first.state === "live" && tries < 4; tries += 1) first = await owner.frame();
    assert.ok(first.frame, "a frame came");
    assert.deepEqual([first.frame.jpeg[0], first.frame.jpeg[1], first.frame.jpeg[2]], [0xff, 0xd8, 0xff], "a JPEG");
    assert.match(String(first.frame.header.url), /\/login$/);
    assert.deepEqual([first.frame.header.site, first.frame.header.mode, first.frame.header.popup], [SITE_HOST, "clean", false], "the frame says which site it shows, in the clean browser");
    assert.equal(json(started).mode ?? "clean", "clean");
    assert.equal(takeoverStats(owner.takeover.id)?.mode, "clean");
    assert.equal(browserBroker().ownerTab(tab).sensitive, true, "no agent or model sees the tab meanwhile");

    // The relay's view of it: only the latest frame, opaque.
    const keys = deviceKeys(owner.secret, owner.takeover.id);
    const stored = await (h.app.redis as unknown as { get(key: string): Promise<string | null> }).get(`ensemble:takeover:frame:${owner.takeover.id}`);
    assert.ok(stored, "the latest frame is in flight");
    assert.deepEqual(Object.keys(JSON.parse(stored)).sort(), ["ct", "iv", "seq"], "only ciphertext");

    // A person looks before acting: the clean browser has looked at the page once.
    await until(() => Boolean(takeoverCleanSignIn(owner.takeover.id)?.lastJudged), "the first look");
    // Click the email field, type; the same message again is refused, as is one changed on the way.
    const email = await spot(owner.takeover.id, 'input[name="email"]');
    await owner.send([{ t: "mouse", type: "down", ...email }, { t: "mouse", type: "up", ...email }]);
    const typed = await owner.send([{ t: "text", text: USER }]);
    await until(async () => (await value(owner.takeover.id, 'input[name="email"]')) === USER, "the email typed");
    assert.equal((await owner.raw(typed.message)).statusCode, 200, "the relay passes it on; the computer decides");
    const changed = await owner.send([{ t: "text", text: "x" }]);
    const ct = Buffer.from(changed.message.ct, "base64url");
    ct[0] = ct[0]! ^ 1;
    await owner.raw({ ...changed.message, seq: changed.message.seq + 1, ct: ct.toString("base64url") });
    await until(() => (takeoverStats(owner.takeover.id)?.refused ?? 0) >= 2, "refusals");
    await until(async () => (await value(owner.takeover.id, 'input[name="email"]')) === `${USER}x`, "the replay was not typed again; the changed message did nothing");
    await owner.send([{ t: "key", type: "down", key: "Backspace" }, { t: "key", type: "up", key: "Backspace" }], changed.message.seq + 2);
    await until(async () => (await value(owner.takeover.id, 'input[name="email"]')) === USER, "the extra letter deleted");

    const password = await spot(owner.takeover.id, 'input[name="password"]');
    await owner.send([{ t: "mouse", type: "down", ...password }, { t: "mouse", type: "up", ...password }, { t: "text", text: CANARY }, { t: "key", type: "down", key: "Enter" }, { t: "key", type: "up", key: "Enter" }]);
    await until(() => /\/login\/code$/.test(shown(owner.takeover.id).url), "the code page");
    assert.ok(code, "the site sent a code to the owner's phone");
    await until(async () => (await shown(owner.takeover.id).find('input[name="code"]')) !== null, "the code field");
    script = (transcript) => (transcript.includes("signed in to") ? { calls: [{ name: "browser_snapshot", arguments: { tab } }], then: "2 payments are waiting." } : { text: "ok" });
    // Key by key, as a phone's keyboard sends it, then Enter.
    await owner.send([...[...code].flatMap((char) => [{ t: "key", type: "down", key: char }, { t: "key", type: "up", key: char }]), { t: "key", type: "down", key: "Enter" }, { t: "key", type: "up", key: "Enter" }]);

    // Seen done: the session moves into the node's tab, and the computer ends the takeover itself.
    let ended = await owner.frame();
    for (let tries = 0; ended.state !== "ended" && tries < 20; tries += 1) ended = await owner.frame();
    assert.deepEqual([ended.state, ended.reason], ["ended", "signed_in"]);
    assert.ok(owner.seen.some((frame) => /\/login\/code$/.test(String(frame.header.url))), "the owner saw the code page");
    const stats = takeoverStats(owner.takeover.id);
    assert.equal(stats, null, "nothing left on the computer");
    assert.equal(browserBroker().ownerTab(tab).sensitive, false, "the tab is the node's again");
    assert.match(browserBroker().ownerTab(tab).page.url(), /\/accounts$/, "signed in, in the node's own browser");
    assert.ok((await browserBroker().ownerTab(tab).context.cookies()).some((cookie) => cookie.name === "session" && cookie.expires === -1), "with the site's session cookie");

    // The card: the computer told the web it is done (logins 2), or the owner's I'm done on the card finds it so.
    let current = (json(await mira.inject({ method: "GET", url: `/api/node/rooms/${node.room.id}/messages` })).messages as Array<{ id: string; data: Record<string, any> }>).find((row) => row.id === card.id)!;
    if (current.data.status === "pending") {
      const done = await mira.inject({ method: "POST", url: `/api/node/logins/${card.id}`, headers: { origin: NODE_SITE }, payload: { action: "done" } });
      await settleTurns();
      assert.equal(done.statusCode, 200, done.body);
      current = json(done).message;
    }
    await settleTurns();
    assert.equal(current.data.status, "signed_in");
    assert.ok(transcripts.some((text) => text.includes(`Your owner signed in to ${SITE} on Mira's laptop`)));
    const reply = (json(await mira.inject({ method: "GET", url: `/api/node/rooms/${node.room.id}/messages` })).messages as Array<{ authorNodeId: string | null; kind: string; data: Record<string, any> }>).filter((row) => row.authorNodeId && row.kind !== "approval").at(-1)!;
    assert.match(reply.data.tools[0].summary, /Your accounts/);

    // Inspection: no readable frame, key, keystroke or credential anywhere the relay or the model could hold it.
    const tables = await everyTable();
    assert.ok(tables.includes("node.takeover_started"), "the search reads this test's rows");
    const relay = [redisWrites.join("\n"), computer.frames.join("\n"), logged.join(""), tables].join("\n");
    for (const secret of [owner.secret, keys.d2w, keys.w2d]) for (const encoded of encodings(secret)) assert.ok(!relay.includes(encoded), "no channel secret or key on the relay");
    for (const frame of owner.seen) {
      const sample = frame.jpeg.subarray(Math.floor(frame.jpeg.length / 2), Math.floor(frame.jpeg.length / 2) + 48);
      for (const encoded of encodings(sample)) assert.ok(!relay.includes(encoded), "no frame in the clear on the relay");
    }
    assert.ok(computer.posted.length >= 2, "frames were sent");
    for (const frame of owner.seen) {
      const sample = frame.jpeg.subarray(0, 64);
      for (const encoded of encodings(sample)) assert.ok(!computer.posted.join("\n").includes(encoded), "frames leave the computer encrypted");
    }
    const everywhere = [relay, modelInputs.join("\n"), transcripts.join("\n")].join("\n");
    for (const secret of [CANARY, code]) for (const encoded of [secret, ...encodings(Buffer.from(secret))]) assert.ok(!everywhere.includes(encoded), "no typed credential anywhere");
    assert.ok(!modelInputs.join("\n").includes("/9j/") && !/image_url|input_image|"type":"image"/.test(modelInputs.join("\n")), "no model saw a frame");
  } finally {
    computer.stop();
  }
});

test("a takeover ends on expiry, on sign-out and on unpairing; a computer too old for it is told to update", { skip: noBrowser, timeout: 180_000 }, async () => {
  const mira = await person("Mira");
  const computer = await computerFor(mira);
  try {
    // Expiry: the computer ends it, and the page hears it.
    process.env.ENSEMBLE_TAKEOVER_SECONDS = "3";
    const { card } = await signInCard(mira);
    const owner = await ownerBrowser(mira, card.id);
    assert.equal((await owner.start()).statusCode, 200);
    let opening = await owner.frame();
    for (let tries = 0; !opening.frame && opening.state === "live" && tries < 4; tries += 1) opening = await owner.frame();
    assert.ok(opening.frame || opening.state === "ended", "a frame came, unless it already expired");
    await until(async () => (await owner.frame()).state === "ended", "expiry", 30_000);
    assert.equal(takeoverStats(owner.takeover.id), null);
    assert.equal(browserBroker().ownerTab(card.data.tab).sensitive, true, "the sign-in still waits, so the tab stays paused");
    delete process.env.ENSEMBLE_TAKEOVER_SECONDS;

    // Sign-out: the page that waits for frames sees it end, and so does the computer. Here the clean browser is off,
    // as where it cannot start: the tab itself is shown, and its frames say so.
    process.env.ENSEMBLE_CLEAN_SIGNIN = "off";
    const elsewhere = await anotherBrowser(mira);
    const second = await ownerBrowser(elsewhere, card.id);
    assert.equal((await second.start()).statusCode, 200);
    assert.equal(takeoverStats(second.takeover.id)?.mode, "tab");
    let shownTab = await second.frame();
    for (let tries = 0; !shownTab.frame && shownTab.state === "live" && tries < 4; tries += 1) shownTab = await second.frame();
    assert.equal(shownTab.frame?.header.mode, "tab");
    assert.equal(shownTab.frame?.header.site, SITE_HOST);
    delete process.env.ENSEMBLE_CLEAN_SIGNIN;
    const waiting = second.frame();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await h.prisma.session.delete({ where: { id: sha256(elsewhere.cookie.split("=")[1]!) } });
    const ended = await waiting;
    assert.deepEqual([ended.state, ended.reason], ["ended", "signed_out"]);
    await until(() => takeoverStats(second.takeover.id) === null, "the computer stopped");

    // Unpairing: nothing more goes through.
    const third = await ownerBrowser(mira, card.id);
    assert.equal((await third.start()).statusCode, 200);
    await h.prisma.device.update({ where: { id: computer.laptop.id }, data: { revokedAt: new Date() } });
    assert.equal((await third.send([{ t: "ping" }])).response.statusCode, 410);
    assert.equal(json(await mira.inject({ method: "GET", url: `/api/node/takeovers/${third.takeover.id}/frames`, headers: third.headers })).reason, "unpaired");
  } finally {
    delete process.env.ENSEMBLE_CLEAN_SIGNIN;
    // The unpaired computer stops its takeovers as it stops all work from the web (remote/loop.ts).
    await endAllTakeovers("stopped");
    computer.stop();
  }
  const old = await person("Old");
  const oldComputer = await computerFor(old, { takeover: undefined });
  try {
    const { card } = await signInCard(old);
    assert.equal((await old.inject({ method: "POST", url: "/api/node/takeovers", headers: { origin: NODE_SITE }, payload: { loginCardId: card.id } })).statusCode, 409);
    assert.match(json(await old.inject({ method: "POST", url: "/api/node/takeovers", headers: { origin: NODE_SITE }, payload: { loginCardId: card.id } })).error, /Update Ensemble on Mira's laptop/);
  } finally {
    oldComputer.stop();
  }
});

test("a sign-in's tab whose browser closed opens again, and its remote view starts; +15 min moves its end on the computer too, at most an hour after it started", { skip: noBrowser, timeout: 180_000 }, async () => {
  const mira = await person("Mira");
  const computer = await computerFor(mira, { takeover: 3, logins: 2 });
  try {
    const { card } = await signInCard(mira);
    const tab = card.data.tab as string;
    // Its browser goes away (as a window on a computer's screen did): before, the remote view was refused ("That tab is closed.").
    await browserBroker().ownerTab(tab).context.close();
    const owner = await ownerBrowser(mira, card.id);
    const started = await owner.start();
    assert.equal(started.statusCode, 200, started.body);
    const record = json(started).takeover as { endsAt: string; maxEndsAt: string };
    assert.ok(record.maxEndsAt, "the page knows how long it can last");
    assert.equal(browserBroker().ownerTab(tab).sensitive, true, "still paused for the owner");

    const extend = () => mira.inject({ method: "POST", url: `/api/node/takeovers/${owner.takeover.id}/extend`, headers: owner.headers });
    const once = await extend();
    assert.equal(once.statusCode, 200, once.body);
    assert.equal(Date.parse(json(once).takeover.endsAt) - Date.parse(record.endsAt), 15 * 60_000);
    await until(() => takeoverStats(owner.takeover.id)?.endsAt === json(once).takeover.endsAt, "the computer's end moved");
    let last = once;
    for (let tries = 0; tries < 5 && last.statusCode === 200; tries += 1) last = await extend();
    assert.equal(last.statusCode, 409);
    assert.equal(json(last).code, "longest");
    const longest = takeoverStats(owner.takeover.id)!.endsAt;
    assert.ok(Date.parse(longest) <= Date.parse(record.maxEndsAt) + 1_000, "never past an hour after it started");
    assert.equal((await mira.inject({ method: "POST", url: `/api/node/takeovers/${owner.takeover.id}/extend`, headers: { ...owner.headers, "x-ensemble-takeover": "not-it" } })).statusCode, 403, "only its controller");
    assert.equal((await owner.end(false)).statusCode, 200);
  } finally {
    await endAllTakeovers("stopped");
    computer.stop();
  }
});

test("input sent several at a time, its requests overtaking each other, is applied on the computer in order, every key once; how long a key and a frame take", { skip: noBrowser, timeout: 180_000 }, async () => {
  const mira = await person("Mira");
  const computer = await computerFor(mira, { takeover: 3, logins: 2 });
  try {
    const { card } = await signInCard(mira);
    const owner = await ownerBrowser(mira, card.id);
    assert.equal((await owner.start()).statusCode, 200);
    let first = await owner.frame();
    for (let tries = 0; !first.frame && first.state === "live" && tries < 4; tries += 1) first = await owner.frame();
    assert.ok(first.frame, "a frame came");
    await until(() => Boolean(takeoverCleanSignIn(owner.takeover.id)?.lastJudged), "the first look");
    const email = await spot(owner.takeover.id, 'input[name="email"]');
    await owner.send([{ t: "mouse", type: "down", ...email }, { t: "mouse", type: "up", ...email }]);
    await until(() => takeoverStats(owner.takeover.id)?.applied === 2, "the click");

    // Frames as the page reads them, meanwhile.
    const arrived = new Map<number, number>();
    let reading = true;
    const reader = (async () => {
      while (reading) {
        const next = await owner.frame();
        if (next.raw) arrived.set(next.raw.seq, performance.now());
        if (next.state === "ended") break;
      }
    })();

    const text = "mira.chen+pipelined@example.test";
    // Each key in its own message, as fast as it can go: a phone's text box sends text, a keyboard a key down and up.
    const messages = [];
    const landedAfter: number[] = [];
    for (const [index, char] of [...text].entries()) {
      const events = index % 2 ? [{ t: "key", type: "down", key: char }, { t: "key", type: "up", key: char }] : [{ t: "text", text: char }];
      messages.push(await owner.seal(events));
      landedAfter.push((landedAfter.at(-1) ?? 0) + events.length);
    }
    const sentAt = new Map<number, number>();
    const appliedAt = new Map<number, number>();
    const base = takeoverStats(owner.takeover.id)!.applied;
    const watch = setInterval(() => {
      const applied = (takeoverStats(owner.takeover.id)?.applied ?? base) - base;
      for (const [index, needed] of landedAfter.entries()) if (applied >= needed && !appliedAt.has(index + 1)) appliedAt.set(index + 1, performance.now());
    }, 1);
    // Four in flight, as the page sends them; every third pair swapped so a later one arrives first.
    const order = messages.map((_, index) => index);
    for (let index = 0; index + 1 < order.length; index += 3) [order[index], order[index + 1]] = [order[index + 1]!, order[index]!];
    const inFlight = new Set<Promise<unknown>>();
    for (const index of order) {
      const message = messages[index]!;
      sentAt.set(index + 1, performance.now());
      const request = owner.raw(message).then((response) => assert.equal(response.statusCode, 200, response.body));
      inFlight.add(request);
      void request.finally(() => inFlight.delete(request));
      if (inFlight.size >= 4) await Promise.race(inFlight);
    }
    await Promise.all(inFlight);
    await until(async () => (await value(owner.takeover.id, 'input[name="email"]')) === text, "every key, in order", 20_000);
    clearInterval(watch);
    const stats = takeoverStats(owner.takeover.id)!;
    assert.equal(stats.refused, 0, "none refused as out of order");
    // Applied in order, so the k-th event applied is the k-th key.
    const keyMs = [...appliedAt.entries()].map(([index, at]) => at - sentAt.get(index)!).sort((a, b) => a - b);
    await new Promise((resolve) => setTimeout(resolve, 500));
    reading = false;
    const frameMs = [...arrived.entries()].map(([seq, at]) => at - (computer.postedAt.get(seq)?.at ?? at)).sort((a, b) => a - b);
    const sizes = [...computer.postedAt.values()].map((item) => item.bytes).sort((a, b) => a - b);
    const pct = (list: number[], p: number) => Math.round(list[Math.min(list.length - 1, Math.floor(list.length * p))] ?? NaN);
    console.log(`takeover latency: key→applied p50 ${pct(keyMs, 0.5)} ms, p95 ${pct(keyMs, 0.95)} ms (${keyMs.length} keys, 4 in flight); frame→page p50 ${pct(frameMs, 0.5)} ms, p95 ${pct(frameMs, 0.95)} ms (${frameMs.length} frames); frame size p50 ${Math.round(pct(sizes, 0.5) / 1024)} KB, p95 ${Math.round(pct(sizes, 0.95) / 1024)} KB`);
    assert.ok(pct(keyMs, 0.5) < 150, "a key is applied within 150 ms");
    assert.equal((await owner.end(false)).statusCode, 200);
    await reader;
  } finally {
    await endAllTakeovers("stopped");
    computer.stop();
  }
});
