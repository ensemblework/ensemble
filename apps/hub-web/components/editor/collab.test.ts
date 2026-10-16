/**
 * Real block editors (the page's TipTap extensions) co-editing through `CollabSession` against the
 * real hub-api authority (`apps/hub-api/src/pages/collab-core.ts`), with random network delays:
 * typing, Enter, deletes and Undo at the same spot from three tabs, a tab going offline, the
 * server restarting, a write from elsewhere, and a session expiring with unsent typing.
 */
import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Editor } from "@tiptap/core";
import type { PageDocument } from "@ensemble/shared-types";
import { sameDoc } from "@ensemble/shared-types/page-merge";
import { Authority, CollabError, LIMITS } from "../../../hub-api/src/pages/collab-core";
import { pageDoc, pageSchema } from "../../../hub-api/src/pages/schema";
import { editorExtensions } from "./extensions";
import { CollabSession, CollabSync, collabTab, type CollabBatch, type CollabStatus, type CollabTab, type CollabTransport, type Draft, type DraftStore } from "./collab";

Object.defineProperty(globalThis, "self", { configurable: true, value: window });

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, label: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(5);
  }
}
const HTTP: Record<string, number> = { COLLAB_BEHIND: 409, COLLAB_RESET: 410, COLLAB_REJECTED: 400, COLLAB_TOO_LARGE: 413, COLLAB_UNSAVED: 503, PAGE_IN_TRASH: 404, COLLAB_REJOIN: 410 };
/** As `routes/collab.ts` answers: the missed steps for COLLAB_BEHIND, the refused step's index for a refusal. */
const asHttp = (error: unknown) =>
  error instanceof CollabError ? { status: HTTP[error.code], code: error.code, data: error.batch ?? (error.step === undefined ? undefined : { step: error.step }), message: error.message } : error;

/** The API process: one authority, write-backs, the event stream, and a network that can fail. */
class Server {
  authority: Authority;
  stored: PageDocument;
  /** The authority and version that wrote `stored`, as the page row's marker records. */
  marker: { epoch: string; version: number } | null = null;
  revision = 1;
  private readonly listeners = new Map<string, { steps: (batch: CollabBatch) => void; saved: (epoch: string, saved: number) => void }>();
  private readonly lines = new Map<string, Promise<void>>();
  /** Clients the event stream does not reach (their connection dropped). */
  readonly deaf = new Set<string>();
  /** Clients whose requests fail as if offline, or with an expired session. */
  readonly offline = new Set<string>();
  readonly signedOut = new Set<string>();
  /** Clients whose next accepted steps get no answer, as if the connection dropped on the way back. */
  readonly dropAnswer = new Set<string>();
  /** Steps per request seen, by client. */
  readonly sent = new Map<string, number[]>();
  /** Joins so far: each one issues a new client id, as the API does. */
  private joins = 0;

  /** Bytes of each request of steps, by client. */
  readonly bytes = new Map<string, number[]>();
  /** Fastify's limit on a request body, as `routes/collab.ts` sets it for steps. */
  bodyLimit = 8 * 1024 * 1024;

  constructor(doc: PageDocument, private readonly rand: () => number, private readonly limits = LIMITS) {
    this.stored = doc;
    this.authority = new Authority(pageSchema, { doc: pageDoc(doc), revision: 1, raw: doc }, limits);
  }

  private latency(): Promise<unknown> {
    return sleep(Math.floor(this.rand() * 6));
  }

  /** A write-back, and its `page` event telling every tab the version now stored. */
  persist(): void {
    if (!this.authority.unsaved) return;
    this.revision += 1;
    this.stored = this.authority.doc.toJSON() as PageDocument;
    this.marker = { epoch: this.authority.epoch, version: this.authority.version };
    this.authority.persisted(this.revision, this.stored, this.authority.doc, this.authority.version);
    const { epoch, saved } = this.authority;
    this.deliver((listener) => listener.saved(epoch, saved));
  }

  /** A deploy: write back, then a fresh authority (new epoch, version 0) from the stored copy. */
  restart(): void {
    this.persist();
    this.crash();
  }

  /** The process dies: what was not written back is gone from the server. */
  crash(): void {
    this.authority = new Authority(pageSchema, { doc: pageDoc(this.stored), revision: this.revision, raw: this.stored, previous: this.marker }, this.limits);
  }

  /** The assistant writes from the stored copy; the authority takes it in. */
  external(edit: (doc: PageDocument) => PageDocument): void {
    this.stored = edit(structuredClone(this.stored));
    this.marker = null;
    this.revision += 1;
    const batch = this.authority.absorb(this.stored, this.revision, pageDoc(this.stored));
    if (batch) this.broadcast(batch);
  }

  broadcast(batch: CollabBatch): void {
    this.deliver((listener) => listener.steps(batch));
  }

  private deliver(send: (listener: { steps: (batch: CollabBatch) => void; saved: (epoch: string, saved: number) => void }) => void): void {
    for (const [name, listener] of this.listeners) {
      if (this.deaf.has(name)) continue;
      const line = (this.lines.get(name) ?? Promise.resolve()).then(() => this.latency()).then(() => send(listener));
      this.lines.set(name, line);
    }
  }

  async quiet(): Promise<void> {
    await Promise.all(this.lines.values());
  }

  subscribe(name: string, listener: { steps: (batch: CollabBatch) => void; saved: (epoch: string, saved: number) => void }): () => void {
    this.listeners.set(name, listener);
    return () => this.listeners.delete(name);
  }

  /** A tab's requests. Client ids are `<account>/<name>.<join>`; the token is the API's HMAC, here per authority. */
  transport(name: string, account = "u1"): CollabTransport {
    const tokenFor = (clientID: string) => `${this.authority.epoch}:${clientID}`;
    const gate = () => {
      if (this.offline.has(name)) throw { status: 0, code: null, message: "Ensemble can't reach its server right now." };
      if (this.signedOut.has(name)) throw { status: 401, code: null, message: "Sign in again." };
    };
    return {
      join: async (options) => {
        await this.latency();
        gate();
        const { authority } = this;
        const known = authority.known;
        const since = options?.stored && known.exact && known.version < authority.version && known.version >= authority.first ? authority.since(known.version) : null;
        const stored = since ? { version: known.version, doc: known.doc.toJSON() as PageDocument, steps: since.steps, clientIDs: since.clientIDs } : undefined;
        const all = options?.start && authority.first === 0 ? authority.since(0) : null;
        const start = all ? { doc: authority.loaded.toJSON() as PageDocument, steps: all.steps, clientIDs: all.clientIDs, previous: authority.previous } : undefined;
        const clientID = `${account}/${name}.${(this.joins += 1)}`;
        return {
          epoch: authority.epoch,
          version: authority.version,
          doc: authority.doc.toJSON() as PageDocument,
          revision: authority.known.revision,
          saved: authority.saved,
          clientID,
          token: tokenFor(clientID),
          ...(stored ? { stored } : {}),
          ...(start ? { start } : {}),
        };
      },
      since: async (epoch, version) => {
        await this.latency();
        gate();
        if (epoch !== this.authority.epoch) throw { status: 410, code: "COLLAB_RESET" };
        try {
          return this.authority.since(version);
        } catch (error) {
          throw asHttp(error);
        }
      },
      send: async (body) => {
        await this.latency();
        gate();
        const size = Buffer.byteLength(JSON.stringify(body));
        this.bytes.set(name, [...(this.bytes.get(name) ?? []), size]);
        if (size > this.bodyLimit) throw { status: 413, code: "FST_ERR_CTP_BODY_TOO_LARGE", message: "Request body is too large" };
        if (body.epoch !== this.authority.epoch) throw { status: 410, code: "COLLAB_RESET" };
        if (!body.clientID.startsWith(`${account}/`) || body.token !== tokenFor(body.clientID)) throw { status: 410, code: "COLLAB_REJOIN", message: "Join this page again to go on editing." };
        this.sent.set(name, [...(this.sent.get(name) ?? []), body.steps.length]);
        let batch: CollabBatch;
        try {
          batch = this.authority.receive(body.version, body.steps, body.clientID);
        } catch (error) {
          throw asHttp(error);
        }
        if (batch.steps.length) this.broadcast(batch);
        if (body.flush) this.persist();
        await this.latency();
        if (batch.steps.length && this.dropAnswer.delete(name)) throw { status: 0, code: null, message: "The connection dropped." };
        return { ...batch, saved: this.authority.saved, revision: this.revision };
      },
    };
  }
}

let pages = 0;
/** One page's drafts in one tab (`sessionStorage` in the app). `value`: the latest. */
function memoryDrafts(key = `page-${(pages += 1)}`): DraftStore & { value: Draft | null; entries: Map<string, Draft>; full: boolean } {
  const entries = new Map<string, Draft>();
  return {
    key,
    entries,
    full: false,
    get value() {
      return [...entries.values()].sort((a, b) => a.at - b.at).at(-1) ?? null;
    },
    set value(draft: Draft | null) {
      entries.clear();
      if (draft) entries.set(draft.clientID, structuredClone(draft));
    },
    read() {
      return [...entries.values()].map((draft) => structuredClone(draft));
    },
    write(draft) {
      if (this.full) return false;
      entries.set(draft.clientID, structuredClone(draft));
      return true;
    },
    clear(clientID) {
      entries.delete(clientID);
    },
  };
}

type Tab = { name: string; editor: Editor; session: CollabSession; status: () => CollabStatus; close: () => void; drafts: ReturnType<typeof memoryDrafts>; restored: () => number };

async function open(server: Server, name: string, drafts = memoryDrafts(), options: { tab?: CollabTab; account?: string; transport?: CollabTransport; errors?: string[]; sendBytes?: number } = {}): Promise<Tab> {
  let status: CollabStatus = "saved";
  let restored = 0;
  const session = new CollabSession({
    transport: options.transport ?? server.transport(name, options.account),
    drafts,
    tab: options.tab,
    sendBytes: options.sendBytes,
    onError: (message) => options.errors?.push(message),
    live: () => true,
    delays: { live: 3, alone: 3, retry: 5, maxRetry: 20, draft: 5 },
    onStatus: (next) => (status = next),
    onRestored: () => (restored += 1),
  });
  const joined = await session.join();
  const editor = new Editor({ extensions: [...editorExtensions(() => [], ""), CollabSync.configure({ version: joined.version, clientID: joined.clientID })], content: joined.doc });
  const detach = session.attach(editor);
  const stop = server.subscribe(name, { steps: (batch) => session.receive(batch), saved: (epoch, saved) => session.noteSaved(epoch, saved) });
  return {
    name,
    editor,
    session,
    drafts,
    status: () => status,
    restored: () => restored,
    close: () => {
      stop();
      session.close();
      detach();
      editor.destroy();
    },
  };
}

/** Positions between words: the start of a text block, or just after a space. */
function boundaries(editor: Editor): number[] {
  const out: number[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const text = node.textContent;
    out.push(pos + 1);
    for (let at = 1; at <= text.length; at += 1) if (text[at - 1] === " ") out.push(pos + 1 + at);
    return false;
  });
  return out;
}

let serial = 0;
/** Types a unique word (and a space) at a word boundary, mostly at the same few spots. */
function typeWord(tab: Tab, rand: () => number, typed: string[]): void {
  const spots = boundaries(tab.editor);
  const spot = rand() < 0.7 ? spots[Math.min(spots.length - 1, Math.floor(rand() * 2))]! : spots[Math.floor(rand() * spots.length)]!;
  const word = `${tab.name}${(serial += 1)}`;
  typed.push(word);
  tab.editor.chain().setTextSelection(spot).insertContent(`${word} `).run();
}

function pressEnter(tab: Tab, rand: () => number): void {
  const spots = boundaries(tab.editor);
  tab.editor.chain().setTextSelection(spots[Math.floor(rand() * spots.length)]!).splitBlock().run();
}

function deleteSome(tab: Tab, rand: () => number): void {
  const { doc } = tab.editor.state;
  const from = 1 + Math.floor(rand() * Math.max(1, doc.content.size - 2));
  const to = Math.min(doc.content.size - 1, from + 1 + Math.floor(rand() * 6));
  if (to > from) tab.editor.commands.deleteRange({ from, to });
}

async function settle(server: Server, tabs: Tab[]): Promise<void> {
  for (let round = 0; round < 400; round += 1) {
    await server.quiet();
    await Promise.all(tabs.map((tab) => tab.session.flush()));
    await server.quiet();
    await sleep(5);
    const version = server.authority.version;
    const live = server.authority.doc.toJSON() as PageDocument;
    const done = tabs.every((tab) => tab.status() === "saved" && sameDoc(tab.editor.getJSON() as PageDocument, live) && tab.session.caretVersion() === version);
    if (done) return;
  }
  throw new Error(`did not converge: ${tabs.map((tab) => `${tab.name}=${tab.status()}`).join(", ")}`);
}

const words = (doc: PageDocument | Editor) => {
  const text = "getJSON" in doc ? doc.state.doc.textBetween(0, doc.state.doc.content.size, " ") : pageDoc(doc).textBetween(0, pageDoc(doc).content.size, " ");
  return text.split(/\s+/).filter(Boolean);
};

function assertConverged(server: Server, tabs: Tab[]): void {
  server.persist();
  const json = server.authority.doc.toJSON();
  for (const tab of tabs) assert.deepEqual(tab.editor.getJSON(), json, `${tab.name} has the server's document`);
  assert.deepEqual(pageDoc(server.stored).toJSON(), json, "the written-back page is the live one");
}

const START: PageDocument = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Agenda " }] }, { type: "paragraph", content: [{ type: "text", text: "Notes " }] }] };

for (const seed of [1, 2, 3]) {
  test(`three tabs typing and pressing Enter at the same spot converge and keep every word (seed ${seed})`, async () => {
    const rand = random(seed);
    const server = new Server(START, rand);
    const tabs = [await open(server, "a"), await open(server, "b"), await open(server, "c")];
    const typed: string[] = [];
    try {
      for (let op = 0; op < 120; op += 1) {
        const tab = tabs[Math.floor(rand() * tabs.length)]!;
        if (rand() < 0.8) typeWord(tab, rand, typed);
        else pressEnter(tab, rand);
        if (rand() < 0.3) await sleep(Math.floor(rand() * 4));
        if (op === 60) server.persist();
      }
      await settle(server, tabs);
      assertConverged(server, tabs);
      const final = words(server.stored);
      for (const word of typed) assert.equal(final.filter((item) => item === word).length, 1, `${word} is on the page once`);
    } finally {
      for (const tab of tabs) tab.close();
    }
  });
}

test("deletes and Undo from several tabs still converge, and Undo only takes back your own typing", async () => {
  const rand = random(7);
  const server = new Server(START, rand);
  const tabs = [await open(server, "a"), await open(server, "b"), await open(server, "c")];
  const typed: string[] = [];
  try {
    for (let op = 0; op < 150; op += 1) {
      const tab = tabs[Math.floor(rand() * tabs.length)]!;
      const roll = rand();
      if (roll < 0.55) typeWord(tab, rand, typed);
      else if (roll < 0.7) pressEnter(tab, rand);
      else if (roll < 0.9) deleteSome(tab, rand);
      else tab.editor.commands.undo();
      if (rand() < 0.3) await sleep(Math.floor(rand() * 4));
    }
    await settle(server, tabs);
    assertConverged(server, tabs);

    // A quiet moment: b types a word, a's word arrives, b's Undo removes b's word only.
    const [a, b] = tabs as [Tab, Tab];
    b.editor.chain().setTextSelection(1).insertContent("mine ").run();
    await settle(server, tabs);
    a.editor.chain().setTextSelection(1).insertContent("theirs ").run();
    await settle(server, tabs);
    b.editor.commands.undo();
    await settle(server, tabs);
    const now = words(server.authority.doc.toJSON() as PageDocument);
    assert.ok(now.includes("theirs"));
    assert.ok(!now.includes("mine"));
    assertConverged(server, tabs);
  } finally {
    for (const tab of tabs) tab.close();
  }
});

test("a tab that goes offline keeps its typing, says so, and catches up when it is back", async () => {
  const rand = random(11);
  const server = new Server(START, rand);
  const tabs = [await open(server, "a"), await open(server, "b")];
  const [a, b] = tabs as [Tab, Tab];
  const typed: string[] = [];
  try {
    server.offline.add("b");
    for (let op = 0; op < 40; op += 1) {
      typeWord(op % 2 ? a : b, rand, typed);
      await sleep(1);
    }
    await until(() => b.status() === "offline", "the offline status");
    assert.ok(b.drafts.value, "unsent typing is kept as a draft while offline");
    server.offline.delete("b");
    b.session.retryNow();
    await settle(server, tabs);
    assertConverged(server, tabs);
    const final = words(server.stored);
    for (const word of typed) assert.equal(final.filter((item) => item === word).length, 1, `${word} is on the page once`);
    assert.equal(b.drafts.value, null, "the draft goes once everything is saved");
  } finally {
    for (const tab of tabs) tab.close();
  }
});

test("the server restarting mid-typing loses nothing: tabs reload and propose their unsent typing again", async () => {
  const rand = random(19);
  const server = new Server(START, rand);
  const tabs = [await open(server, "a"), await open(server, "b"), await open(server, "c")];
  const typed: string[] = [];
  try {
    for (let op = 0; op < 90; op += 1) {
      typeWord(tabs[op % 3]!, rand, typed);
      if (op % 30 === 15) server.restart();
      if (rand() < 0.3) await sleep(Math.floor(rand() * 4));
    }
    await settle(server, tabs);
    assertConverged(server, tabs);
    const final = words(server.stored);
    for (const word of typed) assert.equal(final.filter((item) => item === word).length, 1, `${word} is on the page once`);
  } finally {
    for (const tab of tabs) tab.close();
  }
});

test("a write from elsewhere lands in every tab next to what is being typed", async () => {
  const rand = random(23);
  const server = new Server(START, rand);
  const tabs = [await open(server, "a"), await open(server, "b")];
  const typed: string[] = [];
  try {
    for (let op = 0; op < 30; op += 1) {
      typeWord(tabs[op % 2]!, rand, typed);
      if (op === 10 || op === 20) {
        server.external((doc) => ({ ...doc, content: [...doc.content, { type: "paragraph", content: [{ type: "text", text: `Assistant${op}` }] }] }));
      }
      await sleep(1);
    }
    await settle(server, tabs);
    assertConverged(server, tabs);
    const final = words(server.stored);
    for (const word of [...typed, "Assistant10", "Assistant20"]) assert.equal(final.filter((item) => item === word).length, 1, `${word} is on the page once`);
  } finally {
    for (const tab of tabs) tab.close();
  }
});

test("a session that expires mid-edit keeps the typing as a draft and puts it back after signing in", async () => {
  const rand = random(29);
  const server = new Server(START, rand);
  const other = await open(server, "other");
  const drafts = memoryDrafts();
  let tab = await open(server, "me", drafts);
  try {
    server.signedOut.add("me");
    tab.editor.chain().setTextSelection(1).insertContent("Unsent words ").run();
    await until(() => tab.status() === "error", "the refused session");
    assert.ok(drafts.value, "the draft is written before the app goes to sign in");
    tab.close();
    other.editor.chain().setTextSelection(boundaries(other.editor).at(-1)!).insertContent("Meanwhile ").run();
    await settle(server, [other]);

    server.signedOut.delete("me");
    tab = await open(server, "me-again", drafts);
    assert.equal(tab.restored(), 1);
    await settle(server, [tab, other]);
    assertConverged(server, [tab, other]);
    const final = words(server.stored);
    assert.ok(final.includes("Unsent"));
    assert.ok(final.includes("Meanwhile"));
    assert.equal(drafts.value, null);
  } finally {
    tab.close();
    other.close();
  }
});

test("other people's carets sent from an older version land where they meant", async () => {
  const rand = random(31);
  const server = new Server({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello world" }] }] }, rand);
  const tabs = [await open(server, "a"), await open(server, "b")];
  const [a, b] = tabs as [Tab, Tab];
  try {
    const version = b.session.caretVersion()!;
    // b's caret sits before "world"; a then types at the start.
    const caret = { anchor: 7, head: 7, version };
    a.editor.chain().setTextSelection(1).insertContent("Oh, ").run();
    await settle(server, tabs);
    const placed = a.session.place(caret)!;
    assert.equal(a.editor.state.doc.textBetween(placed.head, placed.head + 5), "world");
    assert.equal(a.session.place({ anchor: 1, head: 1 }), null, "a caret with no version is placed as before");
  } finally {
    for (const tab of tabs) tab.close();
  }
});

// ── Review findings: drafts, durability, large batches, refusals ─────────────────────────────

test("the server crashing loses no typing: confirmed but unwritten words go again from their authors, once", async () => {
  for (const seed of [41, 42, 43]) {
    const rand = random(seed);
    const server = new Server(START, rand);
    const tabs = [await open(server, "a"), await open(server, "b"), await open(server, "c")];
    const typed: string[] = [];
    try {
      for (let op = 0; op < 90; op += 1) {
        typeWord(tabs[op % 3]!, rand, typed);
        if (op % 30 === 10) server.persist();
        if (op % 30 === 20) server.crash();
        if (rand() < 0.3) await sleep(Math.floor(rand() * 4));
      }
      await settle(server, tabs);
      assertConverged(server, tabs);
      const final = words(server.stored);
      for (const word of typed) assert.equal(final.filter((item) => item === word).length, 1, `seed ${seed}: ${word} is on the page once`);
    } finally {
      for (const tab of tabs) tab.close();
    }
  }
});

test("typing stays 'Saving…' and in the draft until the server reports it written back", async () => {
  const server = new Server(START, random(47));
  const tab = await open(server, "me");
  try {
    tab.editor.chain().setTextSelection(1).insertContent("Durable ").run();
    await until(() => tab.session.caretVersion() !== null, "the server confirming the typing");
    await server.quiet();
    assert.equal(tab.status(), "saving", "confirmed is not yet written back");
    await until(() => tab.drafts.value !== null, "the draft, written shortly after sending");
    server.persist();
    await server.quiet();
    assert.equal(tab.status(), "saved");
    assert.equal(tab.drafts.value, null);
  } finally {
    tab.close();
  }
});

test("a draft whose steps the server already took (lost answer, then a reload) is not typed twice", async () => {
  const server = new Server(START, random(53));
  const other = await open(server, "other");
  const drafts = memoryDrafts();
  let tab = await open(server, "me", drafts);
  try {
    // The steps reach the server but the answer is lost, and the tab is offline from then on.
    server.dropAnswer.add("me");
    tab.editor.chain().setTextSelection(1).insertContent("brave new ").run();
    await until(() => tab.status() === "offline", "the lost answer");
    server.offline.add("me");
    tab.close();
    await until(() => !server.dropAnswer.has("me"), "the steps reaching the server");
    assert.ok(drafts.value, "the draft is kept: the tab cannot tell the steps arrived");
    other.editor.chain().setTextSelection(1).insertContent("Hello ").run();
    await settle(server, [other]);

    server.offline.delete("me");
    tab = await open(server, "me-again", drafts);
    await settle(server, [tab, other]);
    assertConverged(server, [tab, other]);
    const final = words(server.stored);
    assert.equal(final.filter((word) => word === "brave").length, 1, "typed once, not again from the draft");
    assert.ok(final.includes("Hello"));
  } finally {
    tab.close();
    other.close();
  }
});

test("a draft written while its steps were on the way (pagehide), then a reload, is not typed twice", async () => {
  const server = new Server(START, random(59));
  const tab = await open(server, "me");
  let kept: Draft | null = null;
  try {
    tab.editor.chain().setTextSelection(1).insertContent("in flight ").run();
    tab.session.keepDraft();
    kept = structuredClone(tab.drafts.value);
    assert.ok(kept?.steps.length, "the draft holds the steps not yet confirmed");
    await settle(server, [tab]);
  } finally {
    tab.close();
  }
  const reloaded = memoryDrafts();
  reloaded.value = kept;
  const again = await open(server, "me-reloaded", reloaded);
  try {
    await settle(server, [again]);
    assert.equal(words(server.stored).filter((word) => word === "flight").length, 1);
    assert.equal(again.restored(), 0, "nothing was missing, so nothing was put back");
  } finally {
    again.close();
  }
});

test("more than a thousand unsent steps go out in requests of at most 200", async () => {
  const server = new Server(START, random(61));
  const tab = await open(server, "me");
  try {
    server.offline.add("me");
    for (let at = 0; at < 1200; at += 1) tab.editor.chain().setTextSelection(1).insertContent("x").run();
    await until(() => tab.status() === "offline", "offline");
    server.offline.delete("me");
    tab.session.retryNow();
    await settle(server, [tab]);
    assert.equal(words(server.stored)[0], `${"x".repeat(1200)}Agenda`);
    assert.ok(Math.max(...server.sent.get("me")!) <= 200, "no request carries more than 200 steps");
  } finally {
    tab.close();
  }
});

test("a change the server refuses is not resent in a storm: the page says so once and keeps the text", async () => {
  const server = new Server(START, random(67));
  let sends = 0;
  const errors: string[] = [];
  const base = server.transport("me");
  const drafts = memoryDrafts();
  const session = new CollabSession({
    transport: {
      ...base,
      send: async () => {
        sends += 1;
        throw { status: 400, code: "COLLAB_REJECTED", message: "This change does not fit the page." };
      },
    },
    drafts,
    delays: { live: 3, alone: 3, retry: 40, maxRetry: 400 },
    onError: (message) => errors.push(message),
  });
  const joined = await session.join();
  const editor = new Editor({ extensions: [...editorExtensions(() => [], ""), CollabSync.configure({ version: joined.version, clientID: joined.clientID })], content: joined.doc });
  const detach = session.attach(editor);
  try {
    editor.chain().setTextSelection(1).insertContent("Refused ").run();
    await sleep(250);
    assert.ok(sends <= 4, `backed off (${sends} sends)`);
    assert.equal(session.status, "error");
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /Reload the page/);
    assert.ok(drafts.value, "the text is kept");
  } finally {
    session.freeze();
    detach();
    editor.destroy();
  }
});

test("a page moved to Trash while typing keeps the unsaved text as a draft, for after Restore", async () => {
  const server = new Server(START, random(71));
  const base = server.transport("me");
  const drafts = memoryDrafts();
  let lost = 0;
  const session = new CollabSession({
    transport: { ...base, send: async () => Promise.reject({ status: 404, code: "PAGE_IN_TRASH", message: "This page is in Trash." }) },
    drafts,
    delays: { live: 3, alone: 3, retry: 5, maxRetry: 20 },
    onLost: () => (lost += 1),
  });
  const joined = await session.join();
  const editor = new Editor({ extensions: [...editorExtensions(() => [], ""), CollabSync.configure({ version: joined.version, clientID: joined.clientID })], content: joined.doc });
  const detach = session.attach(editor);
  try {
    editor.chain().setTextSelection(1).insertContent("Not yet saved ").run();
    await until(() => lost === 1, "the page in Trash");
    assert.equal(session.status, "lost");
    assert.ok(drafts.value?.steps.length, "the typing stays in the draft");
  } finally {
    detach();
    editor.destroy();
  }
});

// ── Re-review: drafts per editor, refused steps, rejoining ───────────────────────────────────

/** Web Locks shared by the tabs of one browser. */
function sharedLocks() {
  const held = new Set<string>();
  return {
    async request(name: string, callback: () => Promise<void>) {
      held.add(name);
      try {
        await callback();
      } finally {
        held.delete(name);
      }
    },
    async query() {
      return { held: [...held].map((name) => ({ name })) };
    },
  };
}

/** A tab's transport whose step requests wait until `open()` is called. */
function gated(transport: CollabTransport) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let waiting = 0;
  return {
    transport: {
      ...transport,
      send: async (body: Parameters<CollabTransport["send"]>[0]) => {
        if (body.steps.length) {
          waiting += 1;
          await gate;
        }
        return transport.send(body);
      },
    } satisfies CollabTransport,
    open: () => release(),
    waiting: () => waiting,
  };
}

/** No liveness at all: what the editor did before drafts were kept per editor. */
const noTab: CollabTab = { hold: () => () => undefined, take: async (ids) => ids, give: () => undefined, applied: () => false, claim: () => true, finishing: () => undefined, settled: async () => undefined };

/** The closing editor's typing lands after the page opened again (`late`), or a moment after it closed. */
async function closeAndReopenAtOnce(tab: CollabTab, late: boolean): Promise<number> {
  const server = new Server(START, random(73));
  const drafts = memoryDrafts();
  const first = gated(server.transport("peek"));
  const peek = await open(server, "peek", drafts, { tab, transport: first.transport });
  peek.editor.chain().setTextSelection(1).insertContent("Hello ").run();
  await until(() => first.waiting() > 0, "the typing on its way");
  // Task peek → "Open as full page": the peek closes with its typing in flight, the page opens in the same tab.
  peek.close();
  if (!late) setTimeout(first.open, 30);
  const page = await open(server, "page", drafts, { tab });
  if (late) first.open();
  try {
    await settle(server, [page]);
    return words(server.stored).filter((word) => word === "Hello").length;
  } finally {
    page.close();
  }
}

test("a page closed and opened again at once in the same tab does not type the closing editor's words twice", async () => {
  assert.equal(await closeAndReopenAtOnce(noTab, true), 2, "without waiting for the closing editor, its words come twice");
  assert.equal(await closeAndReopenAtOnce(collabTab(null), false), 1);
});

async function duplicateTab(second: CollabTab, locks: ReturnType<typeof sharedLocks>): Promise<{ count: number; restored: number }> {
  const server = new Server(START, random(79));
  const original = memoryDrafts("page");
  const first = gated(server.transport("one"));
  const one = await open(server, "one", original, { tab: collabTab(locks), transport: first.transport });
  one.editor.chain().setTextSelection(1).insertContent("Hello ").run();
  await until(() => first.waiting() > 0, "the typing on its way");
  one.session.keepDraft();
  // Chrome's "Duplicate tab" copies this tab's storage, drafts and all.
  const copy = memoryDrafts("page");
  copy.value = original.value;
  const two = await open(server, "two", copy, { tab: second });
  first.open();
  try {
    await settle(server, [one, two]);
    return { count: words(server.stored).filter((word) => word === "Hello").length, restored: two.restored() };
  } finally {
    one.close();
    two.close();
  }
}

test("a duplicated tab does not take over the drafts of the tab it was copied from while that one is open", async () => {
  const locks = sharedLocks();
  assert.deepEqual(await duplicateTab(collabTab(null), locks), { count: 2, restored: 1 }, "without Web Locks the copy puts the words back a second time");
  assert.deepEqual(await duplicateTab(collabTab(locks), locks), { count: 1, restored: 0 });
});

test("drafts are kept per page and editor, and only the same account takes one over", async () => {
  const server = new Server(START, random(83));
  const drafts = memoryDrafts();
  let theirs = await open(server, "theirs", drafts, { account: "u2" });
  server.offline.add("theirs");
  theirs.editor.chain().setTextSelection(1).insertContent("Offline words ").run();
  await until(() => theirs.status() === "offline", "offline");
  theirs.close();
  // Opening the page waits for the closing editor, which cannot send (offline) and keeps its draft.
  const mine = await open(server, "mine", drafts, { account: "u1" });
  try {
    await settle(server, [mine]);
    assert.equal(mine.restored(), 0, "another account's draft is not put back");
    assert.equal(drafts.entries.size, 1, "and is left for that account");
  } finally {
    mine.close();
  }
  server.offline.delete("theirs");
  theirs = await open(server, "theirs-again", drafts, { account: "u2" });
  try {
    await settle(server, [theirs]);
    assert.equal(theirs.restored(), 1);
    assert.equal(words(server.stored).filter((word) => word === "Offline").length, 1);
    assert.equal(drafts.entries.size, 0);
  } finally {
    theirs.close();
  }
});

test("a step the server refuses is taken out of the page and the queue; the typing after it is saved", async () => {
  const server = new Server(START, random(89));
  const errors: string[] = [];
  const drafts = memoryDrafts();
  const tab = await open(server, "me", drafts, { errors });
  const other = await open(server, "other");
  try {
    server.offline.add("me");
    tab.editor.chain().setTextSelection(1).insertContent("Before ").run();
    // A character pages cannot store, typed without a paste (pastes are cleaned).
    tab.editor.chain().insertContent("bad\u0000char ").run();
    tab.editor.chain().insertContent("After ").run();
    await until(() => tab.status() === "offline", "offline");
    server.offline.delete("me");
    tab.session.retryNow();
    await settle(server, [tab, other]);
    assertConverged(server, [tab, other]);
    assert.deepEqual(words(server.stored).slice(0, 3), ["Before", "After", "Agenda"]);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /cannot store \(U\+0000\)\. That change was taken out of the page/);
    assert.equal(drafts.value, null, "nothing left unsaved, and no draft that would put it back");
  } finally {
    tab.close();
    other.close();
  }
});

test("a step that grows the page past its limit is taken back; deleting from a page over the limit still works", async () => {
  const big = "x".repeat(60);
  const server = new Server({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: big }] }] }, random(97));
  server.authority = new Authority(pageSchema, { doc: pageDoc(server.stored), revision: 1, raw: server.stored }, { ...LIMITS, docSize: 40 });
  const errors: string[] = [];
  const tab = await open(server, "me", memoryDrafts(), { errors });
  try {
    tab.editor.chain().setTextSelection(2).insertContent("more").run();
    await until(() => errors.length === 1, "the refusal");
    await settle(server, [tab]);
    assert.equal(tab.editor.getText(), big, "the growth is taken back");
    tab.editor.commands.deleteRange({ from: 2, to: 12 });
    await settle(server, [tab]);
    assert.equal(words(server.stored)[0], "x".repeat(50), "shrinking is never refused");
  } finally {
    tab.close();
  }
});

test("pasted text loses U+0000 and half emoji before it is sent", async () => {
  const server = new Server(START, random(101));
  const tab = await open(server, "me");
  try {
    tab.editor.commands.setTextSelection(1);
    tab.editor.view.pasteText("a\u0000b \ud83d c 😀 ", new Event("paste") as ClipboardEvent);
    await settle(server, [tab]);
    assert.deepEqual(words(server.stored).slice(0, 4), ["ab", "�", "c", "😀"]);
  } finally {
    tab.close();
  }
});

test("an editor asked to join again (a session expired on a public link) takes a new id and goes on, no loop", async () => {
  const server = new Server(START, random(103));
  const base = server.transport("me", "user");
  let account = "user";
  let joins = 0;
  let sends = 0;
  // The session expired: requests now come from the link's anonymous visitor, as the API sees them.
  const transport: CollabTransport = {
    join: async (options) => {
      joins += 1;
      return account === "user" ? base.join(options) : server.transport("me", "visitor").join(options);
    },
    since: (epoch, version) => base.since(epoch, version),
    send: async (body) => {
      sends += 1;
      return (account === "user" ? base : server.transport("me", "visitor")).send(body);
    },
  };
  const tab = await open(server, "me", memoryDrafts(), { transport });
  try {
    account = "visitor";
    tab.editor.chain().setTextSelection(1).insertContent("Still typing ").run();
    await settle(server, [tab]);
    assert.ok(tab.session.clientID.startsWith("visitor/"));
    assert.equal(joins, 2);
    assert.ok(sends < 10, `no loop (${sends} sends)`);
    assert.equal(words(server.stored).filter((word) => word === "Still").length, 1);
  } finally {
    tab.close();
  }
});

test("the draft is written a little after typing is sent, at once on leaving, and a full storage is said once", async () => {
  const server = new Server(START, random(107));
  const drafts = memoryDrafts();
  const errors: string[] = [];
  const tab = await open(server, "me", drafts, { errors });
  try {
    server.offline.add("me");
    drafts.full = true;
    tab.editor.chain().setTextSelection(1).insertContent("one ").run();
    await until(() => errors.length === 1, "the full storage, said");
    tab.editor.chain().insertContent("two ").run();
    tab.session.keepDraft();
    tab.session.keepDraft();
    assert.equal(errors.length, 1, "said once");
    assert.match(errors[0]!, /storage is full/);
    drafts.full = false;
    tab.session.keepDraft();
    assert.equal(drafts.value?.steps.length, 2, "kept once there is room again");
  } finally {
    tab.close();
  }
});

// ── Final check: same-server catch-up, restarts after closing, duplicated drafts, large requests ──

const NOTES = { type: "paragraph", content: [{ type: "text", text: "Notes" }] };
const LIST: PageDocument = { type: "doc", content: [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Agenda" }] }] }] }, NOTES] };
const AGENDA: PageDocument = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Agenda" }] }, NOTES] };

/**
 * A types offline (its event stream down too) while B types enough for the server's log (three
 * steps) to drop A's version; then A comes back and catches up on the same server.
 */
async function behindTheLog(start: PageDocument, mine: (editor: Editor) => void, theirs: (editor: Editor) => void): Promise<string[]> {
  const server = new Server(start, random(109), { ...LIMITS, log: 3 });
  const a = await open(server, "a");
  const b = await open(server, "b");
  try {
    server.offline.add("a");
    server.deaf.add("a");
    mine(a.editor);
    await until(() => a.status() === "offline", "a offline");
    theirs(b.editor);
    // More typing in the last paragraph, so the log moves on.
    for (const word of [" one", " two", " three", " four"]) b.editor.chain().setTextSelection(b.editor.state.doc.content.size - 1).insertContent(word).run();
    await settle(server, [b]);
    assert.ok(server.authority.first > 0, "the log no longer reaches back to a's version");
    server.offline.delete("a");
    server.deaf.delete("a");
    a.session.retryNow();
    await settle(server, [a, b]);
    assertConverged(server, [a, b]);
    const out: string[] = [];
    pageDoc(server.stored).descendants((node) => {
      if (node.isTextblock) out.push(node.textContent);
      return !node.isTextblock;
    });
    return out;
  } finally {
    a.close();
    b.close();
  }
}

const endOfFirstBlock = (editor: Editor) => {
  let end = 0;
  editor.state.doc.descendants((node, pos) => {
    if (!end && node.isTextblock) end = pos + node.nodeSize - 1;
    return !end;
  });
  return end;
};

test("catching up on the same server keeps two new list items whole and apart, not merged word by word", async () => {
  const item = (text: string) => (editor: Editor) => editor.chain().setTextSelection(endOfFirstBlock(editor)).splitListItem("listItem").insertContent(text).run();
  const blocks = await behindTheLog(LIST, item("Send the deck to the board"), item("Book the room for the offsite"));
  // Both items whole, each its own item, after Agenda (which of the two comes first is the rebase's order).
  assert.equal(blocks.length, 4, JSON.stringify(blocks));
  assert.deepEqual([blocks[0], blocks[3]], ["Agenda", "Notes one two three four"]);
  assert.deepEqual(blocks.slice(1, 3).sort(), ["Book the room for the offsite", "Send the deck to the board"]);
});

test("catching up on the same server keeps typing in one paragraph whole, not interleaved", async () => {
  const typing = (text: string) => (editor: Editor) => editor.chain().setTextSelection(endOfFirstBlock(editor)).insertContent(text).run();
  const [text] = await behindTheLog(AGENDA, typing(" ship the app"), typing(" draft the review"));
  assert.equal(text, "Agenda draft the review ship the app");
});

test("a page closed while its last request meets a restart stops, keeps the draft, and the page opening again takes it", async () => {
  const server = new Server(START, random(113));
  const drafts = memoryDrafts();
  const base = server.transport("closing");
  let sends = 0;
  const closing = await open(server, "closing", drafts, { transport: { ...base, send: (body) => ((sends += 1), base.send(body)) } });
  closing.editor.chain().setTextSelection(1).insertContent("Typed before the deploy ").run();
  server.crash();
  closing.close();
  await sleep(150);
  assert.ok(sends <= 3, `no storm of requests (${sends})`);
  assert.ok(drafts.value?.steps.length, "the typing is kept as a draft");
  const started = Date.now();
  const again = await open(server, "again", drafts);
  try {
    assert.ok(Date.now() - started < 2000, "the page opening again does not wait out the closed one");
    assert.equal(again.restored(), 1);
    await settle(server, [again]);
    assert.equal(words(server.stored).filter((word) => word === "deploy").length, 1);
  } finally {
    again.close();
  }
});

/** `localStorage`: shared by every tab of the browser. */
function sharedStorage() {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (at: number) => [...map.keys()][at] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

async function leftoverInDuplicate(shared: ReturnType<typeof sharedStorage> | null): Promise<number> {
  const server = new Server(START, random(127));
  const locks = sharedLocks();
  const original = memoryDrafts("page");
  // A page closed offline leaves a draft behind in this tab; its editor is gone.
  const gone = await open(server, "gone", original, { tab: collabTab(locks, shared) });
  server.offline.add("gone");
  gone.editor.chain().setTextSelection(1).insertContent("Offline ").run();
  await until(() => gone.status() === "offline", "offline");
  gone.close();
  await sleep(30);
  // The tab is duplicated, drafts and all; then the page opens in both tabs.
  const copy = memoryDrafts("page");
  copy.value = original.value;
  const one = await open(server, "one", original, { tab: collabTab(locks, shared) });
  const two = await open(server, "two", copy, { tab: collabTab(locks, shared) });
  try {
    await settle(server, [one, two]);
    assert.equal(copy.entries.size, 0, "the copy is gone either way");
    return words(server.stored).filter((word) => word === "Offline").length;
  } finally {
    one.close();
    two.close();
  }
}

test("a draft left behind and copied into a duplicated tab is put back once, not by both tabs", async () => {
  assert.equal(await leftoverInDuplicate(null), 2, "with nothing shared between tabs, both put it back");
  assert.equal(await leftoverInDuplicate(sharedStorage()), 1);
});

test("unsent steps go out in requests of at most the byte limit (one step however large)", async () => {
  const server = new Server(START, random(131));
  const tab = await open(server, "me", memoryDrafts(), { sendBytes: 100_000 });
  try {
    server.offline.add("me");
    for (let at = 0; at < 5; at += 1) tab.editor.chain().setTextSelection(1).insertContent(`${"漢".repeat(20_000)} `).run();
    tab.editor.chain().setTextSelection(1).insertContent(`${"字".repeat(50_000)} `).run();
    await until(() => tab.status() === "offline", "offline");
    server.offline.delete("me");
    tab.session.retryNow();
    await settle(server, [tab]);
    const sizes = server.bytes.get("me")!.filter((size) => size > 1000);
    assert.ok(sizes.length >= 4, `split into several requests (${sizes.join(", ")})`);
    assert.ok(sizes.every((size) => size <= 100_000 + 1000 || size > 150_000), `each at most the limit, or one large step (${sizes.join(", ")})`);
    assert.equal(words(server.stored).length, words(START).length + 6);
  } finally {
    tab.close();
  }
});

test("a step too large for the API's body limit is taken back once, and the rest is saved", async () => {
  const server = new Server(START, random(137));
  server.bodyLimit = 50_000;
  const errors: string[] = [];
  const tab = await open(server, "me", memoryDrafts(), { errors, sendBytes: 10_000 });
  try {
    server.offline.add("me");
    tab.editor.chain().setTextSelection(1).insertContent("Before ").run();
    tab.editor.chain().insertContent(`${"x".repeat(60_000)} `).run();
    tab.editor.chain().insertContent("After ").run();
    await until(() => tab.status() === "offline", "offline");
    server.offline.delete("me");
    tab.session.retryNow();
    await settle(server, [tab]);
    assert.deepEqual(words(server.stored).slice(0, 3), ["Before", "After", "Agenda"]);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /too large to save in one piece/);
    assert.ok(server.bytes.get("me")!.filter((size) => size > server.bodyLimit).length <= 2, "not sent again and again");
  } finally {
    tab.close();
  }
});

test("a refusal whose step index went stale (others' steps arrived meanwhile) is asked again, not applied to the wrong step", async () => {
  const server = new Server({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Keep Notes here" }] }] }, random(139));
  const other = await open(server, "other");
  const base = server.transport("me");
  let first = true;
  const errors: string[] = [];
  const transport: CollabTransport = {
    ...base,
    send: async (body) => {
      try {
        return await base.send(body);
      } catch (error) {
        if (first && (error as { code?: string }).code === "COLLAB_REJECTED") {
          first = false;
          // Before the refusal arrives, someone deletes the word this tab deleted: its first step goes on rebase.
          other.editor.commands.deleteRange({ from: 5, to: 12 });
          await settle(server, [other]);
          await server.quiet();
        }
        throw error;
      }
    },
  };
  const tab = await open(server, "me", memoryDrafts(), { transport, errors });
  try {
    server.offline.add("me");
    tab.editor.commands.deleteRange({ from: 6, to: 11 });
    tab.editor.chain().setTextSelection(1).insertContent("bad\u0000char ").run();
    tab.editor.chain().insertContent("After ").run();
    await until(() => tab.status() === "offline", "offline");
    server.offline.delete("me");
    tab.session.retryNow();
    await settle(server, [tab, other]);
    assertConverged(server, [tab, other]);
    const final = words(server.stored);
    assert.ok(final.includes("After"), `the step after the refused one stays (${final.join(" ")})`);
    assert.ok(!final.some((word) => word.includes("\u0000")));
    assert.equal(errors.length, 1);
  } finally {
    tab.close();
    other.close();
  }
});
