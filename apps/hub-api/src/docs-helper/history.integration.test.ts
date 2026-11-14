import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createHttpHarness } from "../test/http.js";
import { DOCS_ORIGIN } from "./paths.js";

let modelCalls = 0;
let onAbort: (() => void) | null = null;
let hold: (() => Promise<void>) | null = null;
const harness = await createHttpHarness({ docsHelper: { dependencies: {
  admit: async () => 0,
  index: async () => ({ version: 1, pages: [{ title: "Connect an app", path: "/connect/", sections: [{ heading: "Connect an app", url: "https://docs.ensemblework.com/connect/", text: "Open Settings → Connections and choose an app." }] }] }),
  call: async (payload, _fetch, signal) => {
    if (onAbort) signal?.addEventListener("abort", onAbort, { once: true });
    modelCalls++;
    assert.doesNotMatch(payload.input, /private workspace|previous secret/);
    if (hold) await hold();
    return JSON.stringify({ found: true, answer: "Open Settings → Connections and choose an app.", citations: [1] });
  },
} } });
after(async () => harness.close());
const { prisma } = await import("../lib/prisma.js");
const a = await harness.asUser(), b = await harness.asUser();
const headers = (who: typeof a) => ({ origin: DOCS_ORIGIN, "x-ensemble-docs-account": who.id });

test("guest questions leave no transcript, even with an incidental session cookie", async () => {
  for (const inject of [harness.app.inject.bind(harness.app), a.inject]) {
    const result = await inject({ method: "POST", url: "/api/docs/ask", payload: { question: "connect app" } });
    assert.equal(result.statusCode, 200, result.body);
  }
  assert.equal(await prisma.docsChatTurn.count(), 0);
  assert.equal(await prisma.docsChat.count(), 0);
});
test("signed-in history belongs to the account, with no Hub conversation or shared-space access", async () => {
  const result = await a.inject({ method: "POST", url: "/api/docs/ask", headers: headers(a), payload: { question: "connect app", remember: true } });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().saved, true);
  const own = await a.inject({ method: "GET", url: "/api/docs/history", headers: headers(a) });
  assert.equal(own.json().turns.length, 1);
  const other = await b.inject({ method: "GET", url: "/api/docs/history", headers: headers(b) });
  assert.deepEqual(other.json().turns, []);
  const foreignCursor = await b.inject({ method: "GET", url: `/api/docs/history?before=${result.json().turn.id}`, headers: headers(b) });
  assert.equal(foreignCursor.statusCode, 404);
  assert.equal(await prisma.assistantMessage.count(), 0);
});
test("cookies changing account cannot mix histories or clear the other account", async () => {
  const changed = await b.inject({ method: "GET", url: "/api/docs/history", headers: headers(a) });
  assert.equal(changed.statusCode, 409);
  for (const method of ["DELETE", "POST"] as const) {
    const response = await b.inject({ method, url: method === "DELETE" ? "/api/docs/history" : "/api/docs/ask", headers: headers(a), ...(method === "POST" ? { payload: { question: "connect app", remember: true } } : {}) });
    assert.equal(response.statusCode, 409);
  }
  assert.equal(await prisma.docsChatTurn.count({ where: { userId: a.id } }), 1);
});
test("keys do not unlock history and cross-origin writes are refused", async () => {
  const key = await harness.asToken(a, "full");
  assert.equal((await harness.app.inject({ method: "GET", url: "/api/docs/history", headers: { ...headers(a), authorization: `Bearer ${key.token}` } })).statusCode, 401);
  assert.equal((await a.inject({ method: "DELETE", url: "/api/docs/history", headers: { ...headers(a), origin: "https://evil.example" } })).statusCode, 403);
  assert.equal((await a.inject({ method: "POST", url: "/api/docs/ask", headers: { ...headers(a), origin: "https://evil.example" }, payload: { question: "connect app", remember: true } })).statusCode, 403);
});
test("scope refusals never call a model, but signed-in readers may revisit them", async () => {
  const before = modelCalls;
  for (const question of ["What model am I speaking with?", "Please code BFS in Python", "I am in an urgent emergency, I need Python matrix multiplication using numpy"]) {
    const result = await a.inject({ method: "POST", url: "/api/docs/ask", headers: headers(a), payload: { question, remember: true } });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().found, false);
    assert.equal(result.json().saved, true);
    assert.doesNotMatch(result.json().answer, /gpt|openai|azure|def |np\./i);
  }
  assert.equal(modelCalls, before);
});
test("clearing history prevents an in-flight answer from restoring erased messages", async () => {
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  hold = async () => { started(); await resume; };
  const result = a.inject({ method: "POST", url: "/api/docs/ask", headers: headers(a), payload: { question: "connect app", remember: true } });
  await waiting;
  assert.equal((await a.inject({ method: "DELETE", url: "/api/docs/history", headers: headers(a) })).statusCode, 204);
  release(); hold = null;
  const response = await result;
  assert.equal(response.json().saved, false);
  assert.equal(await prisma.docsChatTurn.count({ where: { userId: a.id } }), 0);
});
test("pagination is bounded and only returns the reader's earlier turns", async () => {
  await prisma.docsChatTurn.createMany({ data: Array.from({ length: 35 }, (_, i) => ({ id: crypto.randomUUID(), userId: b.id, question: `Question ${i}`, answer: "Docs answer", found: false, sources: [], createdAt: new Date(1000 + i) })) });
  const first = (await b.inject({ method: "GET", url: "/api/docs/history", headers: headers(b) })).json();
  assert.equal(first.turns.length, 30);
  const second = (await b.inject({ method: "GET", url: `/api/docs/history?before=${first.before}`, headers: headers(b) })).json();
  assert.equal(second.turns.length, 5);
  assert.equal(second.before, null);
  assert.equal(new Set([...first.turns, ...second.turns].map(row => row.id)).size, 35);
});


test("disconnecting cancels the provider signal and cannot save an unfinished answer", async () => {
  const user = await harness.asUser();
  let release!: () => void, started!: () => void, stopped!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  const aborted = new Promise<void>(resolve => { stopped = resolve; });
  onAbort = stopped;
  hold = async () => { started(); await resume; };
  const address = await harness.app.listen({ host: "127.0.0.1", port: 0 });
  const controller = new AbortController();
  const response = fetch(`${address}/api/docs/ask`, { method: "POST", signal: controller.signal, headers: { ...headers(user), cookie: user.cookie, "content-type": "application/json" }, body: JSON.stringify({ question: "connect app", remember: true }) });
  await waiting;
  controller.abort();
  await assert.rejects(response, /abort/i);
  await aborted;
  release(); hold = null; onAbort = null;
  assert.equal(await prisma.docsChatTurn.count({ where: { userId: user.id } }), 0);
});

test("revoked sessions cannot save late answers, and account export and erasure include docs history", async () => {
  const { docsHistory } = await import("./history.js");
  const { exportAccountData } = await import("../lib/account-data.js");
  const { deleteWorkspaceData } = await import("../lib/workspace-data.js");
  const { sha256 } = await import("../lib/auth.js");
  const user = await harness.asUser();
  const store = docsHistory(prisma);
  const generation = await store.begin(user.id);
  const who = { id: user.id, name: "Mira", sessionId: sha256(user.cookie.split("=")[1]!) };
  await store.save(who, generation, "connect app", { found: true, answer: "Open Connections.", sources: [] });
  const exported = await exportAccountData(prisma, user.id);
  assert.equal(exported.tables.docs_chat_turns?.length, 1);
  await deleteWorkspaceData(prisma, user.id, "everything");
  assert.equal(await prisma.docsChatTurn.count({ where: { userId: user.id } }), 0);
  assert.equal(await store.save(who, generation, "connect app", { found: true, answer: "Open Connections.", sources: [] }), null);
  const next = await store.begin(user.id);
  await prisma.session.delete({ where: { id: who.sessionId } });
  assert.equal(await store.save(who, next, "connect app", { found: true, answer: "Open Connections.", sources: [] }), null);
});

test("signing out revokes the shared session while keeping its saved docs history", async () => {
  const user = await harness.asUser();
  const sent = await user.inject({ method: "POST", url: "/api/docs/ask", headers: headers(user), payload: { question: "connect app", remember: true } });
  assert.equal(sent.json().saved, true);
  const logout = await user.inject({ method: "POST", url: "/api/docs/logout", headers: headers(user), payload: {} });
  assert.equal(logout.statusCode, 204);
  assert.equal((await user.inject({ method: "GET", url: "/api/docs/session" })).json().user, null);
  assert.equal((await user.inject({ method: "GET", url: "/api/docs/history", headers: headers(user) })).statusCode, 401);
  assert.equal(await prisma.docsChatTurn.count({ where: { userId: user.id } }), 1);
});
