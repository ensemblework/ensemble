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
import { Authority, CollabError } from "../../../hub-api/src/pages/collab-core";
import { pageDoc, pageSchema } from "../../../hub-api/src/pages/schema";
import { editorExtensions } from "./extensions";
import { CollabSession, CollabSync, type CollabBatch, type CollabStatus, type CollabTransport, type Draft, type DraftStore } from "./collab";

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
const HTTP: Record<string, number> = { COLLAB_BEHIND: 409, COLLAB_RESET: 410, COLLAB_REJECTED: 400, COLLAB_TOO_LARGE: 413 };
const asHttp = (error: unknown) => (error instanceof CollabError ? { status: HTTP[error.code], code: error.code, data: error.batch, message: error.message } : error);

/** The API process: one authority, write-backs, the event stream, and a network that can fail. */
class Server {
  authority: Authority;
  stored: PageDocument;
  revision = 1;
  private readonly listeners = new Map<string, (batch: CollabBatch) => void>();
  private readonly lines = new Map<string, Promise<void>>();
  /** Clients whose requests fail as if offline, or with an expired session. */
  readonly offline = new Set<string>();
  readonly signedOut = new Set<string>();

  constructor(doc: PageDocument, private readonly rand: () => number) {
    this.stored = doc;
    this.authority = new Authority(pageSchema, { doc: pageDoc(doc), revision: 1, raw: doc });
  }

  private latency(): Promise<unknown> {
    return sleep(Math.floor(this.rand() * 6));
  }

  persist(): void {
    if (!this.authority.unsaved) return;
    this.revision += 1;
    this.stored = this.authority.doc.toJSON() as PageDocument;
    this.authority.persisted(this.revision, this.stored, this.authority.doc, this.authority.version);
  }

  /** A deploy: write back, then a fresh authority (new epoch, version 0) from the stored copy. */
  restart(): void {
    this.persist();
    this.authority = new Authority(pageSchema, { doc: pageDoc(this.stored), revision: this.revision, raw: this.stored });
  }

  /** The assistant writes from the stored copy; the authority takes it in. */
  external(edit: (doc: PageDocument) => PageDocument): void {
    this.stored = edit(structuredClone(this.stored));
    this.revision += 1;
    const batch = this.authority.absorb(this.stored, this.revision, pageDoc(this.stored));
    if (batch) this.broadcast(batch);
  }

  broadcast(batch: CollabBatch): void {
    for (const [name, listener] of this.listeners) {
      const line = (this.lines.get(name) ?? Promise.resolve()).then(() => this.latency()).then(() => listener(batch));
      this.lines.set(name, line);
    }
  }

  async quiet(): Promise<void> {
    await Promise.all(this.lines.values());
  }

  subscribe(name: string, listener: (batch: CollabBatch) => void): () => void {
    this.listeners.set(name, listener);
    return () => this.listeners.delete(name);
  }

  transport(name: string): CollabTransport {
    const gate = () => {
      if (this.offline.has(name)) throw { status: 0, code: null, message: "Ensemble can't reach its server right now." };
      if (this.signedOut.has(name)) throw { status: 401, code: null, message: "Sign in again." };
    };
    return {
      join: async () => {
        await this.latency();
        gate();
        const { authority } = this;
        return { epoch: authority.epoch, version: authority.version, doc: authority.doc.toJSON() as PageDocument, revision: authority.known.revision };
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
        if (body.epoch !== this.authority.epoch) throw { status: 410, code: "COLLAB_RESET" };
        let batch: CollabBatch;
        try {
          batch = this.authority.receive(body.version, body.steps, body.clientID);
        } catch (error) {
          throw asHttp(error);
        }
        if (batch.steps.length) this.broadcast(batch);
        if (body.flush) this.persist();
        await this.latency();
        return { ...batch, revision: this.revision };
      },
    };
  }
}

function memoryDrafts(): DraftStore & { value: Draft | null } {
  return {
    value: null,
    read() {
      return this.value;
    },
    write(draft) {
      this.value = structuredClone(draft);
    },
    clear() {
      this.value = null;
    },
  };
}

type Tab = { name: string; editor: Editor; session: CollabSession; status: () => CollabStatus; close: () => void; drafts: ReturnType<typeof memoryDrafts>; restored: () => number };

async function open(server: Server, name: string, drafts = memoryDrafts()): Promise<Tab> {
  let status: CollabStatus = "saved";
  let restored = 0;
  const session = new CollabSession({
    transport: server.transport(name),
    clientID: name,
    drafts,
    live: () => true,
    delays: { live: 3, alone: 3, retry: 5, maxRetry: 20 },
    onStatus: (next) => (status = next),
    onRestored: () => (restored += 1),
  });
  const joined = await session.join();
  const editor = new Editor({ extensions: [...editorExtensions(() => [], ""), CollabSync.configure({ version: joined.version, clientID: name })], content: joined.doc });
  const detach = session.attach(editor);
  const stop = server.subscribe(name, (batch) => session.receive(batch));
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
    await sleep(40);
    assert.equal(b.status(), "offline");
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
    await sleep(30);
    assert.equal(tab.status(), "error");
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
