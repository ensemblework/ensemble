/**
 * Live co-editing for one page in the block editor: prosemirror-collab on this side, the central
 * authority in hub-api (`src/pages/collab.ts`) on the other (docs/29 §5).
 *
 * The editor sends the steps you type (throttled, one request at a time). The server answers
 * with the steps since your version, confirming yours; steps it refuses because someone else
 * got in first come back with what you missed, your steps are rebased over them and sent
 * again. Everyone's steps also arrive over the event stream. Nothing typed is thrown away: an
 * unreachable server keeps the steps and retries, and when the server's document starts over
 * (it restarted, or you were too far behind) your unsent change is proposed again as one step
 * from the fresh document. Until it is confirmed, unsent typing is also kept as a draft, so a
 * reload or an expired session does not lose it.
 */
import { Extension, type Editor } from "@tiptap/core";
import { collab, getVersion, receiveTransaction, sendableSteps } from "@tiptap/pm/collab";
import type { Node as ProseNode, Schema } from "@tiptap/pm/model";
import { Mapping, Step, type StepMap } from "@tiptap/pm/transform";
import type { PageDocument } from "@ensemble/shared-types";
import { mergeDocs } from "@ensemble/shared-types/page-merge";
import { changesOnto, diffSteps } from "./page-diff";

export type ClientID = string | number;
export type CollabJoin = { epoch: string; version: number; doc: PageDocument; revision: number };
/** Steps `from` → `version`, with who sent each. `revision` answers a flush. */
export type CollabBatch = { epoch: string; from: number; version: number; steps: unknown[]; clientIDs: ClientID[]; revision?: number };
export type CollabSend = { epoch: string; version: number; clientID: ClientID; steps: unknown[]; flush?: boolean };

/** The three requests; `lib/api.ts` in the app, an in-memory authority in tests. Failures throw `{ status, code, data }`. */
export type CollabTransport = {
  join(): Promise<CollabJoin>;
  since(epoch: string, version: number): Promise<CollabBatch>;
  send(body: CollabSend): Promise<CollabBatch>;
};

/** saved: everything typed is on the server. offline: it cannot be reached; typing is kept and sent later. lost: you can no longer edit. */
export type CollabStatus = "saved" | "saving" | "offline" | "error" | "lost";

/** Unsent typing: the server's document at `version` (`base`) and yours (`doc`). */
export type Draft = { epoch: string; version: number; base: PageDocument; doc: PageDocument; at: number };
export type DraftStore = { read(): Draft | null; write(draft: Draft): void; clear(): void };

/** What the block editor needs to run live: the version its document is at, and where to report. */
export type CollabBinding = { version: number; clientID: ClientID; attach(editor: Editor): () => void };

export type CollabSessionOptions = {
  transport: CollabTransport;
  clientID: ClientID;
  /** Someone else is on the page: send sooner. */
  live?: () => boolean;
  drafts?: DraftStore | null;
  onStatus?: (status: CollabStatus) => void;
  /** The share was removed or edit rights taken away. Your text stays on screen. */
  onLost?: (error: unknown) => void;
  /** The session expired. The draft is written before the app goes to sign in. */
  onSignedOut?: () => void;
  onError?: (message: string) => void;
  /** A draft from before a reload or sign-in was put back on the page. */
  onRestored?: () => void;
  delays?: Partial<typeof DELAYS>;
};

const DELAYS = {
  /** Wait before sending while someone else is on the page… */
  live: 60,
  /** …and while you are alone on it. */
  alone: 250,
  retry: 1000,
  maxRetry: 30_000,
};
/** Recent step maps kept to place other people's carets sent from older versions. */
const KEEP_MAPS = 500;
const DRAFT_EVERY_MS = 1000;

type Failure = "behind" | "reset" | "lost" | "signedOut" | "offline" | "busy" | "failed";

function failure(error: unknown): { kind: Failure; data: unknown; message: string } {
  const { status, code, data, message } = (error ?? {}) as { status?: number; code?: string | null; data?: unknown; message?: string };
  const text = message ?? "Could not save.";
  if (status === 409 && code === "COLLAB_BEHIND") return { kind: "behind", data, message: text };
  if (status === 410 || (status === 400 && code === "COLLAB_REJECTED")) return { kind: "reset", data, message: text };
  if (status === 401) return { kind: "signedOut", data, message: text };
  if (code === "SHARE_GONE" || status === 403 || status === 404) return { kind: "lost", data, message: text };
  if (!status || status >= 500) return { kind: "offline", data, message: text };
  if (status === 429) return { kind: "busy", data, message: text };
  return { kind: "failed", data, message: text };
}

/**
 * `mine` and `fresh` both changed `base`: the steps that put mine's changes onto `fresh`. Moved
 * step by step where they still fit; otherwise the three-way merge, which never drops yours.
 */
export function carryOver(schema: Schema, base: ProseNode, mine: ProseNode, fresh: ProseNode): Step[] {
  if (mine.eq(base)) return [];
  const moved = changesOnto(base, mine, fresh);
  if (moved) return moved;
  const json = (node: ProseNode) => node.toJSON() as PageDocument;
  const parse = (doc: PageDocument, check: boolean) => {
    try {
      const node = schema.nodeFromJSON(doc);
      if (check) node.check();
      return node;
    } catch {
      return null;
    }
  };
  const deep = mergeDocs(json(base), json(mine), json(fresh)).doc;
  const merged = parse(deep, true) ?? parse(mergeDocs(json(base), json(mine), json(fresh), { deep: false }).doc, true) ?? parse(deep, false) ?? mine;
  return diffSteps(fresh, merged);
}

/** The prosemirror-collab plugin, set up with the version the editor's document is at. */
export const CollabSync = Extension.create<{ version: number; clientID: ClientID }, { session: CollabSession | null }>({
  name: "collabSync",
  addOptions() {
    return { version: 0, clientID: "" };
  },
  addStorage() {
    return { session: null };
  },
  addProseMirrorPlugins() {
    return [collab({ version: this.options.version, clientID: this.options.clientID })];
  },
});

/** The session behind an editor, when it is live. */
export function sessionOf(editor: Editor): CollabSession | null {
  return (editor.storage as { collabSync?: { session: CollabSession | null } }).collabSync?.session ?? null;
}

export class CollabSession {
  readonly clientID: ClientID;
  status: CollabStatus = "saved";
  /** The stored revision after the last flush or join. */
  revision = 0;
  private epoch = "";
  private editor: Editor | null = null;
  /** The server's document at the editor's version. */
  private serverDoc: ProseNode | null = null;
  private joinedDoc: PageDocument | null = null;
  private maps: StepMap[] = [];
  private mapsFrom = 0;
  private waiting: CollabBatch[] = [];
  private draft: Draft | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pumping: Promise<void> | null = null;
  /** The steps request on the way, if any. */
  private sending: Promise<unknown> | null = null;
  /** Epochs this session has moved on from; their late answers are ignored. */
  private readonly retired = new Set<string>();
  private resetting: Promise<void> | null = null;
  private catching: Promise<void> | null = null;
  private failures = 0;
  private draftAt = 0;
  /** Lost access, frozen or signed out: nothing more is sent. */
  private stopped = false;
  /** The page closed. */
  private closed = false;
  private finished = false;
  private last: PageDocument | null = null;
  private readonly delays: typeof DELAYS;

  constructor(private readonly options: CollabSessionOptions) {
    this.clientID = options.clientID;
    this.delays = { ...DELAYS, ...options.delays };
  }

  private setStatus(status: CollabStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatus?.(status);
  }

  /** Reads the server's document to start from, and any draft left from before. */
  async join(): Promise<CollabJoin> {
    const joined = await this.options.transport.join();
    this.epoch = joined.epoch;
    this.revision = joined.revision;
    this.joinedDoc = joined.doc;
    this.mapsFrom = joined.version;
    this.draft = this.options.drafts?.read() ?? null;
    return joined;
  }

  /** The editor was created from the joined document with `CollabSync` at its version. */
  attach(editor: Editor): () => void {
    this.editor = editor;
    this.finished = false;
    (editor.storage as { collabSync?: { session: CollabSession | null } }).collabSync!.session = this;
    this.serverDoc = editor.state.doc;
    const onTransaction = () => this.changed();
    editor.on("transaction", onTransaction);
    const waiting = this.waiting.splice(0);
    for (const batch of waiting) this.receive(batch);
    this.restoreDraft();
    return () => {
      editor.off("transaction", onTransaction);
      this.finish();
      if (!editor.isDestroyed) this.last = editor.getJSON() as PageDocument;
      if (this.editor === editor) this.editor = null;
    };
  }

  /** The page is closing: one last try for what is unsent. If it fails, the draft has it. */
  private finish(): void {
    const editor = this.editor;
    if (this.finished || !editor || editor.isDestroyed) return;
    this.finished = true;
    clearTimeout(this.timer);
    const pending = this.stopped || this.resetting ? null : sendableSteps(editor.state);
    if (!pending) return;
    this.keepDraft();
    void this.options.transport
      .send({ epoch: this.epoch, version: pending.version, clientID: this.clientID, steps: pending.steps.map((step) => step.toJSON()) })
      .then(() => this.options.drafts?.clear())
      .catch(() => undefined);
  }

  private restoreDraft(): void {
    const draft = this.draft;
    const editor = this.editor;
    this.draft = null;
    if (!draft || !editor) return;
    try {
      const schema = editor.schema;
      const steps = carryOver(schema, schema.nodeFromJSON(draft.base), schema.nodeFromJSON(draft.doc), editor.state.doc);
      if (!steps.length) {
        this.options.drafts?.clear();
        return;
      }
      const tr = editor.state.tr;
      for (const step of steps) tr.step(step);
      editor.view.dispatch(tr.setMeta("addToHistory", false));
      this.options.onRestored?.();
    } catch {
      this.options.drafts?.clear();
    }
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
      const editor = this.editor;
      if (this.stopped || this.closed || !editor || editor.isDestroyed || this.resetting) return;
      const sendable = sendableSteps(editor.state);
      if (!sendable) {
        this.setStatus("saved");
        this.options.drafts?.clear();
        return;
      }
      // While retrying, the page keeps saying it is offline until a request goes through.
      if (!this.failures) this.setStatus("saving");
      this.keepDraft(false);
      try {
        this.sending = this.options.transport.send({ epoch: this.epoch, version: sendable.version, clientID: this.clientID, steps: sendable.steps.map((step) => step.toJSON()) });
        const batch = (await this.sending.finally(() => (this.sending = null))) as CollabBatch;
        this.failures = 0;
        this.take(batch);
        // Typing went on while this was sent: gather a little more before the next request.
        if (this.editor && sendableSteps(this.editor.state)) await new Promise((resolve) => setTimeout(resolve, this.options.live?.() ? this.delays.live : this.delays.alone));
      } catch (error) {
        if (!(await this.failed(error))) return;
      }
    }
    // Still refused after many rounds: try again in a moment rather than spin.
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.pump();
    }, this.delays.retry);
  }

  /** Handles a refused or failed request. True: try again now. */
  private async failed(error: unknown): Promise<boolean> {
    const { kind, data, message } = failure(error);
    switch (kind) {
      case "behind":
        this.take(data as CollabBatch);
        return true;
      case "reset":
        await this.reset();
        return true;
      case "lost":
        this.stopped = true;
        clearTimeout(this.timer);
        this.options.drafts?.clear();
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
        this.failures += 1;
        this.setStatus(kind === "offline" ? "offline" : kind === "busy" ? "saving" : "error");
        if (kind === "failed" && this.failures === 1) this.options.onError?.(message);
        this.keepDraft();
        const wait = Math.min(this.delays.maxRetry, this.delays.retry * 2 ** (this.failures - 1));
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = undefined;
          void this.pump();
        }, wait);
        return false;
      }
    }
  }

  /** Steps from the server, as an answer or from the event stream. */
  receive(batch: CollabBatch): void {
    if (!this.editor) {
      if (this.waiting.length < 200) this.waiting.push(batch);
      return;
    }
    this.take(batch);
  }

  private take(batch: CollabBatch): void {
    const outcome = this.apply(batch);
    if (outcome === "gap") void this.catchUp();
    else if (outcome === "reset") void this.reset();
  }

  private apply(batch: CollabBatch): "ok" | "gap" | "reset" {
    const editor = this.editor;
    if (!editor || editor.isDestroyed) return "ok";
    if (batch.epoch !== this.epoch) return this.resetting || this.retired.has(batch.epoch) ? "ok" : "reset";
    const have = getVersion(editor.state);
    if (batch.from > have) return "gap";
    const skip = have - batch.from;
    if (skip >= batch.steps.length) return "ok";
    try {
      const steps = batch.steps.slice(skip).map((json) => Step.fromJSON(editor.schema, json));
      let server = this.serverDoc!;
      for (const step of steps) {
        const result = step.apply(server);
        if (!result.doc) return "reset";
        server = result.doc;
      }
      const tr = receiveTransaction(editor.state, steps, batch.clientIDs.slice(skip), { mapSelectionBackward: true });
      editor.view.dispatch(tr.setMeta("preventUpdate", true));
      this.serverDoc = server;
      for (const step of steps) this.maps.push(step.getMap());
      const over = this.maps.length - KEEP_MAPS;
      if (over > 0) {
        this.maps.splice(0, over);
        this.mapsFrom += over;
      }
      return "ok";
    } catch {
      return "reset";
    }
  }

  /** Fetches steps the event stream did not bring (after a reconnect, or a gap). */
  catchUp(): Promise<void> {
    if (this.catching || this.stopped || this.closed || this.resetting || !this.editor) return this.catching ?? Promise.resolve();
    const editor = this.editor;
    this.catching = (async () => {
      try {
        this.take(await this.options.transport.since(this.epoch, getVersion(editor.state)));
      } catch (error) {
        const { kind } = failure(error);
        if (kind === "reset") await this.reset();
        else if (kind === "lost") await this.failed(error);
      }
    })().finally(() => {
      this.catching = null;
    });
    return this.catching;
  }

  /** The server's document started over: take the fresh one and propose your unsent change again. */
  private reset(): Promise<void> {
    this.resetting ??= this.restart().finally(() => {
      this.resetting = null;
      // Steps that came meanwhile were for the old version, or are not here yet.
      void this.catchUp();
      this.kick();
    });
    return this.resetting;
  }

  private async restart(): Promise<void> {
    // Steps on the way may have landed before the server started over: take the answer first.
    if (this.sending) await this.sending.catch(() => undefined);
    let fresh: CollabJoin | null = null;
    for (let attempt = 0; !fresh; attempt += 1) {
      if (this.stopped) return;
      try {
        fresh = await this.options.transport.join();
      } catch (error) {
        const { kind } = failure(error);
        if (kind === "lost" || kind === "signedOut") {
          await this.failed(error);
          return;
        }
        this.setStatus("offline");
        await new Promise((resolve) => setTimeout(resolve, Math.min(this.delays.maxRetry, this.delays.retry * 2 ** attempt)));
      }
    }
    const editor = this.editor;
    if (fresh.epoch !== this.epoch) this.retired.add(this.epoch);
    this.epoch = fresh.epoch;
    this.revision = fresh.revision;
    this.maps = [];
    this.mapsFrom = fresh.version;
    if (!editor || editor.isDestroyed) return;
    const schema = editor.schema;
    const freshDoc = schema.nodeFromJSON(fresh.doc);
    const again = carryOver(schema, this.serverDoc ?? freshDoc, editor.state.doc, freshDoc);
    // Swap in the fresh document and version without sending it back…
    editor.unregisterPlugin("collab");
    const swap = editor.state.tr;
    for (const step of diffSteps(editor.state.doc, freshDoc)) swap.step(step);
    if (swap.docChanged) editor.view.dispatch(swap.setMeta("addToHistory", false).setMeta("preventUpdate", true));
    editor.registerPlugin(collab({ version: fresh.version, clientID: this.clientID }));
    this.serverDoc = freshDoc;
    // …then what the server does not have goes again.
    if (again.length) {
      const tr = editor.state.tr;
      for (const step of again) tr.step(step);
      editor.view.dispatch(tr.setMeta("addToHistory", false));
    }
  }

  private kick(): void {
    if (this.editor && !this.stopped && !this.closed && sendableSteps(this.editor.state)) void this.pump();
  }

  /** Try now (the browser is back online). */
  retryNow(): void {
    if (this.stopped || this.closed) return;
    this.failures = 0;
    void this.catchUp();
    if (this.editor && sendableSteps(this.editor.state)) void this.pump();
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
      const editor = this.editor;
      if (this.stopped) return false;
      // No editor yet: nothing has been typed here.
      if (!editor) return true;
      if (sendableSteps(editor.state)) {
        if (this.status === "offline" || this.status === "error") return false;
        continue;
      }
      try {
        const batch = await this.options.transport.send({ epoch: this.epoch, version: getVersion(editor.state), clientID: this.clientID, steps: [], flush: true });
        this.take(batch);
        if (typeof batch.revision === "number") this.revision = batch.revision;
        return true;
      } catch (error) {
        const { kind } = failure(error);
        if (kind === "behind" || kind === "reset") await this.failed(error);
        else {
          if (kind === "lost" || kind === "signedOut") await this.failed(error);
          return false;
        }
      }
    }
    return false;
  }

  /** Writes unsent typing to the draft store (at most once a second unless `now`). */
  keepDraft(now = true): void {
    const editor = this.editor;
    const drafts = this.options.drafts;
    if (!drafts || !editor || editor.isDestroyed || !this.serverDoc || this.stopped) return;
    if (!now && Date.now() - this.draftAt < DRAFT_EVERY_MS) return;
    if (!sendableSteps(editor.state)) return;
    this.draftAt = Date.now();
    drafts.write({ epoch: this.epoch, version: getVersion(editor.state), base: this.serverDoc.toJSON() as PageDocument, doc: editor.state.doc.toJSON() as PageDocument, at: this.draftAt });
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

  close(): void {
    this.finish();
    this.closed = true;
    clearTimeout(this.timer);
  }
}
