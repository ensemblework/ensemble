/**
 * Live co-editing of pages and task pages (docs/29 §5): one in-memory authority
 * (`collab-core.ts`) per open document, like presence and the event stream (production runs
 * one API process). Editors join, post steps and receive everyone's steps over the event
 * stream (`page.steps`). The authority writes the document back through the page store a
 * moment after typing stops, and takes in writes made elsewhere: every writer publishes a
 * `page`/`task` event after it commits, and the authority then reads the stored copy again.
 */
import type { Node } from "prosemirror-model";
import type { PageDocument } from "@ensemble/shared-types";
import { sameDoc } from "@ensemble/shared-types/page-merge";
import { Authority, CollabError, type ClientID, type StepBatch } from "./collab-core.js";
import { docJson, pageDoc, pageSchema } from "./schema.js";

export type DocKind = "page" | "task";
/** `space` is the owner's id; `id` a standalone page's id, or a task's id for its page. */
export type DocKey = { space: string; kind: DocKind; id: string };
/** The stored copy. `content` is null for a task page never written; `fallback` is then shown. */
export type StoredDoc = { revision: number; content: unknown; fallback: PageDocument };

export interface CollabStore {
  read(key: DocKey): Promise<StoredDoc | null>;
  /**
   * Locks the stored copy, shows it to `decide`, and writes what `decide` returns (null: nothing)
   * as the next revision. Null when the document is gone.
   */
  write(key: DocKey, decide: (row: StoredDoc) => PageDocument | null): Promise<{ revision: number; wrote: boolean } | null>;
}

export type CollabPublish = (space: string, event: string, data: Record<string, unknown>) => void;

/** The live-steps event on the stream. */
export const STEPS_EVENT = "page.steps";

export const TIMING = {
  /** Write back this long after the last step… */
  quietMs: 800,
  /** …but at least this often while steps keep coming. */
  maxMs: 3000,
  retryMs: 5000,
  /** Untouched this long: written back and forgotten. */
  idleMs: 15 * 60_000,
  sweepMs: 60_000,
  maxOpen: 500,
};

type Entry = {
  key: DocKey;
  name: string;
  authority: Authority;
  timer?: ReturnType<typeof setTimeout>;
  dirtySince: number;
  chain: Promise<unknown>;
  used: number;
  gone: boolean;
};

export type Joined = { epoch: string; version: number; doc: PageDocument; revision: number };
export type Posted = StepBatch & { revision?: number };

const nameOf = (key: DocKey) => `${key.space}:${key.kind}:${key.id}`;

function sameContent(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == null && b == null;
  return sameDoc(a as PageDocument, b as PageDocument);
}

function idsOf(data: Record<string, unknown> | null): string[] {
  if (!data) return [];
  const list = [data.id, data.pageId, data.taskId, data.resourceId, ...(Array.isArray(data.ids) ? data.ids : [])];
  return list.filter((value): value is string => typeof value === "string");
}

export class CollabHub {
  private readonly entries = new Map<string, Entry>();
  private readonly loading = new Map<string, Promise<Entry | null>>();
  private sweeper: ReturnType<typeof setInterval> | undefined;
  /** Where failed write-backs are reported; they are retried. */
  onError: (error: unknown) => void = () => undefined;

  constructor(
    private readonly store: CollabStore,
    private readonly publish: CollabPublish,
    private readonly timing = TIMING,
  ) {}

  /** How many documents are open. */
  get size(): number {
    return this.entries.size;
  }

  private docOf(row: StoredDoc): Node {
    return pageDoc(row.content ?? row.fallback, pageSchema);
  }

  private async open(key: DocKey): Promise<Entry | null> {
    const name = nameOf(key);
    const found = this.entries.get(name);
    if (found) {
      found.used = Date.now();
      return found;
    }
    let pending = this.loading.get(name);
    if (!pending) {
      pending = (async () => {
        const row = await this.store.read(key);
        if (!row) return null;
        const entry: Entry = {
          key,
          name,
          authority: new Authority(pageSchema, { doc: this.docOf(row), revision: row.revision, raw: row.content }),
          dirtySince: 0,
          chain: Promise.resolve(),
          used: Date.now(),
          gone: false,
        };
        this.entries.set(name, entry);
        this.startSweeper();
        if (this.entries.size > this.timing.maxOpen) this.evictOldest();
        return entry;
      })().finally(() => this.loading.delete(name));
      this.loading.set(name, pending);
    }
    return pending;
  }

  /** The document as it is now, to start editing from. Null when it does not exist. */
  async join(key: DocKey): Promise<Joined | null> {
    const entry = await this.open(key);
    if (!entry) return null;
    const { authority } = entry;
    return { epoch: authority.epoch, version: authority.version, doc: docJson(authority.doc), revision: authority.known.revision };
  }

  /** Steps since `version`, for an editor that missed some. */
  async since(key: DocKey, epoch: string, version: number): Promise<StepBatch | null> {
    const entry = await this.open(key);
    if (!entry) return null;
    if (entry.authority.epoch !== epoch) throw new CollabError("COLLAB_RESET", "This page was reloaded on the server. Load it again.");
    return entry.authority.since(version);
  }

  /**
   * An editor's steps made against `version`. Answers with the steps from `version` on, its own
   * included. `flush` also writes the page back before answering, with the stored revision.
   */
  async post(key: DocKey, input: { epoch: string; version: number; steps: unknown[]; clientID: ClientID; flush?: boolean }): Promise<Posted | null> {
    const entry = await this.open(key);
    if (!entry) return null;
    const { authority } = entry;
    if (authority.epoch !== input.epoch) throw new CollabError("COLLAB_RESET", "This page was reloaded on the server. Load it again.");
    const batch = authority.receive(input.version, input.steps, input.clientID);
    if (batch.steps.length) {
      this.broadcast(entry, batch);
      this.schedule(entry);
    }
    if (!input.flush) return batch;
    await this.persist(entry);
    if (entry.gone) return null;
    return { ...batch, revision: authority.known.revision };
  }

  private broadcast(entry: Entry, batch: StepBatch): void {
    const { kind, id, space } = entry.key;
    this.publish(space, STEPS_EVENT, { kind, id, ...(kind === "task" ? { taskId: id } : {}), ...batch });
  }

  private serial<T>(entry: Entry, work: () => Promise<T>): Promise<T> {
    const run = entry.chain.then(work);
    entry.chain = run.catch(() => undefined);
    return run;
  }

  private schedule(entry: Entry, wait?: number): void {
    if (entry.gone) return;
    const now = Date.now();
    if (!entry.dirtySince) entry.dirtySince = now;
    clearTimeout(entry.timer);
    const delay = wait ?? Math.max(0, Math.min(this.timing.quietMs, entry.dirtySince + this.timing.maxMs - now));
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.persist(entry).catch((error: unknown) => {
        this.onError(error);
        this.schedule(entry, this.timing.retryMs);
      });
    }, delay);
    entry.timer.unref?.();
  }

  /** A stored copy that differs from what the authority last saw is someone else's write. */
  private absorbRow(entry: Entry, row: StoredDoc): void {
    const { authority } = entry;
    const known = authority.known;
    if (row.revision === known.revision && sameContent(row.content, known.raw)) return;
    let theirs: Node;
    try {
      theirs = this.docOf(row);
    } catch (error) {
      this.onError(error);
      authority.known = { ...known, revision: row.revision, raw: row.content };
      return;
    }
    const batch = authority.absorb(row.content, row.revision, theirs);
    if (batch) this.broadcast(entry, batch);
  }

  private persist(entry: Entry): Promise<void> {
    return this.serial(entry, async () => {
      clearTimeout(entry.timer);
      entry.timer = undefined;
      if (entry.gone) return;
      const { authority, key } = entry;
      const out: { saved?: { doc: Node; version: number; json: PageDocument } } = {};
      const result = await this.store.write(key, (row) => {
        this.absorbRow(entry, row);
        if (!authority.unsaved) return null;
        out.saved = { doc: authority.doc, version: authority.version, json: docJson(authority.doc) };
        return out.saved.json;
      });
      if (!result) {
        this.forget(entry);
        return;
      }
      const saved = out.saved;
      if (saved && result.wrote) {
        authority.persisted(result.revision, saved.json, saved.doc, saved.version);
        this.publish(key.space, "page", { ...(key.kind === "page" ? { id: key.id } : { taskId: key.id }), action: "save", revision: result.revision, by: "collab" });
      }
      entry.dirtySince = 0;
      if (authority.unsaved) this.schedule(entry);
    });
  }

  /** Reads the stored copy again and takes in a change made elsewhere. */
  private sync(entry: Entry): Promise<void> {
    return this.serial(entry, async () => {
      if (entry.gone) return;
      const row = await this.store.read(entry.key);
      if (!row) {
        this.forget(entry);
        return;
      }
      this.absorbRow(entry, row);
      if (entry.authority.unsaved) this.schedule(entry);
    });
  }

  private forget(entry: Entry): void {
    entry.gone = true;
    clearTimeout(entry.timer);
    if (this.entries.get(entry.name) === entry) this.entries.delete(entry.name);
  }

  /**
   * An event about to go out on a space's stream. Page and task events name what a write
   * changed (nothing named: anything in the space might have); those documents are read again.
   */
  changed(space: string, event: string, data: unknown): void {
    if (event !== "page" && event !== "task" && event !== "undo.changed") return;
    const row = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
    if (row?.by === "collab") return;
    const ids = event === "undo.changed" ? [] : idsOf(row);
    const names = ids.length ? new Set(ids.flatMap((id) => [nameOf({ space, kind: "page", id }), nameOf({ space, kind: "task", id })])) : null;
    const wanted = (name: string) => (names ? names.has(name) : name.startsWith(`${space}:`));
    for (const entry of this.entries.values()) {
      if (wanted(entry.name)) void this.sync(entry).catch((error: unknown) => this.onError(error));
    }
    for (const [name, pending] of this.loading) {
      if (wanted(name)) void pending.then((entry) => (entry ? this.sync(entry) : undefined)).catch((error: unknown) => this.onError(error));
    }
  }

  /** Writes back one document now (before converting or deleting it, say). */
  async flush(key: DocKey): Promise<void> {
    const entry = this.entries.get(nameOf(key)) ?? (await this.loading.get(nameOf(key)));
    if (entry) await this.persist(entry);
  }

  /** Writes back everything; on shutdown. */
  async flushAll(): Promise<void> {
    await Promise.all([...this.entries.values()].map((entry) => this.persist(entry).catch((error: unknown) => this.onError(error))));
  }

  private startSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => void this.sweep(), this.timing.sweepMs);
    this.sweeper.unref?.();
  }

  /** Writes back and forgets documents nobody touched for a while. */
  async sweep(now = Date.now()): Promise<void> {
    for (const entry of [...this.entries.values()]) {
      if (now - entry.used < this.timing.idleMs) continue;
      await this.persist(entry).catch((error: unknown) => this.onError(error));
      if (!entry.authority.unsaved && now - entry.used >= this.timing.idleMs) this.forget(entry);
    }
  }

  private evictOldest(): void {
    const oldest = [...this.entries.values()].sort((a, b) => a.used - b.used)[0];
    if (!oldest) return;
    void this.persist(oldest)
      .then(() => {
        if (!oldest.authority.unsaved) this.forget(oldest);
      })
      .catch((error: unknown) => this.onError(error));
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    this.sweeper = undefined;
    await this.flushAll();
    for (const entry of this.entries.values()) clearTimeout(entry.timer);
  }
}
