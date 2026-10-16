/**
 * Live co-editing for one page in the block editor: prosemirror-collab on this side, the central
 * authority in hub-api (`src/pages/collab.ts`) on the other (docs/29 §5).
 *
 * The editor sends the steps you type (throttled, one request at a time, at most 200 steps in
 * one). The server answers with the steps since your version, confirming yours; steps it refuses
 * because someone else got in first come back with what you missed, your steps are rebased over
 * them and sent again. Everyone's steps also arrive over the event stream, and so does the last
 * version the server wrote back. Your typing counts as saved only once it is written back; until
 * then it is also kept as a draft in this tab, so a reload, an expired session or a crash of the
 * server does not lose it. When the server's document starts over (it restarted, or you were
 * too far behind), the steps of yours it lacks are proposed again, and only those.
 *
 * Drafts are kept per editor (its client id) and taken over only from editors that are gone:
 * one still sending in this tab (the page closed and opened again at once) or in another (a tab
 * duplicated with its storage) keeps its own. A step the server refuses (a character pages
 * cannot store, growth past the page limit) is taken out of the page and the queue, and the
 * rest is sent.
 */
import { Extension, type Editor } from "@tiptap/core";
import { collab, getVersion, receiveTransaction, sendableSteps } from "@tiptap/pm/collab";
import { Fragment, Slice, type Node as ProseNode, type Schema } from "@tiptap/pm/model";
import { EditorState, Plugin, type Transaction } from "@tiptap/pm/state";
import { Mapping, ReplaceStep, Step, type StepMap } from "@tiptap/pm/transform";
import type { PageDocument } from "@ensemble/shared-types";
import { mergeDocs, sameDoc } from "@ensemble/shared-types/page-merge";
import { diffSteps, rebaseSteps } from "./page-diff";

export type ClientID = string;
/**
 * `saved`: the last version the server wrote back. `clientID`: this editor's id, issued by the
 * server (the account's id, a slash, then random), and `token`, which goes with the steps it
 * sends. `stored` (asked for): the stored copy at its version, and the steps typed since, when
 * there are any. `start` (asked for when starting over): the document as the server loaded it,
 * the authority and version that had written it (`previous`), and the steps since.
 */
export type CollabJoin = {
  epoch: string;
  version: number;
  doc: PageDocument;
  revision: number;
  saved: number;
  clientID: ClientID;
  token?: string;
  stored?: Stored;
  start?: Start;
};
type Stored = { version: number; doc: PageDocument; steps: unknown[]; clientIDs: ClientID[] };
type Start = { doc: PageDocument; steps: unknown[]; clientIDs: ClientID[]; previous: { epoch: string; version: number } | null };
/** Steps `from` → `version`, with who sent each, and the last version written back. `revision` answers a flush. */
export type CollabBatch = { epoch: string; from: number; version: number; steps: unknown[]; clientIDs: ClientID[]; saved?: number; revision?: number };
export type CollabSend = { epoch: string; version: number; clientID: ClientID; token?: string; steps: unknown[]; flush?: boolean };

/** The three requests; `lib/api.ts` in the app, an in-memory authority in tests. Failures throw `{ status, code, data }`. */
export type CollabTransport = {
  join(options?: { stored?: boolean; start?: boolean }): Promise<CollabJoin>;
  since(epoch: string, version: number): Promise<CollabBatch>;
  send(body: CollabSend): Promise<CollabBatch>;
};

/**
 * saved: everything typed here is written back on the server. saving: some is not yet.
 * offline: the server cannot be reached; typing is kept and sent later. lost: you can no longer edit.
 */
export type CollabStatus = "saved" | "saving" | "offline" | "error" | "lost";

/**
 * Typing the server has not written back yet, kept in this tab: the stored copy as last known
 * (`savedDoc` at version `saved`), the server's steps after it up to `version` (with who sent
 * each), and this editor's steps on top that the server had not confirmed. `clientID` is the
 * editor's id now, which starts with its account's id; `ids`, every id it had (it gets a new one
 * when it joins again).
 */
export type Draft = {
  clientID: ClientID;
  ids?: ClientID[];
  epoch: string;
  saved: number;
  savedDoc: PageDocument;
  server: { steps: unknown[]; clientIDs: ClientID[] };
  version: number;
  steps: unknown[];
  at: number;
};
/**
 * Drafts of one page in this tab, one per editor. `key` names the page. `write` is false when
 * the browser refused (its storage is full).
 */
export type DraftStore = { key: string; read(): Draft[]; write(draft: Draft): boolean; clear(clientID: ClientID): void };

/** The account an editor's client id belongs to. */
export const accountOf = (clientID: ClientID) => clientID.slice(0, Math.max(0, clientID.lastIndexOf("/")));

/** The bits of the Web Locks API used here. */
type Locks = {
  request(name: string, callback: () => Promise<void>): Promise<unknown>;
  query(): Promise<{ held?: Array<{ name?: string }>; pending?: Array<{ name?: string }> }>;
};

/**
 * Which editors are still live, so a draft is taken over only from one that is gone: in this
 * tab (a page closed and opened again at once is still sending), and through Web Locks in any
 * other (a duplicated tab starts with a copy of this one's drafts). Sessions closing a page are
 * waited for (`settled`) before another one of the same page reads the drafts. A draft put back
 * is recorded in `localStorage`, which all tabs share, so a copy of it in a duplicated tab is
 * never put back a second time (`claim`).
 */
export type CollabTab = {
  /** Marks an editor live until the returned function is called. */
  hold(clientID: ClientID): () => void;
  /** Of `ids`, those no live editor has, no other session here took over and no tab put back; they are now yours. */
  take(ids: ClientID[]): Promise<ClientID[]>;
  /** A tab already put back this editor's draft: a copy left here is stale. */
  applied(clientID: ClientID): boolean;
  /** Records that this editor's draft is being put back now; false when a tab already did. */
  claim(clientID: ClientID): boolean;
  /** Drafts taken but not put back (the page closed first): another session may take them. */
  give(ids: ClientID[]): void;
  /** A session of page `key` is still sending what was typed before it closed. */
  finishing(key: string, work: Promise<unknown>): void;
  /** Waits (at most `ms`) for the sessions of page `key` still finishing. */
  settled(key: string, ms: number): Promise<void>;
};

const LOCK = "ensemble.collab:";
const APPLIED = "ensemble.draft-applied:";
/** How long a put-back draft is remembered across tabs. */
const APPLIED_MS = 30 * 24 * 60 * 60 * 1000;

/** Storage all tabs share (`localStorage`), when the browser allows it. */
type Shared = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

function sharedStorage(): Shared | null {
  try {
    return (globalThis as { localStorage?: Shared }).localStorage ?? null;
  } catch {
    return null;
  }
}

export function collabTab(locks: Locks | null = (globalThis.navigator as { locks?: Locks } | undefined)?.locks ?? null, shared: Shared | null = sharedStorage()): CollabTab {
  const live = new Set<ClientID>();
  const taken = new Set<ClientID>();
  const closing = new Map<string, Set<Promise<unknown>>>();
  let pruned = false;
  const applied = (clientID: ClientID) => {
    try {
      return Boolean(shared?.getItem(`${APPLIED}${clientID}`));
    } catch {
      return false;
    }
  };
  /** Forgets put-back drafts older than a month, once per tab. */
  const prune = () => {
    if (pruned || !shared) return;
    pruned = true;
    try {
      const old: string[] = [];
      for (let at = 0; at < shared.length; at += 1) {
        const key = shared.key(at);
        if (key?.startsWith(APPLIED) && Date.now() - Number(shared.getItem(key)) > APPLIED_MS) old.push(key);
      }
      for (const key of old) shared.removeItem(key);
    } catch {
      // Nothing to prune.
    }
  };
  return {
    hold(clientID) {
      live.add(clientID);
      let release: (() => void) | null = null;
      let done = false;
      if (locks) {
        void locks
          .request(`${LOCK}${clientID}`, () =>
            new Promise<void>((resolve) => {
              release = resolve;
              if (done) resolve();
            }),
          )
          .catch(() => undefined);
      }
      return () => {
        done = true;
        live.delete(clientID);
        release?.();
      };
    },
    async take(ids) {
      const busy = new Set(ids.filter((id) => live.has(id) || taken.has(id)));
      if (locks && busy.size < ids.length) {
        try {
          const { held = [], pending = [] } = await locks.query();
          for (const lock of [...held, ...pending]) if (lock.name?.startsWith(LOCK)) busy.add(lock.name.slice(LOCK.length));
        } catch {
          // No answer: only this tab's editors count.
        }
      }
      const free = ids.filter((id) => !busy.has(id) && !live.has(id) && !taken.has(id) && !applied(id));
      for (const id of free) taken.add(id);
      return free;
    },
    applied,
    claim(clientID) {
      if (!shared) return true;
      prune();
      try {
        if (applied(clientID)) return false;
        shared.setItem(`${APPLIED}${clientID}`, String(Date.now()));
      } catch {
        // Storage full or blocked: this tab's own records still hold.
      }
      return true;
    },
    give(ids) {
      for (const id of ids) taken.delete(id);
    },
    finishing(key, work) {
      const set = closing.get(key) ?? new Set();
      closing.set(key, set);
      set.add(work);
      void work.finally(() => {
        set.delete(work);
        if (!set.size && closing.get(key) === set) closing.delete(key);
      });
    },
    async settled(key, ms) {
      const pending = [...(closing.get(key) ?? [])];
      if (!pending.length) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.allSettled(pending), new Promise((resolve) => (timer = setTimeout(resolve, ms)))]);
      clearTimeout(timer);
    },
  };
}

/** This tab's editors. */
const thisTab = collabTab();

/** What the block editor needs to run live: the version its document is at, and where to report. */
export type CollabBinding = { version: number; clientID: ClientID; attach(editor: Editor): () => void };

export type CollabSessionOptions = {
  transport: CollabTransport;
  /** Someone else is on the page: send sooner. */
  live?: () => boolean;
  drafts?: DraftStore | null;
  onStatus?: (status: CollabStatus) => void;
  /** The share was removed, edit rights taken away, or the page went to Trash. Your text stays on screen. */
  onLost?: (error: unknown) => void;
  /** The session expired. The draft is written before the app goes to sign in. */
  onSignedOut?: () => void;
  onError?: (message: string) => void;
  /** A draft from before a reload or sign-in was put back on the page. */
  onRestored?: () => void;
  /** Which editors are live (this tab's, by default). */
  tab?: CollabTab;
  /** Bytes of steps in one request (`MAX_SEND_BYTES`). */
  sendBytes?: number;
  delays?: Partial<typeof DELAYS>;
};

const DELAYS = {
  /** Wait before sending while someone else is on the page… */
  live: 60,
  /** …and while you are alone on it. */
  alone: 250,
  retry: 1000,
  maxRetry: 30_000,
  /** Typing confirmed but not reported written back this long: ask the server. */
  savedCheck: 5000,
  /** The draft is written this long after typing is sent (and at once on leaving, going offline or signing out). */
  draft: 3000,
};
/** Steps in one request; the server takes up to 1,000, and a prefix is confirmed like the whole. */
export const MAX_SEND = 200;
/**
 * Bytes of steps in one request (at least one step goes, however large): well under the 8 MiB
 * the collab route takes, which is more than one step can be (1,000,000 characters of JSON).
 */
export const MAX_SEND_BYTES = 1024 * 1024;

/** The length of `text` in UTF-8. */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && at + 1 < text.length) {
      bytes += 4;
      at += 1;
    } else bytes += 3;
  }
  return bytes;
}
/** Recent step maps kept to place other people's carets sent from older versions. */
const KEEP_MAPS = 500;
/** Server steps kept after the last known write-back, for drafts and for starting over. */
const KEEP_WINDOW = 3000;
/** How long a page opening waits for the same page's session that just closed to send its typing. */
const SETTLE_MS = 10_000;
const REFUSED = "This page can't save that change. Reload the page; your text is kept in this tab.";
const TAKEN_BACK = "That change was taken out of the page; the rest of your typing is saved as usual.";
const TOO_LARGE = "This change is too large to save in one piece. Paste it in parts.";
const DRAFT_FULL = "This tab's storage is full, so unsaved typing is not kept for a reload. Keep the page open until it says saved.";

const UNSTORABLE = /[\u0000\uD800-\uDFFF]/;

/** Text as pages can store it: no U+0000, and half an emoji (a lone surrogate) becomes U+FFFD. */
export function storableText(text: string): string {
  if (!UNSTORABLE.test(text)) return text;
  let out = "";
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    if (code === 0) continue;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(at + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text.slice(at, at + 2);
        at += 1;
      } else out += "\uFFFD";
    } else if (code >= 0xdc00 && code <= 0xdfff) out += "\uFFFD";
    else out += text[at];
  }
  return out;
}

function storableFragment(fragment: Fragment): Fragment {
  let changed = false;
  const nodes: ProseNode[] = [];
  fragment.forEach((node) => {
    if (node.isText) {
      const text = storableText(node.text ?? "");
      if (text === node.text) nodes.push(node);
      else {
        changed = true;
        if (text) nodes.push(node.type.schema.text(text, node.marks));
      }
      return;
    }
    const content = node.content.size ? storableFragment(node.content) : node.content;
    if (content === node.content) nodes.push(node);
    else {
      changed = true;
      nodes.push(node.copy(content));
    }
  });
  return changed ? Fragment.fromArray(nodes) : fragment;
}

type Failure = "behind" | "reset" | "lost" | "signedOut" | "offline" | "busy" | "refused" | "failed";

function failure(error: unknown): { kind: Failure; data: unknown; message: string; code: string | null; status: number } {
  const { status = 0, code = null, data, message } = (error ?? {}) as { status?: number; code?: string | null; data?: unknown; message?: string };
  const text = message ?? "Could not save.";
  const out = (kind: Failure, why = text) => ({ kind, data, message: why, code, status });
  if (status === 409 && code === "COLLAB_BEHIND") return out("behind");
  if (status === 410) return out("reset");
  if (status === 401) return out("signedOut");
  if (code === "COLLAB_REJECTED" || code === "COLLAB_TOO_LARGE" || code === "COLLAB_UNSAVED") return out("refused");
  // The request itself was over the API's size limit (Fastify's 413): too large, never retried as it is.
  if (status === 413) return out("refused", TOO_LARGE);
  if (code === "SHARE_GONE" || status === 403 || status === 404) return out("lost");
  if (!status || status >= 500) return out("offline");
  if (status === 429) return out("busy");
  return out("failed");
}

/**
 * `start` with `steps` (which followed it) applied, except those `drop` marks: every step is taken
 * back, then the kept ones are applied again, each mapped past the ones left out. Text a kept step
 * typed inside text a dropped step had added stays, where that text was. Returns the document
 * and the kept steps as moved, which apply in turn from `start`.
 */
function without(start: ProseNode, steps: Step[], drop: boolean[]): { doc: ProseNode; steps: Step[] } {
  const docs = [start];
  for (const step of steps) docs.push(step.apply(docs.at(-1)!).doc ?? docs.at(-1)!);
  const count = steps.length;
  const mapping = new Mapping();
  for (let at = count - 1; at >= 0; at -= 1) mapping.appendMap(steps[at]!.invert(docs[at]!).getMap());
  let doc = start;
  const kept: Step[] = [];
  for (let at = 0; at < count; at += 1) {
    if (drop[at]) continue;
    const step = steps[at]!;
    // From this step's document back to `start`, then forward through the kept steps so far.
    const back = mapping.slice(count - at);
    let mapped = step.map(back);
    if (!mapped && step instanceof ReplaceStep && step.from === step.to) {
      const pos = back.map(step.from, 1);
      mapped = new ReplaceStep(pos, pos, step.slice);
    }
    const result = mapped?.apply(doc);
    if (!mapped || !result?.doc) continue;
    doc = result.doc;
    kept.push(mapped);
    mapping.appendMap(mapped.getMap(), count - 1 - at);
  }
  return { doc, steps: kept };
}

/**
 * `mine` and `fresh` both changed `base`: the steps that turn `fresh` into their three-way merge
 * (`mergeDocs`). `union` is for typing proposed again after the server started over, which
 * `fresh` may already hold: identical typing is then added once.
 */
function mergeOnto(schema: Schema, base: ProseNode, mine: ProseNode, fresh: ProseNode, union = false): Step[] {
  const json = (node: ProseNode) => node.toJSON() as PageDocument;
  if (mine.eq(base) || sameDoc(json(mine), json(fresh))) return [];
  const parse = (doc: PageDocument, check: boolean) => {
    try {
      const node = schema.nodeFromJSON(doc);
      if (check) node.check();
      return node;
    } catch {
      return null;
    }
  };
  const deep = mergeDocs(json(base), json(mine), json(fresh), { union }).doc;
  const merged = parse(deep, true) ?? parse(mergeDocs(json(base), json(mine), json(fresh), { deep: false, union }).doc, true) ?? parse(deep, false) ?? mine;
  return diffSteps(fresh, merged);
}

/**
 * On the same server: `steps` (typed on `base`) moved over what changed from `base` to `fresh`
 * (`over`, its steps when known), exactly as prosemirror-collab would; when one no longer fits,
 * the plain three-way merge.
 */
function carryOver(schema: Schema, base: ProseNode, steps: Step[], fresh: ProseNode, over: Step[] = diffSteps(base, fresh)): Step[] {
  if (!steps.length) return [];
  const moved = rebaseSteps(base, steps, over);
  if (moved) return moved;
  let mine = base;
  for (const step of steps) mine = step.apply(mine).doc ?? mine;
  return mergeOnto(schema, base, mine, fresh);
}

/** How far back to look for the version a restarted server's document is at. */
const LOOK_BACK = 500;

/**
 * After the server started over: your typing that `fresh` lacks, as steps onto it. `savedDoc` is
 * the stored copy as last known, `window` the server's steps after it with who sent each, and
 * `unconfirmed` yours on top. When `fresh` is the server's document at one of those versions (its
 * last write-back), exactly your steps after that version go again, other people's being theirs
 * to send. Otherwise (written from elsewhere since) a three-way merge from the stored copy.
 */
function reproposal(schema: Schema, savedDoc: ProseNode, window: Array<{ step: Step; id: ClientID }>, unconfirmed: Step[], own: Set<ClientID>, fresh: ProseNode): Step[] {
  const docs = [savedDoc];
  for (const entry of window) docs.push(entry.step.apply(docs.at(-1)!).doc ?? docs.at(-1)!);
  const steps = [...window.map((entry) => entry.step), ...unconfirmed];
  const others = [...window.map((entry) => !own.has(entry.id)), ...unconfirmed.map(() => false)];
  for (let at = docs.length - 1; at >= Math.max(0, docs.length - LOOK_BACK); at -= 1) {
    if (docs[at]!.eq(fresh)) return diffSteps(fresh, without(fresh, steps.slice(at), others.slice(at)).doc);
  }
  let mine = docs.at(-1)!;
  for (const step of unconfirmed) mine = step.apply(mine).doc ?? mine;
  const base = without(savedDoc, window.map((entry) => entry.step), window.map((entry) => own.has(entry.id))).doc;
  return mergeOnto(schema, base, mine, fresh, true);
}

/** What an editor knew of the server before it started over: enough to tell what of its typing to send again. */
type Known = {
  epoch: string;
  /** The stored copy as last known, at `savedVersion`, the server's steps after it, and the editor's unconfirmed ones. */
  savedDoc: ProseNode;
  savedVersion: number;
  window: Array<{ step: Step; id: ClientID }>;
  unconfirmed: Step[];
  /** The editor's client ids, the one it has now and any before. */
  own: Set<ClientID>;
  /** The server's document at the last version the editor had, and the editor's own. */
  serverDoc: ProseNode;
  mine: ProseNode;
};

/**
 * Your typing that the stored copy `stored` lacks, as steps onto it. When the stored copy says
 * it was written by the authority you were on (`previous`), exactly your steps after that version
 * go again; when it was written after the last version you had, only your unconfirmed typing.
 */
function fromStored(schema: Schema, known: Known, stored: ProseNode, previous: Start["previous"]): Step[] {
  const reached = known.savedVersion + known.window.length;
  if (previous && previous.epoch === known.epoch) {
    if (previous.version >= known.savedVersion && previous.version <= reached) {
      const tail = known.window.slice(previous.version - known.savedVersion);
      const steps = [...tail.map((entry) => entry.step), ...known.unconfirmed];
      const others = [...tail.map((entry) => !known.own.has(entry.id)), ...known.unconfirmed.map(() => false)];
      return diffSteps(stored, without(stored, steps, others).doc);
    }
    if (previous.version > reached) return mergeOnto(schema, known.serverDoc, known.mine, stored, true);
  }
  return reproposal(schema, known.savedDoc, known.window, known.unconfirmed, known.own, stored);
}

/**
 * Your typing that a restarted server lacks, as steps onto its document now (`fresh`): compared
 * with the stored copy it loaded (`start`), then moved over what others proposed since.
 */
function startingOver(schema: Schema, known: Known, fresh: ProseNode, start: Start | undefined): Step[] {
  if (start) {
    const loaded = schema.nodeFromJSON(start.doc);
    const moved = rebaseSteps(loaded, fromStored(schema, known, loaded, start.previous), start.steps.map((json) => Step.fromJSON(schema, json)));
    if (moved) return moved;
  }
  return fromStored(schema, known, fresh, null);
}

/**
 * An editor's unconfirmed steps (on `atVersion`, the server's document at `version`) replayed
 * against what the server did since (`batch`), the way that editor would have: steps the server
 * took from it (under any of its ids, `own`) are dropped, the rest rebased. Null when they no
 * longer fit `live`, the server's document now.
 */
function replay(schema: Schema, atVersion: ProseNode, version: number, unconfirmed: Step[], own: Set<ClientID>, batch: Pick<CollabBatch, "steps" | "clientIDs">, live: ProseNode): Step[] | null {
  const me = "replayed";
  let state = EditorState.create({ schema, doc: atVersion, plugins: [collab({ version, clientID: me })] });
  if (unconfirmed.length) {
    const tr = state.tr;
    for (const step of unconfirmed) tr.step(step);
    state = state.apply(tr);
  }
  for (let at = 0; at < batch.steps.length; ) {
    const mine = own.has(batch.clientIDs[at]!);
    let end = at;
    while (end < batch.steps.length && own.has(batch.clientIDs[end]!) === mine) end += 1;
    const steps = batch.steps.slice(at, end).map((json) => Step.fromJSON(schema, json));
    // That editor's steps the draft did not hold (typed after it was written) apply like anyone's.
    const held = mine ? Math.min(steps.length, sendableSteps(state)?.steps.length ?? 0) : 0;
    if (held) state = state.apply(receiveTransaction(state, steps.slice(0, held), steps.slice(0, held).map(() => me)));
    if (held < steps.length) state = state.apply(receiveTransaction(state, steps.slice(held), steps.slice(held).map(() => "server")));
    at = end;
  }
  const remaining = [...(sendableSteps(state)?.steps ?? [])];
  let doc = live;
  for (const step of remaining) {
    const result = step.apply(doc);
    if (!result.doc) return null;
    doc = result.doc;
  }
  return remaining;
}

/**
 * The prosemirror-collab plugin, set up with the version the editor's document is at. Pasted and
 * dropped text loses what pages cannot store (U+0000, half an emoji), which the server refuses.
 */
export const CollabSync = Extension.create<{ version: number; clientID: ClientID }, { session: CollabSession | null }>({
  name: "collabSync",
  addOptions() {
    return { version: 0, clientID: "" };
  },
  addStorage() {
    return { session: null };
  },
  addProseMirrorPlugins() {
    return [
      collab({ version: this.options.version, clientID: this.options.clientID }),
      new Plugin({ props: { transformPasted: (slice) => new Slice(storableFragment(slice.content), slice.openStart, slice.openEnd) } }),
    ];
  },
});

/** The session behind an editor, when it is live. */
export function sessionOf(editor: Editor): CollabSession | null {
  return (editor.storage as { collabSync?: { session: CollabSession | null } }).collabSync?.session ?? null;
}

export class CollabSession {
  /** This editor's id on the server's steps, issued when it joins (a new one if it joins again). */
  clientID: ClientID = "";
  status: CollabStatus = "saved";
  /** The stored revision after the last flush or join. */
  revision = 0;
  /** Goes with the steps sent under `clientID`. */
  private token = "";
  /** Every client id this editor had, the current one last. */
  private readonly ids: ClientID[] = [];
  /** Ends this editor's hold on its id (it is live until then). */
  private release: (() => void) | null = null;
  private readonly tab: CollabTab;
  private epoch = "";
  private editor: Editor | null = null;
  /** The editor's last state after it closed, while what was typed is still being sent. */
  private detached: EditorState | null = null;
  /** The server's document at the editor's version. */
  private serverDoc: ProseNode | null = null;
  /** The stored copy as last known, at `savedDocVersion`, and the server's steps since (`window`). */
  private savedDoc: ProseNode | null = null;
  /** `savedDoc` as JSON for drafts, made once per stored copy. */
  private savedJSON: PageDocument | null = null;
  private savedDocVersion = 0;
  private window: Array<{ step: Step; id: ClientID }> = [];
  /** The last version the server reports written back, and the last that holds a step of yours. */
  private saved = 0;
  private mine = 0;
  private joinedDoc: PageDocument | null = null;
  private maps: StepMap[] = [];
  private mapsFrom = 0;
  private waiting: CollabBatch[] = [];
  /** Drafts of editors that are gone, to put back once the editor is attached. */
  private restore: { drafts: Array<{ draft: Draft; batch: CollabBatch | null }>; start: Start | undefined } | null = null;
  /** The stored copy and steps since, from the first join, to start tracking what is saved. */
  private joinedStored: Stored | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private savedTimer: ReturnType<typeof setTimeout> | undefined;
  private draftTimer: ReturnType<typeof setTimeout> | undefined;
  private pumping: Promise<void> | null = null;
  /** The steps request on the way, if any. */
  private sending: Promise<unknown> | null = null;
  /** Epochs this session has moved on from; their late answers are ignored. */
  private readonly retired = new Set<string>();
  private resetting: Promise<boolean> | null = null;
  private catching: Promise<void> | null = null;
  private failures = 0;
  /** A draft of this editor's is in the store. */
  private drafted = false;
  /** The store refused the last draft (full): said once until a write works again. */
  private draftRefused = false;
  /** Lost access, frozen or signed out: nothing more is sent. */
  private stopped = false;
  /** The page closed; what was typed is still sent and written back (`finishing`). */
  private closed = false;
  private finishing = false;
  private last: PageDocument | null = null;
  private readonly delays: typeof DELAYS;
  /** Bytes of steps per request; one step a request after the API found a request too large. */
  private sendBytes: number;

  constructor(private readonly options: CollabSessionOptions) {
    this.delays = { ...DELAYS, ...options.delays };
    this.tab = options.tab ?? thisTab;
    this.sendBytes = options.sendBytes ?? MAX_SEND_BYTES;
  }

  private get state(): EditorState | null {
    const editor = this.editor;
    if (editor && !editor.isDestroyed) return editor.state;
    return this.detached;
  }

  private dispatch(tr: Transaction): void {
    const editor = this.editor;
    if (editor && !editor.isDestroyed) editor.view.dispatch(tr);
    else if (this.detached) this.detached = this.detached.apply(tr);
  }

  private setStatus(status: CollabStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatus?.(status);
  }

  /** Something typed here is not yet written back on the server. */
  private get unsaved(): boolean {
    const state = this.state;
    return Boolean(state && sendableSteps(state)) || this.mine > this.saved;
  }

  /** "Saving…" until the server reports your typing written back; the draft goes then. */
  private refresh(): void {
    const unsaved = this.unsaved;
    clearTimeout(this.savedTimer);
    if (!unsaved) this.clearDrafts();
    else if (this.state && !sendableSteps(this.state) && !this.closed) {
      // Confirmed but not reported written back: the stream may have missed it.
      this.savedTimer = setTimeout(() => void this.catchUp(), this.delays.savedCheck);
    }
    if (this.failures || this.stopped) return;
    this.setStatus(unsaved ? "saving" : "saved");
  }

  /** Takes the client id (and its token) a join issued; the editor is live under it. */
  private adopt(joined: { clientID: ClientID; token?: string }): void {
    this.token = joined.token ?? "";
    if (joined.clientID === this.clientID) return;
    this.clientID = joined.clientID;
    this.ids.push(joined.clientID);
    if (this.ids.length > 20) this.ids.splice(0, this.ids.length - 20);
    this.release?.();
    this.release = this.closed && !this.finishing ? null : this.tab.hold(joined.clientID);
  }

  /** No longer live: a later session may take over the draft, if one is left. */
  private done(): void {
    clearTimeout(this.draftTimer);
    this.draftTimer = undefined;
    this.release?.();
    this.release = null;
  }

  /**
   * Reads the server's document to start from, and the drafts left on this page in this tab by
   * editors that are gone (after waiting for one that is still sending what it had).
   */
  async join(): Promise<CollabJoin> {
    const drafts = this.options.drafts ?? null;
    if (drafts) await this.tab.settled(drafts.key, SETTLE_MS);
    const read = () => {
      try {
        return drafts?.read() ?? [];
      } catch {
        return [];
      }
    };
    const found = read();
    const joined = await this.options.transport.join({ stored: true, start: found.length > 0 });
    this.adopt(joined);
    this.joinedStored = joined.stored;
    this.epoch = joined.epoch;
    this.revision = joined.revision;
    this.joinedDoc = joined.doc;
    this.mapsFrom = joined.version;
    this.saved = joined.saved;
    this.restore = null;
    // This account's drafts only, from editors no longer live anywhere, and still there now.
    const account = accountOf(this.clientID);
    const candidates = found.filter((draft) => draft && typeof draft.clientID === "string" && !this.ids.includes(draft.clientID) && accountOf(draft.clientID) === account);
    if (!candidates.length || this.closed) return joined;
    const free = new Set(await this.tab.take(candidates.map((draft) => draft.clientID)));
    // Copies of drafts another tab already put back (this tab was duplicated from it) go.
    for (const draft of candidates) if (!free.has(draft.clientID) && this.tab.applied(draft.clientID)) drafts?.clear(draft.clientID);
    const left = new Set(read().map((draft) => draft.clientID));
    const adopted = candidates.filter((draft) => free.has(draft.clientID) && left.has(draft.clientID)).sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    if (!adopted.length) return joined;
    this.restore = { drafts: adopted.map((draft) => ({ draft, batch: null })), start: joined.start };
    for (const entry of this.restore.drafts) {
      const { draft } = entry;
      if (draft.epoch !== joined.epoch || draft.version > joined.version) continue;
      // What the server did since the draft's version, to tell which of its steps it already has.
      try {
        const batch = await this.options.transport.since(draft.epoch, draft.version);
        const count = joined.version - draft.version;
        entry.batch = { ...batch, version: joined.version, steps: batch.steps.slice(0, count), clientIDs: batch.clientIDs.slice(0, count) };
      } catch {
        // Older than the server's log: merged instead.
      }
    }
    return joined;
  }

  /** The editor was created from the joined document with `CollabSync` at its version. */
  attach(editor: Editor): () => void {
    this.editor = editor;
    this.detached = null;
    (editor.storage as { collabSync?: { session: CollabSession | null } }).collabSync!.session = this;
    if (!this.serverDoc) {
      this.serverDoc = editor.state.doc;
      this.track(editor.schema, editor.state.doc, getVersion(editor.state), this.joinedStored);
    }
    const onTransaction = () => this.changed();
    editor.on("transaction", onTransaction);
    const waiting = this.waiting.splice(0);
    for (const batch of waiting) this.receive(batch);
    this.restoreDrafts();
    this.refresh();
    return () => {
      editor.off("transaction", onTransaction);
      try {
        this.detached = editor.state;
        this.last = editor.getJSON() as PageDocument;
      } catch {
        // Already gone.
      }
      if (this.editor === editor) this.editor = null;
    };
  }

  /** One draft's typing as steps onto `joined` (the server's document when the editor opened): what the server already has is left out. */
  private draftSteps(schema: Schema, draft: Draft, batch: CollabBatch | null, joined: ProseNode, start: Start | undefined): Step[] {
    const savedDoc = schema.nodeFromJSON(draft.savedDoc);
    const window = draft.server.steps.map((json) => Step.fromJSON(schema, json));
    let atVersion = savedDoc;
    for (const step of window) atVersion = step.apply(atVersion).doc ?? atVersion;
    const unconfirmed = draft.steps.map((json) => Step.fromJSON(schema, json));
    const own = new Set([...(draft.ids ?? []), draft.clientID]);
    const replayed = batch ? replay(schema, atVersion, draft.version, unconfirmed, own, batch, joined) : null;
    if (replayed) return replayed;
    // The same server, its log gone: the unconfirmed typing moved over what changed since.
    if (draft.epoch === this.epoch) return carryOver(schema, atVersion, unconfirmed, joined);
    // The server started over: your typing it lacks goes again.
    let mine = atVersion;
    for (const step of unconfirmed) mine = step.apply(mine).doc ?? mine;
    const known: Known = {
      epoch: draft.epoch,
      savedDoc,
      savedVersion: draft.saved,
      window: window.map((step, at) => ({ step, id: draft.server.clientIDs[at]! })),
      unconfirmed,
      own,
      serverDoc: atVersion,
      mine,
    };
    return startingOver(schema, known, joined, start);
  }

  /** Puts typing from the drafts taken over back, one after another; this editor's own draft then holds it. */
  private restoreDrafts(): void {
    const restore = this.restore;
    const editor = this.editor;
    this.restore = null;
    if (!restore || !editor) return;
    const schema = editor.schema;
    const joined = editor.state.doc;
    const applied: Step[] = [];
    for (const { draft, batch } of restore.drafts) {
      // Another tab put it back meanwhile (a duplicate of this one): not twice.
      if (!this.tab.claim(draft.clientID)) continue;
      try {
        const steps = this.draftSteps(schema, draft, batch, joined, restore.start);
        if (!steps.length) continue;
        // After an earlier draft's typing: moved past it, else merged onto the page as it is now.
        const moved = applied.length ? carryOver(schema, joined, steps, editor.state.doc, applied) : steps;
        const tr = editor.state.tr;
        for (const step of moved) tr.step(step);
        editor.view.dispatch(tr.setMeta("addToHistory", false));
        applied.push(...moved);
      } catch {
        // A draft that no longer fits the page is left out.
      }
    }
    for (const { draft } of restore.drafts) this.options.drafts?.clear(draft.clientID);
    if (!applied.length) return;
    this.keepDraft();
    this.options.onRestored?.();
  }

  /** What the editor holds now, saved or not. */
  latest(): PageDocument | null {
    const editor = this.editor;
    if (editor && !editor.isDestroyed) return editor.getJSON() as PageDocument;
    return this.last ?? this.joinedDoc;
  }

  private changed(): void {
    const editor = this.editor;
    if (!editor || this.stopped || this.closed || this.pumping || this.timer || this.resetting) return;
    if (!sendableSteps(editor.state)) return;
    if (!this.failures) this.setStatus("saving");
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.pump();
    }, this.options.live?.() ? this.delays.live : this.delays.alone);
  }

  private pump(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pumping ??= this.run().finally(() => {
      this.pumping = null;
    });
    return this.pumping;
  }

  private async run(): Promise<void> {
    for (let round = 0; round < 100; round += 1) {
      const state = this.state;
      if (this.stopped || !state || this.resetting || (this.closed && !this.finishing)) return;
      const sendable = sendableSteps(state);
      if (!sendable) {
        this.refresh();
        return;
      }
      // While retrying, the page keeps saying it is offline until a request goes through.
      if (!this.failures) this.setStatus("saving");
      this.scheduleDraft();
      const epoch = this.epoch;
      // At most MAX_SEND steps and sendBytes of them, but always one.
      const steps: unknown[] = [];
      let bytes = 0;
      for (const step of sendable.steps) {
        if (steps.length >= MAX_SEND) break;
        const json = step.toJSON();
        const size = utf8Length(JSON.stringify(json));
        if (steps.length && bytes + size > this.sendBytes) break;
        steps.push(json);
        bytes += size;
      }
      try {
        this.sending = this.options.transport.send({ epoch, version: sendable.version, clientID: this.clientID, token: this.token, steps });
        const batch = (await this.sending.finally(() => (this.sending = null))) as CollabBatch;
        this.failures = 0;
        this.take(batch);
        // Typing went on while this was sent: gather a little more before the next request.
        const next = this.state;
        if (next && sendableSteps(next) && !this.closed) await new Promise((resolve) => setTimeout(resolve, this.options.live?.() ? this.delays.live : this.delays.alone));
      } catch (error) {
        if (!(await this.failed(error, epoch, { version: sendable.version, count: steps.length }))) return;
      }
    }
    // Still refused after many rounds: try again in a moment rather than spin.
    this.retryLater(this.delays.retry);
  }

  private retryLater(wait: number): void {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.pump();
    }, wait);
  }

  /**
   * Handles a refused or failed request, made under `epoch` (with `sent`: steps sent from that
   * version, so many). True: try again now.
   */
  private async failed(error: unknown, epoch = this.epoch, sent?: { version: number; count: number }): Promise<boolean> {
    const { kind, data, message, code, status } = failure(error);
    switch (kind) {
      case "behind":
        this.take(data as CollabBatch);
        return true;
      case "reset":
        // A late answer to a request from before the editor started over: send again as it is now.
        if (epoch !== this.epoch) return !this.stopped;
        // Again only once on the fresh document; a page closed meanwhile stops and keeps its draft.
        return (await this.reset()) && !this.stopped;
      case "lost":
        // Kept: a page restored from Trash puts it back.
        this.keepDraft();
        this.stopped = true;
        clearTimeout(this.timer);
        this.setStatus("lost");
        this.options.onLost?.(error);
        return false;
      case "signedOut":
        this.keepDraft();
        this.stopped = true;
        this.setStatus("error");
        this.options.onSignedOut?.();
        return false;
      default: {
        // One step refused (a character pages cannot store, a page grown past its limit), or a
        // request of one step too large for the API: that step is taken out and the rest goes on.
        // Steps from others since the request may have moved the queue: send again for a fresh answer.
        const index = (data as { step?: unknown } | null | undefined)?.step;
        const state = this.state;
        if (kind === "refused" && sent && state && (typeof index === "number" || status === 413)) {
          if (getVersion(state) !== sent.version) return true;
          const at = typeof index === "number" ? index : sent.count === 1 ? 0 : null;
          if (at === null) {
            // Several steps too large together: one a request from now on.
            this.sendBytes = 1;
            return true;
          }
          if (at < sent.count && this.takeBack(at)) {
            this.options.onError?.(`${message} ${TAKEN_BACK}`);
            return true;
          }
        }
        this.failures += 1;
        this.setStatus(kind === "offline" ? "offline" : kind === "busy" ? "saving" : "error");
        // Refused changes are not sent again right away: the same change would be refused again.
        if ((kind === "failed" || kind === "refused") && this.failures === 1) this.options.onError?.(kind === "refused" && (code === "COLLAB_REJECTED" || status === 413) ? REFUSED : message);
        this.keepDraft();
        this.retryLater(Math.min(this.delays.maxRetry, this.delays.retry * 2 ** (this.failures - 1)));
        return false;
      }
    }
  }

  /**
   * The server refused step `index` of the request: it is taken out of the page and the queue,
   * the steps after it moved past it (`without`), so the rest can be sent. False when there is
   * no such step.
   */
  private takeBack(index: number): boolean {
    const state = this.state;
    const sendable = state ? sendableSteps(state) : null;
    const serverDoc = this.serverDoc;
    if (!state || !sendable || !serverDoc || !Number.isInteger(index) || index < 0 || index >= Math.min(MAX_SEND, sendable.steps.length)) return false;
    const steps = [...sendable.steps];
    const kept = without(serverDoc, steps, steps.map((_, at) => at === index)).steps;
    const version = getVersion(state);
    const editor = this.editor;
    if (editor && !editor.isDestroyed) {
      // Back to the server's document without sending that, then the kept steps as new typing.
      editor.unregisterPlugin("collab");
      const swap = editor.state.tr;
      for (const step of diffSteps(editor.state.doc, serverDoc)) swap.step(step);
      if (swap.docChanged) editor.view.dispatch(swap.setMeta("addToHistory", false).setMeta("preventUpdate", true));
      editor.registerPlugin(collab({ version, clientID: this.clientID }));
      const tr = editor.state.tr;
      for (const step of kept) tr.step(step);
      if (tr.docChanged) editor.view.dispatch(tr.setMeta("addToHistory", false));
    } else {
      let next = EditorState.create({ schema: state.schema, doc: serverDoc, plugins: [collab({ version, clientID: this.clientID })] });
      if (kept.length) {
        const tr = next.tr;
        for (const step of kept) tr.step(step);
        next = next.apply(tr);
      }
      this.detached = next;
    }
    this.keepDraft();
    return true;
  }

  /** Steps from the server, as an answer or from the event stream. */
  receive(batch: CollabBatch): void {
    if (!this.state) {
      if (this.waiting.length < 200) this.waiting.push(batch);
      return;
    }
    this.take(batch);
  }

  /** The server wrote the page back up to `saved` (its `page` event after a write-back). */
  noteSaved(epoch: string, saved: number): void {
    if (epoch !== this.epoch || !(saved > this.saved)) return;
    this.saved = saved;
    this.advanceSaved();
    this.refresh();
  }

  /**
   * Starts tracking what is written back from a join: the stored copy and the steps since when
   * the server sent them, else the joined document (`doc` at `version`) itself.
   */
  private track(schema: Schema, doc: ProseNode, version: number, stored: Stored | undefined): void {
    this.savedDoc = doc;
    this.savedJSON = null;
    this.savedDocVersion = version;
    this.window = [];
    if (!stored) return;
    try {
      const steps = stored.steps.map((json) => Step.fromJSON(schema, json));
      this.savedDoc = schema.nodeFromJSON(stored.doc);
      this.savedDocVersion = stored.version;
      this.window = steps.map((step, at) => ({ step, id: stored.clientIDs[at]! }));
    } catch {
      this.savedDoc = doc;
      this.savedDocVersion = version;
      this.window = [];
    }
    this.advanceSaved();
  }

  private advanceSaved(): void {
    while (this.window.length && this.savedDoc && this.savedDocVersion < this.saved) {
      const { step } = this.window.shift()!;
      this.savedDoc = step.apply(this.savedDoc).doc ?? this.savedDoc;
      this.savedJSON = null;
      this.savedDocVersion += 1;
    }
  }

  private take(batch: CollabBatch): void {
    const outcome = this.apply(batch);
    if (outcome === "gap") void this.catchUp();
    else if (outcome === "reset") void this.reset();
  }

  private apply(batch: CollabBatch): "ok" | "gap" | "reset" {
    const state = this.state;
    if (!state) return "ok";
    // Another epoch: a late frame from one already left, or the server started over. Asking for
    // the steps since this version answers 410 in the second case only.
    if (batch.epoch !== this.epoch) return this.resetting || this.retired.has(batch.epoch) ? "ok" : "gap";
    const have = getVersion(state);
    if (batch.from > have) return "gap";
    const skip = have - batch.from;
    if (skip < batch.steps.length) {
      try {
        const steps = batch.steps.slice(skip).map((json) => Step.fromJSON(state.schema, json));
        const ids = batch.clientIDs.slice(skip);
        let server = this.serverDoc!;
        for (const step of steps) {
          const result = step.apply(server);
          if (!result.doc) return "reset";
          server = result.doc;
        }
        const tr = receiveTransaction(state, steps, ids, { mapSelectionBackward: true });
        this.dispatch(tr.setMeta("preventUpdate", true));
        this.serverDoc = server;
        steps.forEach((step, at) => {
          this.window.push({ step, id: ids[at]! });
          if (ids[at] === this.clientID) this.mine = Math.max(this.mine, have + at + 1);
          this.maps.push(step.getMap());
        });
        const over = this.maps.length - KEEP_MAPS;
        if (over > 0) {
          this.maps.splice(0, over);
          this.mapsFrom += over;
        }
        // Far behind on write-backs: the oldest steps count as stored rather than grow without end.
        if (this.window.length > KEEP_WINDOW) this.saved = Math.max(this.saved, this.savedDocVersion + this.window.length - KEEP_WINDOW);
      } catch {
        return "reset";
      }
    }
    if (typeof batch.saved === "number" && batch.saved > this.saved) this.saved = batch.saved;
    this.advanceSaved();
    this.refresh();
    return "ok";
  }

  /** Fetches steps the event stream did not bring (after a reconnect, or a gap), and the saved version. */
  catchUp(): Promise<void> {
    const state = this.state;
    if (this.catching || this.stopped || this.closed || this.resetting || !state) return this.catching ?? Promise.resolve();
    const epoch = this.epoch;
    this.catching = (async () => {
      try {
        this.take(await this.options.transport.since(epoch, getVersion(state)));
      } catch (error) {
        const { kind } = failure(error);
        if (kind === "reset" || kind === "lost") await this.failed(error, epoch);
      }
    })().finally(() => {
      this.catching = null;
    });
    return this.catching;
  }

  /**
   * The server's document started over, or it asks this editor to join again (its id is not
   * this account's any more, say after a session expired on a public link): take the fresh
   * document and id, and propose your unsaved typing again.
   */
  private reset(): Promise<boolean> {
    this.resetting ??= this.restart().finally(() => {
      this.resetting = null;
      // Steps that came meanwhile were for the old version, or are not here yet.
      void this.catchUp();
      this.kick();
    });
    return this.resetting;
  }

  /**
   * The page closed and the server started over (or asks it to join again): there is no editor
   * to take the fresh document, so nothing more is sent. The draft stays, and the page opening
   * again may take it at once.
   */
  private park(): false {
    this.keepDraft();
    this.stopped = true;
    clearTimeout(this.timer);
    this.done();
    return false;
  }

  /** True when the editor moved to the fresh document; false when it stopped (lost access, or the page closed). */
  private async restart(): Promise<boolean> {
    // Steps on the way may have landed before the server started over: take the answer first.
    if (this.sending) await this.sending.catch(() => undefined);
    let fresh: CollabJoin | null = null;
    for (let attempt = 0; !fresh; attempt += 1) {
      if (this.stopped) return false;
      if (this.closed && !this.editor) return this.park();
      try {
        fresh = await this.options.transport.join({ stored: true, start: true });
      } catch (error) {
        const { kind } = failure(error);
        if (kind === "lost" || kind === "signedOut") {
          await this.failed(error);
          return false;
        }
        this.setStatus("offline");
        await new Promise((resolve) => setTimeout(resolve, Math.min(this.delays.maxRetry, this.delays.retry * 2 ** attempt)));
      }
    }
    let editor = this.editor;
    // A closed page keeps its draft for next time rather than starting over without an editor.
    if (!editor || editor.isDestroyed) return this.closed ? this.park() : false;
    // The same server (you fell behind its log, or must join again): it has everything it
    // confirmed. What it did since your version, while its log has it, says exactly which of
    // your steps it took.
    const same = fresh.epoch === this.epoch;
    let since: { from: number; batch: CollabBatch } | null = null;
    if (same) {
      const from = getVersion(editor.state);
      try {
        since = { from, batch: await this.options.transport.since(fresh.epoch, from) };
      } catch {
        since = null;
      }
      editor = this.editor;
      if (!editor || editor.isDestroyed) return this.closed ? this.park() : false;
    }
    this.keepDraft();
    const known: Known = {
      epoch: this.epoch,
      savedDoc: this.savedDoc ?? editor.state.doc,
      savedVersion: this.savedDocVersion,
      window: this.window,
      unconfirmed: [...(sendableSteps(editor.state)?.steps ?? [])],
      own: new Set(this.ids),
      serverDoc: this.serverDoc ?? editor.state.doc,
      mine: editor.state.doc,
    };
    const former = this.clientID;
    this.adopt(fresh);
    if (!same) this.retired.add(this.epoch);
    this.epoch = fresh.epoch;
    this.revision = fresh.revision;
    this.maps = [];
    this.mapsFrom = fresh.version;
    const schema = editor.schema;
    const freshDoc = schema.nodeFromJSON(fresh.doc);
    let again: Step[];
    if (same) {
      const version = getVersion(editor.state);
      const count = fresh.version - version;
      const batch = since && since.from === version && since.batch.from === version && count >= 0 && since.batch.steps.length >= count ? since.batch : null;
      const exact = batch ? replay(schema, known.serverDoc, version, known.unconfirmed, known.own, { steps: batch.steps.slice(0, count), clientIDs: batch.clientIDs.slice(0, count) }, freshDoc) : null;
      // Its log is gone: the unconfirmed typing moved over what changed since, else the plain merge.
      again = exact ?? carryOver(schema, known.serverDoc, known.unconfirmed, freshDoc);
    } else again = startingOver(schema, known, freshDoc, fresh.start);
    // Swap in the fresh document and version without sending it back…
    editor.unregisterPlugin("collab");
    const swap = editor.state.tr;
    for (const step of diffSteps(editor.state.doc, freshDoc)) swap.step(step);
    if (swap.docChanged) editor.view.dispatch(swap.setMeta("addToHistory", false).setMeta("preventUpdate", true));
    editor.registerPlugin(collab({ version: fresh.version, clientID: this.clientID }));
    this.serverDoc = freshDoc;
    this.saved = fresh.saved;
    if (!same) this.mine = 0;
    this.track(schema, freshDoc, fresh.version, fresh.stored);
    // …then what the server does not have goes again.
    if (again.length) {
      const tr = editor.state.tr;
      for (const step of again) tr.step(step);
      editor.view.dispatch(tr.setMeta("addToHistory", false));
    }
    // The draft moves to the new id.
    this.keepDraft();
    if (former && former !== this.clientID) this.options.drafts?.clear(former);
    return true;
  }

  private kick(): void {
    const state = this.state;
    if (state && !this.stopped && (!this.closed || this.finishing) && sendableSteps(state)) void this.pump();
  }

  /** Try now (the browser is back online). */
  retryNow(): void {
    if (this.stopped || this.closed) return;
    this.failures = 0;
    void this.catchUp();
    const state = this.state;
    if (state && sendableSteps(state)) void this.pump();
  }

  /**
   * Waits until everything typed is on the server, then has it written back. False when that
   * cannot happen now (offline, no longer allowed).
   */
  async flush(): Promise<boolean> {
    for (let tries = 0; tries < 10; tries += 1) {
      if (this.stopped) return false;
      if (this.resetting) await this.resetting;
      await this.pump();
      const state = this.state;
      if (this.stopped) return false;
      // No editor yet: nothing has been typed here.
      if (!state) return true;
      if (sendableSteps(state)) {
        if (this.status === "offline" || this.status === "error") return false;
        continue;
      }
      const epoch = this.epoch;
      try {
        const batch = await this.options.transport.send({ epoch, version: getVersion(state), clientID: this.clientID, token: this.token, steps: [], flush: true });
        this.failures = 0;
        if (typeof batch.revision === "number") this.revision = batch.revision;
        this.take(batch);
        return !this.unsaved;
      } catch (error) {
        const { kind } = failure(error);
        if (kind === "behind" || kind === "reset") await this.failed(error, epoch);
        else {
          if (kind === "lost" || kind === "signedOut") await this.failed(error);
          return false;
        }
      }
    }
    return false;
  }

  /** Writes the draft a little later (typing is being sent; the draft is for when that fails). */
  private scheduleDraft(): void {
    if (this.draftTimer || !this.options.drafts) return;
    this.draftTimer = setTimeout(() => {
      this.draftTimer = undefined;
      this.keepDraft();
    }, this.delays.draft);
  }

  /** Writes what is not yet written back to the draft store now (leaving the page, offline, signed out). */
  keepDraft(): void {
    clearTimeout(this.draftTimer);
    this.draftTimer = undefined;
    const state = this.state;
    const drafts = this.options.drafts;
    if (!drafts || !state || !this.savedDoc || !this.clientID || (this.stopped && this.status !== "lost" && this.status !== "error")) return;
    if (!this.unsaved) return;
    const pending = sendableSteps(state);
    this.savedJSON ??= this.savedDoc.toJSON() as PageDocument;
    let written = false;
    try {
      written = drafts.write({
        clientID: this.clientID,
        ids: [...this.ids],
        epoch: this.epoch,
        saved: this.savedDocVersion,
        savedDoc: this.savedJSON,
        server: { steps: this.window.map((entry) => entry.step.toJSON()), clientIDs: this.window.map((entry) => entry.id) },
        version: getVersion(state),
        steps: pending ? pending.steps.map((step) => step.toJSON()) : [],
        at: Date.now(),
      });
    } catch {
      written = false;
    }
    if (written) {
      this.drafted = true;
      this.draftRefused = false;
    } else if (!this.draftRefused) {
      this.draftRefused = true;
      this.options.onError?.(DRAFT_FULL);
    }
  }

  /** Everything is written back: this editor's draft goes (under every id it had). */
  private clearDrafts(): void {
    clearTimeout(this.draftTimer);
    this.draftTimer = undefined;
    if (!this.drafted) return;
    this.drafted = false;
    for (const id of this.ids) this.options.drafts?.clear(id);
  }

  /**
   * Where a caret someone sent at `version` is in this editor's document now, or null when it
   * cannot be placed exactly.
   */
  place(caret: { anchor: number; head: number; version?: number }): { anchor: number; head: number } | null {
    const editor = this.editor;
    if (!editor || caret.version === undefined) return null;
    const have = getVersion(editor.state);
    if (caret.version > have || caret.version < this.mapsFrom) return null;
    const mapping = new Mapping(this.maps.slice(caret.version - this.mapsFrom, have - this.mapsFrom));
    for (const step of sendableSteps(editor.state)?.steps ?? []) mapping.appendMap(step.getMap());
    const size = editor.state.doc.content.size;
    const clamp = (pos: number) => Math.max(0, Math.min(size, pos));
    return { anchor: clamp(mapping.map(caret.anchor)), head: clamp(mapping.map(caret.head)) };
  }

  /** The version your caret is in, or null while you have unconfirmed typing (it would be off). */
  caretVersion(): number | null {
    const editor = this.editor;
    if (!editor || sendableSteps(editor.state)) return null;
    return getVersion(editor.state);
  }

  /** No more sending (the share is gone); what is typed stays in the editor. */
  freeze(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  /**
   * The page closed. What was typed is still sent and written back from the editor's last state;
   * the draft goes once the server reports it stored, and stays for next time if not. The same
   * page opening again in this tab meanwhile waits for that (`CollabTab.settled`).
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.savedTimer);
    // Drafts taken over but never put back (no editor yet) are left for the next session.
    if (this.restore) this.tab.give(this.restore.drafts.map(({ draft }) => draft.clientID));
    this.restore = null;
    if (this.stopped || !this.unsaved) {
      if (this.unsaved) this.keepDraft();
      this.done();
      return;
    }
    this.keepDraft();
    this.finishing = true;
    const work = this.flush()
      .catch(() => false)
      .finally(() => {
        this.finishing = false;
        if (!this.unsaved) this.clearDrafts();
        else this.keepDraft();
        this.done();
      });
    if (this.options.drafts) this.tab.finishing(this.options.drafts.key, work);
  }
}
