/**
 * Sign-ins handed to the owner, end to end (B11, docs/35 §8.16), against a local test site with a
 * sign-in form and a session cookie. A node's browser tool and a run's agent reach a page that wants
 * the owner's account; the computer's real broker, login and answer code run against a headless
 * Chromium, over a simulated event stream and the real device and Node routes. The owner answers on
 * the card: a login typed on the web (sealed in the browser for the computer's key), the login saved
 * on the computer, "I'm done" after signing in there, or Not now. The same work goes on, signed in, and
 * hears only that. A canary password is searched for in every table, log line, Redis write, frame,
 * model input, tool result and file the test can reach: it is in none of them, raw or encoded.
 * Browser parts skip without a Chromium.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test, { after, afterEach } from "node:test";
import type { LightMyRequestResponse } from "fastify";
import type { HttpUser } from "../test/http.js";
import type { RuntimeTurn } from "../lib/model-turn.js";

const scratch = mkdtempSync(join(homedir(), ".ensemble-logins-"));
// The simulated computer's own data folder: its key, saved logins, browser profile and evidence.
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
const { RunProfile, sealFor } = await import("@ensemble/shared-types");
const { sseHub } = await import("../lib/sse.js");
const { updateSettings } = await import("../remote/store.js");
const { makeSealKey, saveSealKey } = await import("../credentials/seal-key.js");
const { answerNodeToolRequest } = await import("../device-tools/answer.js");
const { answerLoginResolve, loginResolution } = await import("../logins/answer.js");
const { configureBrowser, browserBroker, shutdownBrowser } = await import("../browser/index.js");
const { runBrowserTool } = await import("../browser/tools.js");
const { saveLogin, loginsPath, listLogins } = await import("../logins/store.js");
const { setRunLoginSink, awaitRunLogin } = await import("../logins/run.js");

// The test site answers as signin.example.test (another site, where the broker raises sign-ins by itself) and as 127.0.0.1 (this computer's own address, where it only hints).
const SITE_HOST = "signin.example.test";
configureBrowser({ privacy: async () => ({}), env: { ...process.env, DISPLAY: "", WAYLAND_DISPLAY: "" }, args: [`--host-resolver-rules=MAP ${SITE_HOST} 127.0.0.1`] });
const chromium = browserBroker().chromium(true);
const noBrowser = chromium ? false : "no Chromium on this computer (`ensemble capture setup` installs one)";

const USER = "mira@example.test";
const CANARY = `pw-CANARY-${randomBytes(12).toString("hex")}`;
const sessions = new Set<string>();
let password = CANARY;

async function form(request: IncomingMessage): Promise<URLSearchParams> {
  let text = "";
  for await (const chunk of request) text += String(chunk);
  return new URLSearchParams(text);
}

const page = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
const LOGIN_FORM = (error = "") =>
  page("Sign in", `<h1>Sign in to Ledger</h1>${error ? `<p role="alert">${error}</p>` : ""}<form method="post" action="/login"><label>Email <input name="email" type="email" autocomplete="username"></label><label>Password <input name="password" type="password" autocomplete="current-password"></label><button type="submit">Sign in</button></form>`);

const site = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://site");
  const cookie = /(?:^|;\s*)session=([a-f0-9]+)/.exec(request.headers.cookie ?? "")?.[1];
  response.setHeader("content-type", "text/html");
  if (url.pathname === "/login" && request.method === "POST") {
    void form(request).then((fields) => {
      if (fields.get("email") === USER && fields.get("password") === password) {
        const token = randomBytes(16).toString("hex");
        sessions.add(token);
        response.writeHead(303, { "set-cookie": `session=${token}; Path=/; HttpOnly`, location: "/dashboard" });
        response.end();
        return;
      }
      response.end(LOGIN_FORM("That email and password do not match."));
    });
    return;
  }
  if (url.pathname === "/login") return void response.end(LOGIN_FORM());
  if (url.pathname === "/dashboard") {
    if (!cookie || !sessions.has(cookie)) {
      response.writeHead(302, { location: "/login" });
      return void response.end();
    }
    return void response.end(page("Ledger", `<h1>Welcome back</h1><p>3 invoices are due this week.</p>`));
  }
  response.statusCode = 404;
  response.end(page("Not found", "<p>Not here.</p>"));
});
await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
const port = (site.address() as { port: number }).port;
const OTHER_SITE = `http://${SITE_HOST}:${port}`;
const OWN_SITE = `http://127.0.0.1:${port}`;
const NODE_SITE = "https://node.ensemblework.com";

// Every Redis write the API makes.
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
  setRunLoginSink(null);
  await shutdownBrowser().catch(() => undefined);
  site.close();
  await h.close();
  rmSync(scratch, { recursive: true, force: true });
});

type Call = { name: string; arguments: Record<string, unknown> };
type Seen = { transcript: string };
let script: (turn: Seen) => { calls?: Call[]; text?: string; then?: string } = () => ({ text: "ok" });
const seen: Seen[] = [];
/** Everything every model call was given. */
const modelInputs: string[] = [];

setAskRuntimeStreamForTests(async (args) => {
  const messages = args.messages as Array<{ role?: string; content?: unknown }>;
  modelInputs.push(JSON.stringify(messages));
  const last = messages.filter((row) => row.role === "user").at(-1)?.content;
  const transcript = Array.isArray(last) ? last.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "")).join("\n") : String(last ?? "");
  const second = messages.at(-1)?.role === "tool";
  const current: Seen = { transcript };
  if (!second) seen.push(current);
  const step = script(current);
  const calls = second ? [] : (step.calls ?? []);
  const text = second ? (step.then ?? "Done.") : calls.length ? "" : (step.text ?? "ok");
  const turn: RuntimeTurn = { text, toolCalls: calls.map((call, index) => ({ id: `call-${randomBytes(4).toString("hex")}-${index}`, name: call.name, arguments: JSON.stringify(call.arguments) })), model: "test-model", credits: 0, tokensIn: 10, tokensOut: 5, reasoning: "", raw: {}, finishReason: "stop", cutOff: false };
  if (text) args.onDelta?.(text);
  return turn;
});

afterEach(async () => {
  await settleTurns();
  seen.length = 0;
  script = () => ({ text: "ok" });
  password = CANARY;
  // Each test starts signed out of the site (the browser profile keeps its cookie; the site forgets the session).
  sessions.clear();
});

const json = (response: LightMyRequestResponse) => response.json() as any;

async function person(name: string): Promise<HttpUser> {
  const user = await h.asUser();
  await h.prisma.user.update({ where: { id: user.id }, data: { name, emailVerifiedAt: new Date() } });
  return user;
}

/** Every row of every table in the API's database, as JSON text. */
async function everyTable(): Promise<string> {
  const tables = (await h.prisma.$queryRawUnsafe(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`)) as Array<{ table_name: string }>;
  assert.ok(tables.length > 50, "every table is searched");
  const parts: string[] = [];
  for (const { table_name } of tables) {
    const rows = (await h.prisma.$queryRawUnsafe(`SELECT row_to_json(t)::text AS row FROM "${table_name}" t`)) as Array<{ row: string }>;
    parts.push(...rows.map((item) => item.row));
  }
  return parts.join("\n");
}

/** Every file in a folder, as text (binary files too: a value would show in them as bytes). */
function everyFile(root: string, skip: (path: string) => boolean = () => false): string {
  const parts: string[] = [];
  const walk = (dir: string) => {
    for (const name of existsSync(dir) ? readdirSync(dir) : []) {
      const path = join(dir, name);
      if (skip(path)) continue;
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile() && stat.size < 50_000_000) parts.push(readFileSync(path).toString("latin1"));
    }
  };
  walk(root);
  return parts.join("\n");
}

function assertNoCanary(everything: string, what: string): void {
  assert.ok(!everything.includes(CANARY), `the canary is not in ${what}`);
  for (const encoded of [Buffer.from(CANARY).toString("base64"), Buffer.from(CANARY).toString("base64url"), Buffer.from(CANARY).toString("hex"), encodeURIComponent(CANARY), Buffer.from(CANARY, "utf16le").toString("latin1")]) {
    assert.ok(!everything.includes(encoded), `nor encoded, in ${what}`);
  }
}

/**
 * Mira's computer: its sealing key pinned on the web, hearing its event stream and answering with the
 * real device code (browser tools, sign-in answers), posting back through the real device routes.
 */
async function computerFor(user: HttpUser) {
  const key = await h.asToken(user, "device");
  const capabilities = { folders: ["app"], engines: ["claude-code"], nodeTools: 1, browser: 1, capture: { browser: true }, logins: 1, secrets: 2 };
  const laptop = await h.prisma.device.create({ data: { userId: user.id, name: "Mira's laptop", platform: "linux", tokenId: key.id, lastSeenAt: new Date(), capabilities: capabilities as never } });
  const sealKey = makeSealKey();
  const saved = saveSealKey(sealKey, laptop.id);
  updateSettings({ deviceId: laptop.id, apiBase: "https://api.ensemblework.com", pairedAt: new Date().toISOString() });
  const beat = await key.inject({ method: "POST", url: "/api/devices/self/heartbeat", payload: { capabilities: { ...capabilities, sealKey: saved.info } } });
  assert.equal(beat.statusCode, 200, beat.body);
  await saveSettings(h.prisma, user.id, { runProfiles: [RunProfile.parse({ id: "main", name: "Main", engine: "claude-code", mode: "unattended", delivery: "local", deviceId: laptop.id })], defaultRunProfileId: "main" });
  const frames: string[] = [];
  const answers: string[] = [];
  const client = {
    answerCode: async (id: string, answer: unknown) => {
      answers.push(JSON.stringify(answer));
      await key.inject({ method: "POST", url: `/api/devices/self/code-requests/${id}`, payload: answer as never });
    },
    uploadEvidenceFile: async () => ({ result: "stored" as const }),
    toolOutput: async () => true,
  };
  const db = { jobEvidence: { findMany: async () => [], count: async () => 0 }, decisionRule: { findFirst: async () => null, findMany: async () => [] }, runSecret: { findMany: async () => [] } };
  const stop = sseHub.onFrame(({ userId, frame }) => {
    if (userId !== `device:${laptop.id}`) return;
    frames.push(JSON.stringify(frame));
    const data = frame.data as Record<string, unknown>;
    if (frame.event === "node.tool.request") void answerNodeToolRequest({ prisma: db } as never, client as never, data);
    if (frame.event === "login.resolve") void answerLoginResolve(client as never, data);
  });
  return { key, laptop, sealKey: saved.info, frames, answers, stop };
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

type Row = { id: string; kind: string; authorNodeId: string | null; body: string; data: Record<string, any> };

async function messages(user: HttpUser, roomId: string): Promise<Row[]> {
  return json(await user.inject({ method: "GET", url: `/api/node/rooms/${roomId}/messages` })).messages as Row[];
}

async function loginCard(user: HttpUser, roomId: string): Promise<Row> {
  const card = (await messages(user, roomId)).filter((row) => row.kind === "approval" && row.data.type === "login").at(-1);
  assert.ok(card, "a sign-in card was raised");
  return card;
}

async function answer(user: HttpUser, cardId: string, body: Record<string, unknown>) {
  const response = await user.inject({ method: "POST", url: `/api/node/logins/${cardId}`, headers: { origin: NODE_SITE }, payload: body });
  await settleTurns();
  return response;
}

test("a site that wants the owner's account pauses the tab and asks them; a login typed on the web, sealed for the computer, signs in and the node carries on, and the password is nowhere", { skip: noBrowser, timeout: 240_000 }, async () => {
  const mira = await person("Mira");
  const computer = await computerFor(mira);
  const { node, room } = await createNode(mira);
  try {
    script = (turn) => (turn.transcript.includes("check my invoices") ? { calls: [{ name: "browser_open", arguments: { url: `${OTHER_SITE}/dashboard` } }], then: "I need you to sign in first." } : { text: "ok" });
    await say(mira, room.id, "check my invoices");
    // The turn waits for the owner's sign-in: it ends without a reply, what it did kept in its conversation.
    assert.deepEqual((await messages(mira, room.id)).filter((row) => row.authorNodeId === node.id && row.kind === "text"), [], "no reply while the card waits");
    const parked = await h.prisma.assistantMessage.findFirstOrThrow({ where: { userId: mira.id, role: "assistant" }, orderBy: { createdAt: "desc" } });
    assert.ok(parked.content.includes(`Waiting for Mira to sign in to ${OTHER_SITE} on Mira's laptop`), parked.content);
    const openTool = (parked.toolCalls as Array<{ name: string; state: string; summary: string | null }>)[0]!;
    assert.equal(openTool.state, "ok");
    assert.match(openTool.summary ?? "", /needs the owner to sign in to http:\/\/signin\.example\.test/);
    assert.match(openTool.summary ?? "", /asked on a card in this chat/);
    const tabId = (await loginCard(mira, room.id)).data.tab as string;

    script = (turn) => (turn.transcript.includes("read it anyway") ? { calls: [{ name: "browser_snapshot", arguments: { tab: tabId } }, { name: "browser_screenshot", arguments: { tab: tabId } }], then: "It is paused." } : { text: "ok" });
    await say(mira, room.id, "read it anyway");
    const blocked = (await messages(mira, room.id)).filter((row) => row.authorNodeId === node.id && row.kind !== "approval").at(-1)!;
    const tools = blocked.data.tools as Array<{ name: string; state: string; summary: string | null }>;
    assert.deepEqual(tools.map((tool) => tool.state), ["failed", "failed"], "nothing reads or captures the tab while it waits");
    assert.match(tools[0]!.summary ?? "", /sign-in or takeover step/);

    const card = await loginCard(mira, room.id);
    assert.deepEqual((await h.prisma.nodeMessage.findUniqueOrThrow({ where: { id: card.id } })).visibleTo, [mira.id], "only the owner sees it");
    assert.equal(card.body, `@${node.slug} needs you to sign in to ${OTHER_SITE} on Mira's laptop.`);
    assert.equal(card.data.status, "pending");
    assert.equal(card.data.origin, OTHER_SITE);
    assert.deepEqual([card.data.saved, card.data.display], [false, false], "no saved login, no screen: the card offers typing it");
    assert.ok((card.data.reasons as string[]).includes("the page has a password field"));
    const needs = json(await mira.inject({ method: "GET", url: "/api/node/approvals" })).approvals as Array<{ id: string }>;
    assert.ok(needs.some((row) => row.id === card.id), "it is on Needs me (Node and the Hub)");
    // Signing in on the computer needs a screen; this one has none.
    assert.equal((await answer(mira, card.id, { action: "local" })).statusCode, 409);

    const target = json(await mira.inject({ method: "GET", url: `/api/node/logins/${card.id}` }));
    assert.equal(target.route.mode, "sealed");
    assert.equal(target.route.sealKey.kid, computer.sealKey.kid);
    const box = (payload: Record<string, unknown>, over: Partial<{ decisionId: string; name: string; origin: string }> = {}) =>
      sealFor(target.route.sealKey, { purpose: "login", deviceId: computer.laptop.id, decisionId: card.id, name: card.data.loginId, origin: NODE_SITE, ...over }, payload);

    // A box for another card is refused before it goes anywhere; one typed for another site inside is refused by the computer.
    const frames = computer.frames.length;
    const elsewhere = await answer(mira, card.id, { action: "typed", sealed: (await box({ origin: OTHER_SITE, username: USER, password: CANARY }, { decisionId: "another-card" })).sealed });
    assert.equal(elsewhere.statusCode, 400);
    assert.equal(computer.frames.length, frames, "nothing went to the computer");
    const otherSite = await answer(mira, card.id, { action: "typed", sealed: (await box({ origin: "https://bank.example", username: USER, password: CANARY })).sealed });
    assert.equal(otherSite.statusCode, 200, otherSite.body);
    assert.equal(json(otherSite).result.status, "failed");
    assert.match(json(otherSite).message.data.error, /another site/);
    assert.equal(json(otherSite).message.data.status, "pending", "the card stays open");

    // A wrong password: the site says no, the card stays open for another try; the same box again is refused by the computer.
    const wrongBox = await box({ origin: OTHER_SITE, username: USER, password: "not-it" });
    const wrong = await answer(mira, card.id, { action: "typed", sealed: wrongBox.sealed });
    assert.equal(json(wrong).result.status, "failed");
    assert.match(json(wrong).message.data.error, /Still not signed in/);
    const replayed = await answer(mira, card.id, { action: "typed", sealed: wrongBox.sealed });
    assert.equal(json(replayed).result.code, "seal_replay", "a box is taken once");
    assert.equal(json(replayed).message.data.status, "pending");

    script = (turn) => (turn.transcript.includes("signed in to") ? { calls: [{ name: "browser_snapshot", arguments: { tab: tabId } }], then: "3 invoices are due this week." } : { text: "ok" });
    const right = await box({ origin: OTHER_SITE, username: USER, password: CANARY, save: true });
    const signedIn = await answer(mira, card.id, { action: "typed", sealed: right.sealed });
    assert.equal(signedIn.statusCode, 200, signedIn.body);
    assert.equal(json(signedIn).result.status, "signed_in");
    assert.equal(json(signedIn).message.data.status, "signed_in");
    assert.equal(json(signedIn).message.data.via, "typed");
    assert.match(json(signedIn).message.data.note ?? "", /not saved: Logins are saved for https sites/, "a plain-http site's login is not kept, and the card says so");
    assert.ok(!(await mira.inject({ method: "GET", url: "/api/node/approvals" })).json().approvals.some((row: { id: string }) => row.id === card.id), "off Needs me");

    // The node was woken, told only that it is signed in; the same tab now shows the signed-in page.
    assert.ok(seen.some((turn) => turn.transcript.includes(`Your owner signed in to ${OTHER_SITE} on Mira's laptop`)));
    const after = (await messages(mira, room.id)).filter((row) => row.authorNodeId === node.id && row.kind !== "approval").at(-1)!;
    assert.match((after.data.tools as Array<{ summary: string }>)[0]!.summary, /Welcome back/);

    // The same box again: the card is answered.
    assert.equal((await answer(mira, card.id, { action: "typed", sealed: right.sealed })).statusCode, 409);
    const replay = await loginResolution({ id: "r", loginId: card.data.loginId, decisionId: card.id, action: "typed", sealed: right.sealed });
    assert.equal(replay.status, "signed_in", "the computer only says the sign-in is over");

    // The sign-in stays in the owner's browser profile: the next task on the site is signed in already.
    const next = await runBrowserTool(browserBroker(), "browser_open", { url: `${OTHER_SITE}/dashboard` }, { operation: "next-task" });
    assert.ok(next.ok && /Ledger/.test(next.summary) && !(next.result as { login?: unknown }).login, next.ok ? next.summary : "");
    await browserBroker().release("next-task");
  } finally {
    computer.stop();
  }

  // The canary: nowhere the API, the model or the computer's files could hold it.
  const tables = await everyTable();
  assert.ok(tables.includes("node.login_answered") && tables.includes(OTHER_SITE), "the search reads the rows this test wrote");
  assertNoCanary(tables, "any table");
  assert.ok(logged.join("").includes("/api/node/logins/"), "the request logs were captured");
  assertNoCanary(logged.join(""), "any log line");
  assert.ok(redisWrites.length > 0);
  assertNoCanary(redisWrites.join("\n"), "any Redis write");
  assertNoCanary(computer.frames.join("\n"), "any frame to the computer");
  assertNoCanary(computer.answers.join("\n"), "any answer from the computer");
  assertNoCanary(modelInputs.join("\n"), "any model input");
  // The computer's own files, the browser profile too once Chromium has closed and written everything (it keeps the site's cookie, not the password).
  await shutdownBrowser();
  const files = everyFile(join(scratch, "computer"));
  assert.ok(files.includes("logins") || files.length > 100_000, "the computer's files were read");
  assertNoCanary(files, "the computer's own files (keys, logins, ledger, browser profile)");
});

test("the login saved on the computer fills the sign-in; a wrong one leaves the card open; this computer's own address only hints", { skip: noBrowser, timeout: 240_000 }, async () => {
  const mira = await person("Mira");
  const computer = await computerFor(mira);
  const { node, room } = await createNode(mira);
  try {
    let tabId = "";
    saveLogin({ origin: OWN_SITE, username: USER, password: "an-old-password" });
    assert.ok(!readFileSync(loginsPath(), "utf8").includes("an-old-password"), "saved logins are encrypted at rest");
    assert.equal(statSync(loginsPath()).mode & 0o777, 0o600);
    script = (turn) =>
      turn.transcript.includes("open the local ledger")
        ? { calls: [{ name: "browser_open", arguments: { url: `${OWN_SITE}/dashboard` } }], then: "It wants a sign-in." }
        : turn.transcript.includes("ask me to sign in")
          ? { calls: [{ name: "browser_login_needed", arguments: { tab: tabId, reason: "to read the invoices", signedIn: { urlPattern: "**/dashboard" } } }], then: "Waiting for you." }
          : turn.transcript.includes("signed in to")
            ? { calls: [{ name: "browser_snapshot", arguments: { tab: tabId } }], then: "Done." }
            : { text: "ok" };
    await say(mira, room.id, "open the local ledger");
    const opened = (await messages(mira, room.id)).filter((row) => row.authorNodeId === node.id && row.kind !== "approval").at(-1)!;
    const summary = (opened.data.tools as Array<{ summary: string }>)[0]!.summary;
    assert.match(summary, /looks like a sign-in .*call browser_login_needed/);
    tabId = /Opened (t\d+)/.exec(summary)![1]!;
    assert.ok(!(await messages(mira, room.id)).some((row) => row.data.type === "login"), "no card for this computer's own address by itself");

    await say(mira, room.id, "ask me to sign in");
    const card = await loginCard(mira, room.id);
    assert.equal(card.data.saved, true, "the card offers the saved login");
    assert.deepEqual(card.data.reasons, ["to read the invoices"]);

    const stale = await answer(mira, card.id, { action: "saved" });
    assert.equal(json(stale).result.status, "failed");
    assert.match(json(stale).message.data.error, /Still not signed in after filling the saved login/);

    saveLogin({ origin: OWN_SITE, username: USER, password: CANARY });
    const filled = await answer(mira, card.id, { action: "saved" });
    assert.equal(json(filled).result.status, "signed_in", filled.body);
    assert.equal(json(filled).message.data.via, "saved");
    assert.ok(listLogins().find((row) => row.origin === OWN_SITE)?.usedAt, "the login's last use is noted");
    assert.ok(seen.some((turn) => turn.transcript.includes(`Your owner signed in to ${OWN_SITE}`)));
    const after = (await messages(mira, room.id)).filter((row) => row.authorNodeId === node.id && row.kind !== "approval").at(-1)!;
    assert.match((after.data.tools as Array<{ summary: string }>)[0]!.summary, /Welcome back/);
  } finally {
    computer.stop();
  }
  assertNoCanary([await everyTable(), logged.join(""), redisWrites.join("\n"), computer.frames.join("\n"), computer.answers.join("\n"), modelInputs.join("\n")].join("\n"), "the API, the model or the relay");
});

test("Not now ends the sign-in cleanly: the tab is cleared and given back, the node hears it is blocked, and the site is not asked again", { skip: noBrowser, timeout: 180_000 }, async () => {
  const mira = await person("Mira");
  const computer = await computerFor(mira);
  const { node, room } = await createNode(mira);
  try {
    let tabId = "";
    script = (turn) =>
      turn.transcript.includes("look at the billing page")
        ? { calls: [{ name: "browser_open", arguments: { url: `${OTHER_SITE}/dashboard` } }], then: "Waiting." }
        : turn.transcript.includes("chose not to sign in")
          ? { calls: [{ name: "browser_open", arguments: { tab: tabId, url: `${OTHER_SITE}/dashboard` } }, { name: "browser_tabs", arguments: {} }], then: "Blocked: it needs a sign-in." }
          : { text: "ok" };
    await say(mira, room.id, "look at the billing page");
    const card = await loginCard(mira, room.id);
    tabId = card.data.tab as string;
    const settled = await mira.inject({ method: "POST", url: `/api/node/approvals/${card.id}`, payload: { decision: "discard" } });
    assert.equal(settled.statusCode, 200, settled.body);
    await settleTurns();
    assert.equal(json(settled).message.data.status, "declined");
    const told = seen.find((turn) => turn.transcript.includes("chose not to sign in"));
    assert.ok(told, "the node hears the owner said not now");
    assert.match(told.transcript, /node_step_blocked/);
    const after = (await messages(mira, room.id)).filter((row) => row.authorNodeId === node.id && row.kind !== "approval").at(-1)!;
    const tools = after.data.tools as Array<{ name: string; state: string; summary: string }>;
    assert.equal(tools[0]!.state, "ok", "the tab is the node's again");
    assert.match(tools[0]!.summary, /did not sign in to .* for this work/, "the same site is not asked again for this work");
    assert.ok(!/paused for sign-in/.test(tools[1]!.summary));
    assert.equal((await messages(mira, room.id)).filter((row) => row.data.type === "login").length, 1, "one card");
  } finally {
    computer.stop();
  }
});

test("a run's agent waits in its tool call; the card is where its run is followed, and I'm done checks the owner really signed in on the computer", { skip: noBrowser, timeout: 180_000 }, async () => {
  const mira = await person("Mira");
  const computer = await computerFor(mira);
  const { node, room } = await createNode(mira);
  const task = await h.prisma.task.create({ data: { userId: mira.id, title: "Reconcile the invoices" } });
  const leaseToken = randomBytes(24).toString("base64url");
  const job = await h.prisma.workspaceJob.create({
    data: { userId: mira.id, taskId: task.id, executionMode: "sandbox", model: "default", status: "running", deviceId: computer.laptop.id, leaseOwner: computer.laptop.id, leaseToken, leaseUntil: new Date(Date.now() + 300_000), startedAt: new Date() },
  });
  const { postMessage } = await import("./store.js");
  const { message } = await postMessage(h.prisma, { roomId: room.id, userId: mira.id, authorKind: "node", authorNodeId: node.id, kind: "run", body: "Reconcile the invoices", data: { jobId: job.id, status: "running", direct: true } });
  await h.prisma.nodeRun.create({ data: { userId: mira.id, nodeId: node.id, roomId: room.id, messageId: message.id, jobId: job.id, taskId: task.id, status: "running", direct: true } });
  // The computer's local run of this job, and its remote loop's sink: the web raises the card under the job's lease.
  const localJobId = randomBytes(8).toString("hex");
  setRunLoginSink(async (local, login) => {
    assert.equal(local, localJobId);
    const raised = await computer.key.inject({ method: "POST", url: `/api/devices/self/jobs/${job.id}/logins`, payload: { leaseToken, ...login } });
    assert.equal(raised.statusCode, 200, raised.body);
    return { decisionId: json(raised).decisionId };
  });
  const turns = seen.length;
  try {
    const broker = browserBroker();
    const opened = await runBrowserTool(broker, "browser_open", { url: `${OTHER_SITE}/dashboard` }, { operation: localJobId });
    assert.ok(opened.ok);
    const login = (opened as { result: { login?: { loginId: string; tab: string } } }).result.login;
    assert.ok(login, "the run's page asks to sign in");
    const control = new AbortController();
    const waiting = awaitRunLogin({ job: { id: localJobId }, signal: control.signal } as never, login as never);
    let card: Row | undefined;
    for (let tries = 0; tries < 100 && !card; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      card = (await messages(mira, room.id)).find((row) => row.data.type === "login");
    }
    assert.ok(card, "the card is in the node's conversation, where the run card is");
    assert.equal(card.data.jobId, job.id);

    // I'm done before signing in: still waiting, said so.
    const early = await answer(mira, card.id, { action: "done" });
    assert.equal(json(early).result.status, "waiting");
    assert.match(json(early).message.data.error, /Still not signed in/);

    // The owner signs in at the computer, in the paused tab (the broker's own page, as a person at the screen would).
    const tab = broker.ownerTab(login.tab);
    assert.equal(tab.sensitive, true);
    await tab.page.fill('input[name="email"]', USER);
    await tab.page.fill('input[name="password"]', CANARY);
    await Promise.all([tab.page.waitForURL("**/dashboard"), tab.page.press('input[name="password"]', "Enter")]);
    const done = await answer(mira, card.id, { action: "done" });
    assert.equal(json(done).result.status, "signed_in");
    assert.equal(json(done).message.data.via, "computer");
    assert.match(await waiting, /Signed in to http:\/\/signin\.example\.test:\d+\. Tab t\d+ is yours again/);
    assert.equal(broker.ownerTab(login.tab).sensitive, false);
    const read = await runBrowserTool(broker, "browser_snapshot", { tab: login.tab }, { operation: localJobId });
    assert.ok(read.ok && /Welcome back/.test(read.summary));
    assert.equal(seen.length, turns, "a run's sign-in does not wake the node: the run goes on by itself");
  } finally {
    setRunLoginSink(null);
    computer.stop();
  }
});

test("saved logins and the computer's own login routes stay on the computer", async () => {
  const mira = await person("Mira");
  const listed = await mira.inject({ method: "GET", url: "/api/browser/logins" });
  assert.equal(listed.statusCode, 409, "the web keeps no logins");
  const saved = await mira.inject({ method: "PUT", url: "/api/browser/logins", payload: { origin: "https://example.com", username: "a", password: "b" } });
  assert.equal(saved.statusCode, 409);
});
