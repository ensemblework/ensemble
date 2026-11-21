/**
 * Context DB retrieval for a node turn (context/retrieve.ts): the owner's overdue and due-today tasks always,
 * with their due dates; then what relates to the request, ranked by full-text rank, recency and the open
 * project; within the token budget, long items named with their link and an excerpt, never pasted. PGlite
 * runs the same `to_tsvector`/`ts_rank` SQL as Postgres.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createHttpHarness } from "../test/http.js";
import type { RetrieveInput } from "./retrieve.js";

const h = await createHttpHarness();
after(() => h.close());
// After the harness: the database client is made when these load.
const { ContextConfig, DEFAULT_CONTEXT_CONFIG } = await import("./config.js");
const { retrieveContext } = await import("./retrieve.js");

const NOW = new Date("2026-11-21T15:00:00.000Z");
const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

function input(spaceId: string, words: string, over: Partial<RetrieveInput> = {}): RetrieveInput {
  return { spaceId, ownerId: spaceId, ownSpace: true, words, timeZone: "UTC", config: DEFAULT_CONTEXT_CONFIG.retrieval, now: NOW, ...over };
}

test("an owner's turn always gets their overdue and due-today tasks with due dates; a relevant old meeting ranks above the rest", async () => {
  const owner = await h.asUser();
  const other = await h.asUser();
  const task = (title: string, due: string | null, over: Record<string, unknown> = {}) =>
    h.prisma.task.create({ data: { userId: owner.id, title, status: "todo", ...(due ? { due: new Date(due) } : {}), ...over } });
  const domain = await task("Renew the company domain", "2026-11-18T00:00:00.000Z", { priority: "p0" });
  const invoice = await task("Send the invoice to Acme", "2026-11-21T00:00:00.000Z");
  const bank = await task("Call the bank", "2026-11-21T17:30:00.000Z");
  await task("File the old expenses", "2026-11-10T00:00:00.000Z", { status: "done" });
  await task("Prepare the board slides", "2026-11-22T00:00:00.000Z");
  await task("Review Ben's draft", "2026-11-19T00:00:00.000Z", { assigneeAccountId: other.id });
  await h.prisma.task.create({ data: { userId: other.id, title: "Someone else's overdue work", due: new Date("2026-11-17T00:00:00.000Z") } });

  // The meeting where it was decided, half a year ago; newer items that share only a word or none.
  const meeting = await h.prisma.meetingSession.create({
    data: { userId: owner.id, title: "Vendor review", notes: "Northwind contract renewal: we agreed to renew for two years if the price stays under 40k. Dana sends the redlines.", startedAt: daysAgo(180), status: "ended" },
  });
  const templates = await h.prisma.taskPage.create({ data: { userId: owner.id, title: "Contract templates", searchText: "Contract templates for new suppliers and freelancers." } });
  await h.prisma.taskPage.create({ data: { userId: owner.id, title: "Garden plans", searchText: "Tomatoes, basil and a new fence in spring." } });
  await h.prisma.meetingSession.create({ data: { userId: owner.id, title: "Weekly sync", notes: "Hiring plan and the offsite agenda.", startedAt: daysAgo(2), status: "ended" } });
  await h.prisma.meetingSession.create({ data: { userId: other.id, title: "Northwind contract renewal", notes: "Northwind contract renewal, someone else's notes.", startedAt: daysAgo(1), status: "ended" } });

  const got = await retrieveContext(h.prisma, input(owner.id, "What did we decide about the Northwind contract renewal?"));
  const text = got.lines.join("\n");

  const overdue = got.items.filter((item) => item.group === "overdue");
  assert.deepEqual(overdue.map((item) => item.id), [domain.id], "open, the owner's, due before today");
  assert.match(text, /^Overdue \(open tasks due before today, 2026-11-21\):$/m);
  assert.ok(text.includes(`- [Renew the company domain](ensemble://task/${domain.id}): due 2026-11-18 (3 days overdue) · todo · p0`), text);
  assert.deepEqual(got.items.filter((item) => item.group === "today").map((item) => item.id), [invoice.id, bank.id]);
  assert.ok(text.includes(`- [Send the invoice to Acme](ensemble://task/${invoice.id}): due today · todo · p1`), text);
  assert.ok(text.includes(`- [Call the bank](ensemble://task/${bank.id}): due today 17:30 · todo · p1`), text);
  assert.doesNotMatch(text, /old expenses|board slides|Ben's draft|Someone else's/, "not done ones, not later ones, not someone else's");

  const related = got.items.filter((item) => item.group === "related");
  assert.equal(related[0]?.id, meeting.id, JSON.stringify(related.map((item) => [item.title, item.score, item.why])));
  assert.ok(related.findIndex((item) => item.id === templates.id) > 0, "the newer page that shares one word comes later");
  assert.ok(!related.some((item) => /Garden plans|Weekly sync/.test(item.title)), "nothing that shares no word");
  assert.equal(related.filter((item) => item.title === "Northwind contract renewal").length, 0, "another account's records are never read");
  assert.match(text, new RegExp(`- \\[Vendor review\\]\\(ensemble://meeting/${meeting.id}\\): meeting notes, 2026-05-25 · “[^”]*Northwind contract renewal`));
  assert.ok(got.refs.some((ref) => ref.id === meeting.id && ref.label === "Vendor review") && got.refs.some((ref) => ref.id === domain.id));
  assert.deepEqual(got.terms.sort(), ["contract", "decide", "northwind", "renewal"]);

  // A turn about nothing in particular still gets the due work; another space's turn reads that space.
  const hello = await retrieveContext(h.prisma, input(owner.id, "hello"));
  assert.deepEqual(hello.items.map((item) => item.group), ["overdue", "today", "today"]);
  const theirs = await retrieveContext(h.prisma, input(other.id, "hello", { ownerId: other.id }));
  assert.deepEqual(theirs.items.map((item) => item.title), ["Someone else's overdue work"]);
});

test("the workspace keeps to its budget: long items are named with a link and an excerpt, and the rest are counted", async () => {
  const owner = await h.asUser();
  const long = `${"Background on the launch. ".repeat(400)}The Zephyr launch checklist: legal review, pricing page, press kit. ${"More notes. ".repeat(400)}`;
  const page = await h.prisma.taskPage.create({ data: { userId: owner.id, title: "Zephyr launch checklist", searchText: long } });
  for (let index = 0; index < 30; index += 1) {
    await h.prisma.task.create({ data: { userId: owner.id, title: `Zephyr launch item ${index}`, description: `Part ${index} of the Zephyr launch.`, due: new Date(`2026-11-${String(1 + (index % 19)).padStart(2, "0")}T00:00:00.000Z`) } });
  }
  const config = ContextConfig.parse({ retrieval: { budgetTokens: 300 } }).retrieval;
  const got = await retrieveContext(h.prisma, input(owner.id, "where is the Zephyr launch checklist?", { config }));
  assert.ok(got.chars <= config.budgetTokens * 4, `${got.chars} characters`);
  assert.equal(got.lines.join("\n").length + 1, got.chars);
  assert.ok(got.left > 0, "what did not fit is counted");
  assert.ok(got.items.filter((item) => item.group === "overdue").length <= config.always.overdue);
  assert.match(got.lines.join("\n"), /- and \d+ more/);

  const wide = await retrieveContext(h.prisma, input(owner.id, "where is the Zephyr launch checklist?", { config: ContextConfig.parse({ retrieval: { budgetTokens: 1_200, always: { overdue: 2, today: 2 } } }).retrieval }));
  const line = wide.lines.find((row) => row.includes(`ensemble://page/${page.id}`));
  assert.ok(line, wide.lines.join("\n"));
  assert.ok(line.length < 400, `named, not pasted: ${line.length} characters`);
  assert.match(line, /Zephyr launch checklist: legal review/, "with the words around the match");
  assert.equal(wide.items[0]?.group, "overdue");
});

test("weights come from the versioned config: off, or a different budget, without a release", async () => {
  const owner = await h.asUser();
  await h.prisma.task.create({ data: { userId: owner.id, title: "Renew the passport", due: new Date("2026-11-01T00:00:00.000Z") } });
  const { activeContextConfig, contextConfigRef, resetContextConfigCache } = await import("./config.js");
  const before = process.env.ENSEMBLE_CONTEXT_CONFIG;
  try {
    process.env.ENSEMBLE_CONTEXT_CONFIG = JSON.stringify({ version: "test-1", retrieval: { budgetTokens: 500, weights: { recency: 0.5 } } });
    resetContextConfigCache();
    const config = activeContextConfig();
    assert.equal(config.version, "test-1");
    assert.equal(config.retrieval.budgetTokens, 500);
    assert.equal(config.retrieval.weights.recency, 0.5);
    assert.equal(config.retrieval.weights.text, DEFAULT_CONTEXT_CONFIG.retrieval.weights.text, "what it does not name keeps its default");
    assert.notEqual(contextConfigRef(config).hash, contextConfigRef(DEFAULT_CONTEXT_CONFIG).hash);
    const warned: string[] = [];
    process.env.ENSEMBLE_CONTEXT_CONFIG = JSON.stringify({ retrieval: { budgetTokens: -1 } });
    resetContextConfigCache();
    assert.equal(activeContextConfig({ warn: (_data, message) => void warned.push(message) }), DEFAULT_CONTEXT_CONFIG, "an invalid override is ignored");
    assert.equal(warned.length, 1);
  } finally {
    if (before === undefined) delete process.env.ENSEMBLE_CONTEXT_CONFIG;
    else process.env.ENSEMBLE_CONTEXT_CONFIG = before;
    resetContextConfigCache();
  }
  const off = await retrieveContext(h.prisma, input(owner.id, "passport", { config: ContextConfig.parse({ retrieval: { always: { overdue: 0 } } }).retrieval }));
  assert.ok(!off.items.some((item) => item.group === "overdue"));
  assert.ok(off.items.some((item) => item.group === "related" && item.title === "Renew the passport"), "found by its words instead");
});
