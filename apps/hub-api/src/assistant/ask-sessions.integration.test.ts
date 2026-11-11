/**
 * Inline "Ask Ensemble" sessions on an AI plan (assistant/ask-sessions.ts): one per page and person,
 * continued by later asks there, and deleted from the computer 30 minutes after the last answer.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createHttpHarness } from "../test/http.js";

const h = await createHttpHarness();
const { ASK_IDLE_MS, ASK_STUCK_MS, askAnswered, askExpired, askSessionKey, askStarted, sweepAskSessions } = await import("./ask-sessions.js");
const { SESSION_KEY } = await import("../subscriptions/turn-sessions.js");
const { turnSession } = await import("../subscriptions/turn.js");
after(() => h.close());

const PAGE = "0b9d5f3e-4c1a-4e7b-9a52-3f1e8c6d2a10";
const asks = async (userId: string) => ((await h.prisma.preference.findUnique({ where: { userId_key: { userId, key: "assistant.ask-sessions" } } }))?.value ?? {}) as Record<string, { started: number; answered?: number }>;

test("each page has its own session for each person, with a key the computer accepts", () => {
  const key = askSessionKey("acct-1", "page", PAGE);
  assert.match(key, SESSION_KEY);
  assert.match(key, /^ask-page-[0-9a-f]{32}$/);
  assert.equal(askSessionKey("acct-1", "page", PAGE), key, "the same page and person keep the same session");
  assert.notEqual(askSessionKey("acct-2", "page", PAGE), key, "another person asking there has their own");
  assert.notEqual(askSessionKey("acct-1", "task", PAGE), key);
  assert.match(askSessionKey("acct-1", "deliverable", PAGE), SESSION_KEY);
});

test("an ask's turn runs in the page session and resumes it however many asks came before", () => {
  const key = askSessionKey("acct-1", "task", PAGE);
  const turn = turnSession({ local: false, turns: 3 } as never, { prompt: "Summarize this", history: "", sessionKey: key, keepDays: 1 });
  assert.deepEqual(turn.session, { key, history: "", keepDays: 1 });
  assert.equal("position" in (turn.session ?? {}), false, "no position: the computer resumes the session whatever the chat's length");
});

test("a session is done 30 minutes after its last answer, or two hours after an ask that never came back", () => {
  const t = 1_000_000_000_000;
  assert.equal(askExpired({ kind: "page", id: PAGE, started: t, answered: t + 1000 }, t + 1000 + ASK_IDLE_MS - 1), false);
  assert.equal(askExpired({ kind: "page", id: PAGE, started: t, answered: t + 1000 }, t + 1000 + ASK_IDLE_MS), true);
  // A newer ask is still answering (or waiting for the one before): kept.
  assert.equal(askExpired({ kind: "page", id: PAGE, started: t + 5000, answered: t + 1000 }, t + ASK_IDLE_MS * 2), false);
  assert.equal(askExpired({ kind: "page", id: PAGE, started: t }, t + ASK_STUCK_MS - 1), false);
  assert.equal(askExpired({ kind: "page", id: PAGE, started: t }, t + ASK_STUCK_MS), true);
});

test("the sweep deletes a page's session 30 minutes after the last answer, and a new ask restarts the clock", async () => {
  const mira = await h.asUser();
  const key = askSessionKey(mira.id, "page", PAGE);
  const dropped: string[] = [];
  const drop = async (_app: unknown, userId: string, dropKey: string) => {
    assert.equal(userId, mira.id);
    dropped.push(dropKey);
  };
  const t = Date.now();
  await askStarted(h.app, mira.id, key, { kind: "page", id: PAGE }, t);
  await askAnswered(h.app, mira.id, key, t + 60_000);
  assert.equal(await sweepAskSessions(h.app, t + 20 * 60_000, drop), 0);
  // Asked again 25 minutes in: the session is continued and the 30 minutes count from that answer.
  await askStarted(h.app, mira.id, key, { kind: "page", id: PAGE }, t + 25 * 60_000);
  assert.equal(await sweepAskSessions(h.app, t + 40 * 60_000, drop), 0, "kept while the new ask answers");
  await askAnswered(h.app, mira.id, key, t + 26 * 60_000);
  assert.equal(await sweepAskSessions(h.app, t + 55 * 60_000, drop), 0);
  assert.ok((await asks(mira.id))[key]);
  assert.equal(await sweepAskSessions(h.app, t + 56 * 60_000, drop), 1);
  assert.deepEqual(dropped, [key]);
  assert.deepEqual(await asks(mira.id), {});
});

test("deleting the session asks the person's computers to drop it, as a deleted chat's", async () => {
  const ben = await h.asUser();
  const token = await h.asToken(ben, "device");
  await h.prisma.device.create({ data: { userId: ben.id, name: "Laptop", platform: "darwin", tokenId: token.id, lastSeenAt: new Date(Date.now() - 86_400_000), capabilities: { assistantTurns: 3, assistantSessionDelete: 1 } as never } });
  const key = askSessionKey(ben.id, "deliverable", PAGE);
  const t = Date.now() - ASK_IDLE_MS - 60_000;
  await askStarted(h.app, ben.id, key, { kind: "deliverable", id: PAGE }, t);
  await askAnswered(h.app, ben.id, key, t + 1000);
  assert.equal(await sweepAskSessions(h.app), 1);
  // The laptop is away: the request waits for its next connection, like a deleted chat's.
  for (let tries = 0; tries < 100; tries += 1) {
    const pending = (await h.prisma.preference.findUnique({ where: { userId_key: { userId: ben.id, key: "assistant.session-deletes" } } }))?.value as Record<string, Array<{ key: string }>> | undefined;
    if (pending && Object.values(pending).flat().some((row) => row.key === key)) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.fail("the away computer's request was not kept");
});

test("an inline ask on an AI plan uses the Ask Ensemble tier and notes the page's session", async () => {
  const ana = await h.asUser();
  // Ask Ensemble on High, which is an AI plan here; the chat's default stays Medium.
  const saved = await ana.inject({ method: "PATCH", url: "/api/settings", payload: { assistant: { askTier: "high" }, models: { high: { provider: "claude-code", model: "default" } } } });
  assert.equal(saved.statusCode, 200, saved.body);
  const created = await ana.inject({ method: "POST", url: "/api/pages", payload: { title: "Launch notes" } });
  assert.ok(created.statusCode < 300, created.body);
  const pageId = (created.json() as { page: { id: string } }).page.id;
  // No computer is paired, so the turn fails, but the ask still ran on the High tier in the page's session.
  const asked = await ana.inject({ method: "POST", url: `/api/pages/page/${pageId}/ensemble`, payload: { prompt: "Summarize" } });
  assert.equal(asked.statusCode, 200, asked.body);
  assert.match(asked.body, /"tier":"high"/);
  const record = Object.entries(await asks(ana.id));
  assert.equal(record.length, 1);
  assert.match(record[0]![0], /^ask-page-/);
  assert.ok(record[0]![1].answered! >= record[0]![1].started, "answered (here: failed), so the 30 minutes run");
});
