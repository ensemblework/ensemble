import assert from "node:assert/strict";
import test from "node:test";
import { Mapping, Step, Transform } from "prosemirror-transform";
import type { Node } from "prosemirror-model";
import type { PageDocument } from "@ensemble/shared-types";
import { Authority, CollabError, LIMITS, type StepBatch } from "./collab-core.js";
import { diffSteps } from "./page-diff.js";
import { CollabHub, STEPS_EVENT, TIMING, type CollabStore, type DocKey, type StoredDoc } from "./collab.js";
import { pageDoc, pageSchema } from "./schema.js";

const p = (...texts: string[]): PageDocument => ({ type: "doc", content: texts.map((text) => (text ? { type: "paragraph", content: [{ type: "text", text }] } : { type: "paragraph" })) });
const lines = (doc: Node | PageDocument): string[] => {
  const node = "nodeSize" in doc ? doc : pageDoc(doc);
  const out: string[] = [];
  node.forEach((child) => out.push(child.textContent));
  return out;
};
/** Position just inside the end of paragraph `index`. */
function endOf(doc: Node, index: number): number {
  let pos = 0;
  for (let at = 0; at < index; at += 1) pos += doc.child(at).nodeSize;
  return pos + doc.child(index).nodeSize - 1;
}
function typing(doc: Node, pos: number, text: string): { steps: unknown[]; doc: Node; tr: Transform } {
  const tr = new Transform(doc).insert(pos, pageSchema.text(text));
  return { steps: tr.steps.map((step) => step.toJSON()), doc: tr.doc, tr };
}
/** What an editor does with steps it made against an older version: maps them over what it missed. */
function rebase(mine: Transform, missed: StepBatch, base: Node): unknown[] {
  let doc = base;
  const mapping = new Mapping();
  for (const json of missed.steps) {
    const step = Step.fromJSON(pageSchema, json);
    doc = step.apply(doc).doc!;
    mapping.appendMap(step.getMap());
  }
  return mine.steps.map((step) => step.map(mapping)!.toJSON());
}

function code(error: unknown): string | undefined {
  return error instanceof CollabError ? error.code : undefined;
}

test("steps against the current version are applied and handed back as confirmation", () => {
  const authority = new Authority(pageSchema, { doc: pageDoc(p("Hello")), revision: 1, raw: p("Hello") });
  const edit = typing(authority.doc, endOf(authority.doc, 0), " world");
  const batch = authority.receive(0, edit.steps, "tab-a");
  assert.equal(batch.from, 0);
  assert.equal(batch.version, 1);
  assert.deepEqual(batch.clientIDs, ["tab-a"]);
  assert.deepEqual(lines(authority.doc), ["Hello world"]);
  assert.equal(authority.unsaved, true);
});

test("a step that does not fit the page is refused and nothing changes", () => {
  const authority = new Authority(pageSchema, { doc: pageDoc(p("Hi")), revision: 1, raw: p("Hi") });
  const good = typing(authority.doc, 3, "!").steps[0];
  const bad = { stepType: "replace", from: 400, to: 401, slice: { content: [{ type: "text", text: "x" }] } };
  assert.throws(() => authority.receive(0, [good, bad], "tab"), (error) => code(error) === "COLLAB_REJECTED");
  assert.throws(() => authority.receive(0, [{ stepType: "nonsense" }], "tab"), (error) => code(error) === "COLLAB_REJECTED");
  assert.equal(authority.version, 0);
  assert.deepEqual(lines(authority.doc), ["Hi"]);
});

test("an editor that fell behind gets what it missed (409), rebases, and both people's typing lands", () => {
  const start = pageDoc(p("Plan"));
  const authority = new Authority(pageSchema, { doc: start, revision: 1, raw: p("Plan") });
  const mira = typing(start, 5, " the launch");
  const ben = typing(start, 5, " next week");
  authority.receive(0, mira.steps, "mira");
  let missed: StepBatch | undefined;
  assert.throws(
    () => authority.receive(0, ben.steps, "ben"),
    (error) => {
      missed = error instanceof CollabError ? error.batch : undefined;
      return code(error) === "COLLAB_BEHIND";
    },
  );
  assert.equal(missed?.from, 0);
  assert.deepEqual(missed?.clientIDs, ["mira"]);
  const confirmed = authority.receive(1, rebase(ben.tr, missed!, start), "ben");
  assert.equal(confirmed.version, 2);
  assert.deepEqual(lines(authority.doc), ["Plan the launch next week"]);
});

test("gaps are filled from the log; versions from the future, another epoch, or past the log reload", () => {
  const authority = new Authority(pageSchema, { doc: pageDoc(p("a")), revision: 1, raw: p("a") }, { ...LIMITS, log: 3 });
  for (let at = 0; at < 5; at += 1) authority.receive(at, typing(authority.doc, 2, String(at)).steps, "tab");
  assert.equal(authority.version, 5);
  assert.deepEqual(authority.since(3).steps.length, 2);
  assert.deepEqual(authority.since(5).steps, []);
  assert.throws(() => authority.since(1), (error) => code(error) === "COLLAB_RESET");
  assert.throws(() => authority.since(6), (error) => code(error) === "COLLAB_RESET");
  assert.throws(() => authority.receive(1, [], "tab"), (error) => code(error) === "COLLAB_RESET");
  assert.throws(() => authority.receive(9, [], "tab"), (error) => code(error) === "COLLAB_RESET");
});

test("diffSteps turns one document into another with small steps", () => {
  const from = pageDoc(p("One", "Two"));
  const to = pageDoc(p("One!", "Two and a half", "Three"));
  const steps = diffSteps(from, to);
  let doc = from;
  for (const step of steps) doc = step.apply(doc).doc!;
  assert.ok(doc.eq(to));
  assert.ok(steps.length >= 3, "each change is its own step");
  assert.deepEqual(diffSteps(from, pageDoc(p("One", "Two"))), []);
});

test("a write from elsewhere that changes two places keeps what was typed between them", () => {
  const start = pageDoc(p("Title", "Middle", "End"));
  const authority = new Authority(pageSchema, { doc: start, revision: 1, raw: p("Title", "Middle", "End") });
  authority.receive(0, typing(start, endOf(start, 1), " typed live").steps, "mira");
  const theirs = p("Title (renamed)", "Middle", "End", "Appended");
  authority.absorb(theirs, 2, pageDoc(theirs));
  assert.deepEqual(lines(authority.doc), ["Title (renamed)", "Middle typed live", "End", "Appended"]);
});

test("a write from elsewhere is mapped through the steps typed since the copy it was based on", () => {
  const start = pageDoc(p("Intro", "Body"));
  const authority = new Authority(pageSchema, { doc: start, revision: 3, raw: p("Intro", "Body") });
  authority.receive(0, typing(start, endOf(start, 0), " typed live").steps, "mira");
  // The assistant read revision 3 (without the live typing) and added a paragraph after Body.
  const theirs = p("Intro", "Body", "Added by the assistant");
  const batch = authority.absorb(theirs, 4, pageDoc(theirs))!;
  assert.deepEqual(batch.clientIDs, ["server"]);
  assert.deepEqual(lines(authority.doc), ["Intro typed live", "Body", "Added by the assistant"]);
  assert.equal(authority.known.revision, 4);
  // A second write based on revision 4 maps through both the live typing and the first write.
  authority.receive(2, typing(authority.doc, endOf(authority.doc, 1), " (edited)").steps, "ben");
  const again = p("Intro", "Body", "Added by the assistant", "Second write");
  authority.absorb(again, 5, pageDoc(again));
  assert.deepEqual(lines(authority.doc), ["Intro typed live", "Body (edited)", "Added by the assistant", "Second write"]);
});

test("when the steps since the copy are gone, a write from elsewhere is three-way merged instead", () => {
  const start = pageDoc(p("Alpha", "Beta"));
  const authority = new Authority(pageSchema, { doc: start, revision: 1, raw: p("Alpha", "Beta") }, { ...LIMITS, log: 2 });
  for (let at = 0; at < 4; at += 1) authority.receive(at, typing(authority.doc, endOf(authority.doc, 0), String(at)).steps, "tab");
  const theirs = p("Alpha", "Beta", "Gamma");
  authority.absorb(theirs, 2, pageDoc(theirs));
  assert.deepEqual(lines(authority.doc), ["Alpha0123", "Beta", "Gamma"]);
});

// ── The hub: loading, write-back, events ─────────────────────────────────────

class MemoryStore implements CollabStore {
  rows = new Map<string, StoredDoc>();
  writes = 0;
  /** The next this many write-backs fail. */
  failing = 0;
  read(key: DocKey): Promise<StoredDoc | null> {
    const row = this.rows.get(key.id);
    return Promise.resolve(row ? structuredClone(row) : null);
  }
  async write(key: DocKey, decide: (row: StoredDoc) => { content: PageDocument; marker: { epoch: string; version: number } } | null) {
    if (this.failing > 0) {
      this.failing -= 1;
      throw new Error("database is down");
    }
    const row = this.rows.get(key.id);
    if (!row) return null;
    const next = decide(structuredClone(row));
    if (!next) return { revision: row.revision, wrote: false };
    this.writes += 1;
    row.revision += 1;
    row.content = structuredClone(next.content);
    row.marker = next.marker;
    return { revision: row.revision, wrote: true };
  }
  /** Someone else's write, straight to the stored copy. */
  external(id: string, edit: (doc: PageDocument) => PageDocument): void {
    const row = this.rows.get(id)!;
    row.content = edit(structuredClone((row.content ?? row.fallback) as PageDocument));
    row.revision += 1;
    delete row.marker;
  }
}

const SPACE = "space-1";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function harness(timing: Partial<typeof import("./collab.js").TIMING> = {}) {
  const store = new MemoryStore();
  const events: Array<{ space: string; event: string; data: Record<string, unknown> }> = [];
  const hub = new CollabHub(store, (space, event, data) => events.push({ space, event, data }), {
    ...TIMING,
    quietMs: 20,
    maxMs: 60,
    retryMs: 20,
    idleMs: 1000,
    sweepMs: 60_000,
    maxOpen: 10,
    recheckMs: [30, 80],
    ...timing,
  });
  return { store, events, hub };
}

async function until(check: () => boolean, ms = 1000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(5);
  }
}

test("the hub writes back after typing pauses, at most every few seconds while it does not, and on flush", async () => {
  const { store, events, hub } = harness();
  store.rows.set("p1", { revision: 1, content: p("Start"), fallback: p() });
  const key: DocKey = { space: SPACE, kind: "page", id: "p1" };
  const joined = (await hub.join(key))!;
  assert.equal(joined.version, 0);
  assert.equal(joined.revision, 1);
  let doc = pageDoc(joined.doc);
  let version = 0;
  const type = async (text: string) => {
    const edit = typing(doc, endOf(doc, 0), text);
    const batch = (await hub.post(key, { epoch: joined.epoch, version, steps: edit.steps, clientID: "tab" }))!;
    doc = edit.doc;
    version = batch.version;
  };
  await type("!");
  assert.equal(store.writes, 0, "nothing written while typing goes on");
  assert.equal(events.filter((frame) => frame.event === STEPS_EVENT).length, 1);
  await until(() => store.writes === 1);
  assert.deepEqual(lines(store.rows.get("p1")!.content as PageDocument), ["Start!"]);
  const saved = events.find((frame) => frame.event === "page");
  assert.deepEqual(saved?.data, { id: "p1", action: "save", revision: 2, by: "collab", epoch: joined.epoch, saved: 1 }, "the write-back says which version is now stored");

  // Typing without a pause still writes back within maxMs.
  const began = store.writes;
  for (let at = 0; at < 12; at += 1) {
    await type(String(at % 10));
    await sleep(10);
  }
  assert.ok(store.writes > began, "written while typing continued");

  await type("?");
  const flushed = (await hub.post(key, { epoch: joined.epoch, version, steps: [], clientID: "tab", flush: true }))!;
  assert.equal(flushed.revision, store.rows.get("p1")!.revision);
  assert.ok(lines(store.rows.get("p1")!.content as PageDocument)[0]!.endsWith("?"));
  await hub.close();
});

test("a failed write-back is retried, and close writes back everything", async () => {
  const { store, hub } = harness({ quietMs: 5, maxMs: 10, retryMs: 10 });
  store.rows.set("p1", { revision: 1, content: p("A"), fallback: p() });
  const key: DocKey = { space: SPACE, kind: "page", id: "p1" };
  const joined = (await hub.join(key))!;
  store.failing = 1;
  await hub.post(key, { epoch: joined.epoch, version: 0, steps: typing(pageDoc(joined.doc), 2, "B").steps, clientID: "tab" });
  await until(() => store.writes === 1);
  assert.deepEqual(lines(store.rows.get("p1")!.content as PageDocument), ["AB"]);

  const { store: other, hub: closing } = harness({ quietMs: 10_000, maxMs: 10_000 });
  other.rows.set("p2", { revision: 1, content: p("X"), fallback: p() });
  const second: DocKey = { space: SPACE, kind: "page", id: "p2" };
  const open = (await closing.join(second))!;
  await closing.post(second, { epoch: open.epoch, version: 0, steps: typing(pageDoc(open.doc), 2, "Y").steps, clientID: "tab" });
  assert.equal(other.writes, 0);
  await closing.close();
  assert.deepEqual(lines(other.rows.get("p2")!.content as PageDocument), ["XY"]);
  await hub.close();
});

test("a write made elsewhere is taken in live and never overwritten by the next write-back", async () => {
  const { store, events, hub } = harness({ quietMs: 10_000, maxMs: 10_000 });
  store.rows.set("p1", { revision: 1, content: p("Notes", "Plan"), fallback: p() });
  const key: DocKey = { space: SPACE, kind: "page", id: "p1" };
  const joined = (await hub.join(key))!;
  const start = pageDoc(joined.doc);
  await hub.post(key, { epoch: joined.epoch, version: 0, steps: typing(start, endOf(start, 1), " for Friday").steps, clientID: "mira" });
  // The assistant writes revision 2 from revision 1 and publishes its usual event.
  store.external("p1", (doc) => ({ ...doc, content: [...doc.content, { type: "paragraph", content: [{ type: "text", text: "Assistant's summary" }] }] }));
  hub.changed(SPACE, "page", { id: "p1", action: "save", by: "agent" });
  await until(() => events.some((frame) => frame.event === STEPS_EVENT && (frame.data.clientIDs as string[]).includes("server")));
  const server = events.filter((frame) => frame.event === STEPS_EVENT).at(-1)!.data;
  assert.equal(server.from, 1);
  await hub.flush(key);
  assert.deepEqual(lines(store.rows.get("p1")!.content as PageDocument), ["Notes", "Plan for Friday", "Assistant's summary"]);

  // A write that lands between two write-backs, with no event, is found by the next write-back.
  const now = (await hub.join(key))!;
  const live = pageDoc(now.doc);
  await hub.post(key, { epoch: now.epoch, version: now.version, steps: typing(live, endOf(live, 0), " (draft)").steps, clientID: "ben" });
  store.external("p1", (doc) => ({ ...doc, content: [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Title" }] }, ...doc.content] }));
  await hub.flush(key);
  assert.deepEqual(lines(store.rows.get("p1")!.content as PageDocument), ["Title", "Notes (draft)", "Plan for Friday", "Assistant's summary"]);
  // Its own write-back events are not mistaken for someone else's.
  const before = store.writes;
  hub.changed(SPACE, "page", { id: "p1", action: "save", by: "collab" });
  hub.changed(SPACE, "task", { id: "unrelated" });
  await sleep(20);
  assert.equal(store.writes, before);
  await hub.close();
});

test("undo and events that name nothing re-read every open page in the space", async () => {
  const { store, hub } = harness();
  store.rows.set("p1", { revision: 1, content: p("One"), fallback: p() });
  store.rows.set("t1", { revision: 0, content: null, fallback: p("task notes") });
  const page = (await hub.join({ space: SPACE, kind: "page", id: "p1" }))!;
  const task = (await hub.join({ space: SPACE, kind: "task", id: "t1" }))!;
  assert.deepEqual(lines(task.doc), ["task notes"], "a task page never written shows its notes");
  store.external("p1", () => p("One", "restored"));
  store.external("t1", () => p("task notes", "agent block"));
  hub.changed(SPACE, "undo.changed", { entryId: "e" });
  hub.changed("another-space", "undo.changed", {});
  const now = async (kind: "page" | "task", id: string) => lines((await hub.join({ space: SPACE, kind, id }))!.doc).join("|");
  for (let tries = 0; tries < 200 && ((await now("page", "p1")) !== "One|restored" || (await now("task", "t1")) !== "task notes|agent block"); tries += 1) await sleep(5);
  assert.deepEqual(lines((await hub.join({ space: SPACE, kind: "page", id: "p1" }))!.doc), ["One", "restored"]);
  assert.deepEqual(lines((await hub.join({ space: SPACE, kind: "task", id: "t1" }))!.doc), ["task notes", "agent block"]);
  assert.equal(page.epoch, (await hub.join({ space: SPACE, kind: "page", id: "p1" }))!.epoch);
  await hub.close();
});

test("a deleted page is forgotten; other epochs reload; idle pages are written back and dropped", async () => {
  const { store, hub } = harness({ quietMs: 10_000, maxMs: 10_000, idleMs: 0 });
  store.rows.set("p1", { revision: 1, content: p("Doc"), fallback: p() });
  const key: DocKey = { space: SPACE, kind: "page", id: "p1" };
  const joined = (await hub.join(key))!;
  await assert.rejects(hub.post(key, { epoch: "old", version: 0, steps: [], clientID: "tab" }), (error) => code(error) === "COLLAB_RESET");
  await assert.rejects(hub.since(key, "old", 0), (error) => code(error) === "COLLAB_RESET");
  await hub.post(key, { epoch: joined.epoch, version: 0, steps: typing(pageDoc(joined.doc), 4, "s").steps, clientID: "tab" });
  await hub.sweep(Date.now() + 1);
  assert.equal(hub.size, 0);
  assert.deepEqual(lines(store.rows.get("p1")!.content as PageDocument), ["Docs"]);
  const fresh = (await hub.join(key))!;
  assert.notEqual(fresh.epoch, joined.epoch, "a reloaded page is a new epoch");
  store.rows.delete("p1");
  hub.changed(SPACE, "page", { id: "p1", action: "delete" });
  await until(() => hub.size === 0);
  assert.equal(hub.size, 0);
  assert.equal(await hub.join(key), null);
  assert.equal(await hub.post(key, { epoch: fresh.epoch, version: 0, steps: [], clientID: "tab" }), null);
  await hub.close();
});

// ── Review findings: what the authority refuses, and what a write-back must survive ──────────

function inserted(doc: Node, pos: number, content: unknown): unknown[] {
  return [{ stepType: "replace", from: pos, to: pos, slice: { content: [content] } }];
}

test("steps the page store could not save are refused: a null character, an unknown mention kind, deep nesting", () => {
  const authority = new Authority(pageSchema, { doc: pageDoc(p("Hi")), revision: 1, raw: p("Hi") });
  const code = (work: () => unknown) => {
    try {
      work();
      return "accepted";
    } catch (error) {
      return error instanceof CollabError ? error.code : "threw";
    }
  };
  assert.equal(code(() => authority.receive(0, inserted(authority.doc, 3, { type: "text", text: "a\u0000b" }), "tab")), "COLLAB_REJECTED");
  assert.equal(code(() => authority.receive(0, inserted(authority.doc, 3, { type: "mention", attrs: { kind: "nope", id: "x", label: "X" } }), "tab")), "COLLAB_REJECTED");
  assert.equal(code(() => authority.receive(0, [{ stepType: "addMark", from: 1, to: 3, mark: { type: "link", attrs: { href: "x\u0000" } } }], "tab")), "COLLAB_REJECTED");
  let nested: Record<string, unknown> = { type: "paragraph", content: [{ type: "text", text: "deep" }] };
  for (let at = 0; at < 60; at += 1) nested = { type: "blockquote", content: [nested] };
  assert.equal(code(() => authority.receive(0, inserted(authority.doc, 4, nested), "tab")), "COLLAB_REJECTED");
  assert.equal(authority.version, 0, "nothing was applied");
  // A valid mention is fine, and so is changing it to another known kind; an unknown kind is not.
  assert.equal(code(() => authority.receive(0, inserted(authority.doc, 3, { type: "mention", attrs: { kind: "people", id: "p", label: "Mira" } }), "tab")), "accepted");
  assert.equal(code(() => authority.receive(1, [{ stepType: "attr", pos: 3, attr: "kind", value: "nope" }], "tab")), "COLLAB_REJECTED");
  assert.equal(code(() => authority.receive(1, [{ stepType: "attr", pos: 3, attr: "kind", value: "project" }], "tab")), "accepted");
});

test("a data: image over 2 MiB is refused; a small one, or moving one the page already had, is not", () => {
  const big = `data:image/png;base64,${"A".repeat(Math.ceil((2 * 1024 * 1024 + 3) / 3) * 4)}`;
  const image = (src: string) => ({ type: "image", attrs: { src, alt: "" } });
  const old: PageDocument = { type: "doc", content: [image(big) as never, ...p("After").content] };
  // Large steps and pages are allowed here, so the refusal is the image rule's own.
  const limits = { ...LIMITS, stepBytes: 50_000_000, docBytes: 50_000_000, logBytes: 50_000_000 };
  const authority = new Authority(pageSchema, { doc: pageDoc(old), revision: 1, raw: old }, limits);
  const refusal = (work: () => unknown) => {
    try {
      work();
      return "accepted";
    } catch (error) {
      return error instanceof CollabError ? `${error.code}: ${error.message}` : "threw";
    }
  };
  const end = authority.doc.content.size;
  const refused = "COLLAB_REJECTED: Images in pages can be up to 2 MB. Upload the image instead of pasting its data, or attach it as a file with /file.";
  assert.equal(refusal(() => authority.receive(0, inserted(authority.doc, end, image(big.replace("AAAA", "BBBB"))), "tab")), refused);
  assert.equal(refusal(() => authority.receive(0, [{ stepType: "attr", pos: 0, attr: "src", value: big.replace("AAAA", "CCCC") }], "tab")), refused);
  assert.equal(refusal(() => authority.receive(0, inserted(authority.doc, end, image("data:image/png;base64,iVBORw0KGgo=")), "tab")), "accepted");
  const moved = new Transform(authority.doc);
  const first = moved.doc.child(0);
  moved.delete(0, first.nodeSize).insert(moved.doc.content.size, first);
  assert.equal(refusal(() => authority.receive(1, moved.steps.map((step) => step.toJSON()), "tab")), "accepted");
  assert.equal(authority.doc.lastChild?.attrs.src, big);
});

test("a page cannot grow past its byte limit, and the step log is bounded by bytes", () => {
  const limits = { ...LIMITS, docBytes: 2_000, logBytes: 1_000, stepBytes: 1_500 };
  const authority = new Authority(pageSchema, { doc: pageDoc(p("Start")), revision: 1, raw: p("Start") }, limits);
  const chunk = "x".repeat(400);
  let accepted = 0;
  for (let at = 0; at < 10; at += 1) {
    try {
      authority.receive(authority.version, typing(authority.doc, 1, chunk).steps, "tab");
      accepted += 1;
    } catch (error) {
      assert.equal(code(error), "COLLAB_TOO_LARGE");
    }
  }
  assert.ok(accepted >= 3 && accepted < 10, `some typing fits, the rest is refused (${accepted})`);
  assert.ok(JSON.stringify(authority.doc.toJSON()).length <= 2_000);
  assert.throws(() => authority.receive(authority.version, typing(authority.doc, 1, "y".repeat(2_000)).steps, "tab"), (error) => code(error) === "COLLAB_TOO_LARGE");
  // Older steps fell out of the log once it held more than 1,000 bytes.
  assert.throws(() => authority.since(0), (error) => code(error) === "COLLAB_RESET");
  assert.equal(authority.since(authority.version).steps.length, 0);
});

test("steps report the last version written back, and a stored copy equal to the live page counts as saved", () => {
  const authority = new Authority(pageSchema, { doc: pageDoc(p("A")), revision: 1, raw: p("A") });
  authority.receive(0, typing(authority.doc, 2, "b").steps, "tab");
  assert.equal(authority.since(0).saved, 0);
  authority.persisted(2, authority.doc.toJSON(), authority.doc, 1);
  authority.receive(1, typing(authority.doc, 3, "c").steps, "tab");
  assert.equal(authority.since(2).saved, 1);
  authority.persisted(3, authority.doc.toJSON(), authority.doc, 2);
  // A write from elsewhere with nothing typed meanwhile: the stored copy is the live page, version 3 included.
  authority.absorb(p("Abcd"), 4, pageDoc(p("Abcd")));
  assert.equal(authority.version, 3);
  assert.equal(authority.saved, 3);
});

test("write-backs that keep failing stop new steps (COLLAB_UNSAVED) until one succeeds", async () => {
  const { store, hub } = harness({ quietMs: 5, maxMs: 10, retryMs: 15, failLimit: 2 });
  store.rows.set("p1", { revision: 1, content: p("A"), fallback: p() });
  const key: DocKey = { space: SPACE, kind: "page", id: "p1" };
  const joined = (await hub.join(key))!;
  store.failing = 2;
  let version = (await hub.post(key, { epoch: joined.epoch, version: 0, steps: typing(pageDoc(joined.doc), 2, "B").steps, clientID: "tab" }))!.version;
  await until(() => store.failing === 0);
  await assert.rejects(hub.post(key, { epoch: joined.epoch, version, steps: [], clientID: "tab" }), (error) => code(error) === "COLLAB_UNSAVED");
  await until(() => store.writes === 1);
  version = (await hub.post(key, { epoch: joined.epoch, version, steps: [], clientID: "tab", flush: true }))!.version;
  assert.equal(version, 1);
  store.failing = 5;
  await assert.rejects(hub.post(key, { epoch: joined.epoch, version, steps: [], clientID: "tab", flush: true }), (error) => code(error) === "COLLAB_UNSAVED");
  store.failing = 0;
  await hub.close();
});

test("a page moved to Trash gets its unsaved typing written back, is dropped, and is not opened again", async () => {
  const { store, hub } = harness({ quietMs: 10_000, maxMs: 10_000 });
  store.rows.set("p1", { revision: 1, content: p("Draft"), fallback: p() });
  const key: DocKey = { space: SPACE, kind: "page", id: "p1" };
  const joined = (await hub.join(key))!;
  await hub.post(key, { epoch: joined.epoch, version: 0, steps: typing(pageDoc(joined.doc), 6, " typed").steps, clientID: "tab" });
  store.rows.get("p1")!.trashed = true;
  hub.changed(SPACE, "page", { id: "p1", action: "delete" });
  await until(() => hub.size === 0);
  assert.deepEqual(lines(store.rows.get("p1")!.content as PageDocument), ["Draft typed"], "written into the page in Trash");
  assert.equal(store.rows.get("p1")!.trashed, true);
  await assert.rejects(hub.join(key), (error) => code(error) === "PAGE_IN_TRASH");
  store.rows.get("p1")!.trashed = false;
  assert.deepEqual(lines((await hub.join(key))!.doc), ["Draft typed"], "restored, it opens with the typing");
  await hub.close();
});

test("a write published before it committed is still taken in, a moment later", async () => {
  const { store, events, hub } = harness({ quietMs: 10_000, maxMs: 10_000, recheckMs: [20, 60] });
  store.rows.set("p1", { revision: 1, content: p("One"), fallback: p() });
  const key: DocKey = { space: SPACE, kind: "page", id: "p1" };
  await hub.join(key);
  hub.changed(SPACE, "page", { id: "p1", action: "save", by: "agent" });
  await sleep(5);
  store.external("p1", () => p("One", "From the assistant"));
  await until(() => events.some((frame) => frame.event === STEPS_EVENT));
  assert.deepEqual(lines((await hub.join(key))!.doc), ["One", "From the assistant"]);
  await hub.close();
});

test("a task page never written follows its notes until it is", async () => {
  const { store, hub } = harness();
  store.rows.set("t1", { revision: 0, content: null, fallback: p("first notes") });
  const key: DocKey = { space: SPACE, kind: "task", id: "t1" };
  await hub.join(key);
  store.rows.get("t1")!.fallback = p("first notes", "added to the notes");
  hub.changed(SPACE, "task", { id: "t1", action: "update" });
  for (let tries = 0; tries < 100 && lines((await hub.join(key))!.doc).length < 2; tries += 1) await sleep(5);
  assert.deepEqual(lines((await hub.join(key))!.doc), ["first notes", "added to the notes"]);
  await hub.close();
});

test("after a restart, joining with start tells which authority and version wrote the stored copy", async () => {
  const { store, hub } = harness({ quietMs: 10_000, maxMs: 10_000 });
  store.rows.set("p1", { revision: 1, content: p("A"), fallback: p() });
  const key: DocKey = { space: SPACE, kind: "page", id: "p1" };
  const first = (await hub.join(key))!;
  await hub.post(key, { epoch: first.epoch, version: 0, steps: typing(pageDoc(first.doc), 2, "b").steps, clientID: "tab", flush: true });
  await hub.close();
  const { hub: restarted } = { hub: new CollabHub(store, () => undefined, { ...TIMING, quietMs: 10_000, maxMs: 10_000 }) };
  const again = (await restarted.join(key, { start: true }))!;
  assert.notEqual(again.epoch, first.epoch);
  assert.deepEqual(again.start?.previous, { epoch: first.epoch, version: 1 });
  assert.deepEqual(lines(again.start!.doc), ["Ab"]);
  // A write from elsewhere since then: the stored copy no longer says who wrote it.
  store.external("p1", () => p("Ab", "C"));
  const later = new CollabHub(store, () => undefined, { ...TIMING, quietMs: 10_000, maxMs: 10_000 });
  assert.equal((await later.join(key, { start: true }))!.start?.previous, null);
  await restarted.close();
  await later.close();
});

// ── Re-review: what the authority must accept, and which step it refuses ─────────────────────

test("code that mentions \\u0000 is fine; a real U+0000 or half a character is refused, naming the step", () => {
  const authority = new Authority(pageSchema, { doc: pageDoc(p("Code")), revision: 1, raw: p("Code") });
  authority.receive(0, inserted(authority.doc, 5, { type: "text", text: ' s.replace(/\\u0000/g, "") 😀' }), "tab");
  assert.match(authority.doc.textContent, /\\u0000/);
  const refusal = (steps: unknown[]) => {
    try {
      authority.receive(authority.version, steps, "tab");
      return null;
    } catch (error) {
      return error instanceof CollabError ? { code: error.code, step: error.step } : null;
    }
  };
  const ok = inserted(authority.doc, 1, { type: "text", text: "fine " })[0];
  assert.deepEqual(refusal([ok, inserted(authority.doc, 1, { type: "text", text: "a\u0000b" })[0]]), { code: "COLLAB_REJECTED", step: 1 });
  assert.deepEqual(refusal([ok, ok, inserted(authority.doc, 1, { type: "text", text: "\ud83d" })[0]]), { code: "COLLAB_REJECTED", step: 2 });
  assert.deepEqual(refusal([{ stepType: "attr", pos: 0, attr: "level", value: "\udc00" }]), { code: "COLLAB_REJECTED", step: 0 });
});

test("a page over a size limit can still be edited and shortened; only growth past the limit is refused", () => {
  const big = p("x".repeat(500));
  const authority = new Authority(pageSchema, { doc: pageDoc(big), revision: 1, raw: big }, { ...LIMITS, docSize: 300, docBytes: 400 });
  // Already over both limits (an agent wrote it). Deleting, and sending nothing, are fine.
  authority.receive(0, [{ stepType: "replace", from: 1, to: 11 }], "tab");
  authority.receive(1, [], "tab");
  // Replacing a letter keeps the size: fine. Adding is refused, at the step that adds.
  authority.receive(1, [{ stepType: "replace", from: 1, to: 2, slice: { content: [{ type: "text", text: "y" }] } }], "tab");
  try {
    authority.receive(2, [{ stepType: "replace", from: 1, to: 2 }, ...typing(authority.doc, 1, "zz").steps], "tab");
    assert.fail("growth past the limit is refused");
  } catch (error) {
    assert.ok(error instanceof CollabError);
    assert.equal(error.code, "COLLAB_TOO_LARGE");
    assert.equal(error.step, 1, "the step that grows the page");
  }
});

test("a batch larger than the log can hold is answered with its steps, not with 'start over' after it was taken", () => {
  const authority = new Authority(pageSchema, { doc: pageDoc(p("Agenda")), revision: 1, raw: p("Agenda") }, { ...LIMITS, log: 3 });
  const words = ["one ", "two ", "three ", "four ", "five "];
  const tr = new Transform(authority.doc);
  for (const word of words) tr.insert(1, pageSchema.text(word));
  const batch = authority.receive(0, tr.steps.map((step) => step.toJSON()), "me/a");
  assert.deepEqual([batch.from, batch.version, batch.steps.length, batch.clientIDs.length], [0, 5, 5, 5]);
  assert.equal(authority.first, 2, "the log keeps three steps");
});
