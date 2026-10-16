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
/**
 * The stored copy. `content` is null for a task page never written; `fallback` (its notes) is then
 * shown. `trashed`: the page is in Trash; it still takes a write-back, but is not opened.
 */
export type StoredDoc = { revision: number; content: unknown; fallback: PageDocument; trashed?: boolean; marker?: { epoch: string; version: number } };

export interface CollabStore {
  read(key: DocKey): Promise<StoredDoc | null>;
  /**
   * Locks the stored copy, shows it to `decide`, and writes what `decide` returns (null: nothing)
   * as the next revision, also into a page in Trash. Null when the document is gone.
   */
  write(key: DocKey, decide: (row: StoredDoc) => { content: PageDocument; marker: { epoch: string; version: number } } | null): Promise<{ revision: number; wrote: boolean } | null>;
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
  /** Write-backs failing this many times in a row: steps are refused until one succeeds. */
  failLimit: 3,
  /** A page event that changed nothing is checked again after these delays (its writer may not have committed). */
  recheckMs: [300, 2000],
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
  /** Write-backs that failed in a row. */
  failures: number;
  recheck?: ReturnType<typeof setTimeout>;
};

/**
 * `stored`, when asked for: the stored copy as last written back or loaded (at `version`) and
 * the steps since, when the log still has them and anything was typed since.
 */
export type Joined = {
  epoch: string;
  version: number;
  doc: PageDocument;
  revision: number;
  saved: number;
  stored?: { version: number; doc: PageDocument; steps: unknown[]; clientIDs: ClientID[] };
  /**
   * `start`, when asked for and the log still has it: the document as loaded, the steps since, and
   * which authority (epoch, version) wrote it, for editors starting over after a restart.
   */
  start?: { doc: PageDocument; steps: unknown[]; clientIDs: ClientID[]; previous: { epoch: string; version: number } | null };
};
export type Posted = StepBatch & { revision?: number };

const nameOf = (key: DocKey) => `${key.space}:${key.kind}:${key.id}`;

function sameContent(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == null && b == null;
  return sameDoc(a as PageDocument, b as PageDocument);
}

/** What a stored copy shows: its content, or for a task page never written, its notes. */
const shownOf = (row: StoredDoc): unknown => row.content ?? row.fallback;

const UNSAVED = "This page can't be saved right now. Your changes are kept on this computer and sent again shortly.";

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
        if (row.trashed) throw new CollabError("PAGE_IN_TRASH", "This page is in Trash.");
        const entry: Entry = {
          key,
          name,
          authority: new Authority(pageSchema, { doc: this.docOf(row), revision: row.revision, raw: shownOf(row), previous: row.marker ?? null }),
          dirtySince: 0,
          chain: Promise.resolve(),
          used: Date.now(),
          gone: false,
          failures: 0,
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

  /**
   * The document as it is now, to start editing from. Null when it does not exist. `stored` adds
   * the stored copy and the steps typed since: an editor can then tell which of its typing the
   * server has written back, when it starts over after a restart.
   */
  async join(key: DocKey, options: { stored?: boolean; start?: boolean } = {}): Promise<Joined | null> {
    const entry = await this.open(key);
    if (!entry) return null;
    const { authority } = entry;
    const joined: Joined = { epoch: authority.epoch, version: authority.version, doc: docJson(authority.doc), revision: authority.known.revision, saved: authority.saved };
    const known = authority.known;
    if (options.stored && known.exact && known.version < authority.version && known.version >= authority.first) {
      const since = authority.since(known.version);
      joined.stored = { version: known.version, doc: docJson(known.doc), steps: since.steps, clientIDs: since.clientIDs };
    }
    if (options.start && authority.first === 0) {
      const since = authority.since(0);
      joined.start = { doc: docJson(authority.loaded), steps: since.steps, clientIDs: since.clientIDs, previous: authority.previous };
    }
    return joined;
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
  async post(key: DocKey, input: { epoch: string; version: number; steps: unknown[]; clientID: ClientID; flush?: boolean; trusted?: boolean }): Promise<Posted | null> {
    const entry = await this.open(key);
    if (!entry) return null;
    const { authority } = entry;
    // Not the editor that joined with this client id (or another account now): it joins again.
    if (input.trusted === false) throw new CollabError("COLLAB_REJOIN", "Join this page again to go on editing.");
    if (authority.epoch !== input.epoch) throw new CollabError("COLLAB_RESET", "This page was reloaded on the server. Load it again.");
    // While the page cannot be written back, steps stay with the editors that typed them.
    if (entry.failures >= this.timing.failLimit) throw new CollabError("COLLAB_UNSAVED", UNSAVED);
    const batch = authority.receive(input.version, input.steps, input.clientID);
    if (batch.steps.length) {
      this.broadcast(entry, batch);
      this.schedule(entry);
    }
    if (!input.flush) return batch;
    try {
      await this.persist(entry);
    } catch (error) {
      this.failed(entry, error);
      throw new CollabError("COLLAB_UNSAVED", UNSAVED);
    }
    if (entry.gone) return null;
    return { ...batch, saved: authority.saved, revision: authority.known.revision };
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
      void this.persist(entry).catch((error: unknown) => this.failed(entry, error));
    }, delay);
    entry.timer.unref?.();
  }

  /** A write-back failed: counted, reported, and tried again later. */
  private failed(entry: Entry, error: unknown): void {
    entry.failures += 1;
    this.onError(error);
    this.schedule(entry, this.timing.retryMs);
  }

  /** A stored copy that differs from what the authority last saw is someone else's write. */
  private absorbRow(entry: Entry, row: StoredDoc): boolean {
    const { authority } = entry;
    const known = authority.known;
    const shown = shownOf(row);
    if (row.revision === known.revision && sameContent(shown, known.raw)) return false;
    let theirs: Node;
    try {
      theirs = this.docOf(row);
    } catch (error) {
      this.onError(error);
      authority.known = { ...known, revision: row.revision, raw: shown };
      return false;
    }
    const batch = authority.absorb(shown, row.revision, theirs);
    if (batch) this.broadcast(entry, batch);
    return true;
  }

  private persist(entry: Entry): Promise<void> {
    return this.serial(entry, () => this.writeBack(entry));
  }

  /** The write-back itself; callers hold the entry's turn. */
  private async writeBack(entry: Entry): Promise<void> {
    clearTimeout(entry.timer);
    entry.timer = undefined;
    if (entry.gone) return;
    const { authority, key } = entry;
    const out: { saved?: { doc: Node; version: number; json: PageDocument } } = {};
    const result = await this.store.write(key, (row) => {
      this.absorbRow(entry, row);
      if (!authority.unsaved) return null;
      out.saved = { doc: authority.doc, version: authority.version, json: docJson(authority.doc) };
      return { content: out.saved.json, marker: { epoch: authority.epoch, version: authority.version } };
    });
    if (!result) {
      this.forget(entry);
      return;
    }
    const saved = out.saved;
    entry.failures = 0;
    if (saved && result.wrote) {
      authority.persisted(result.revision, saved.json, saved.doc, saved.version);
      // `saved` tells the editors their typing up to that version is stored, so they can drop their drafts.
      this.publish(key.space, "page", { ...(key.kind === "page" ? { id: key.id } : { taskId: key.id }), action: "save", revision: result.revision, by: "collab", epoch: authority.epoch, saved: authority.saved });
    }
    entry.dirtySince = 0;
    if (authority.unsaved) this.schedule(entry);
  }

  /**
   * Reads the stored copy again and takes in a change made elsewhere. A page moved to Trash (or
   * gone) gets what is unsaved written back first, then is dropped. True when something changed.
   */
  private sync(entry: Entry): Promise<boolean> {
    return this.serial(entry, async () => {
      if (entry.gone) return false;
      const row = await this.store.read(entry.key);
      if (!row || row.trashed) {
        if (entry.authority.unsaved) await this.writeBack(entry).catch((error: unknown) => this.onError(error));
        this.forget(entry);
        return true;
      }
      const changed = this.absorbRow(entry, row);
      if (entry.authority.unsaved) this.schedule(entry);
      return changed;
    });
  }

  private forget(entry: Entry): void {
    entry.gone = true;
    clearTimeout(entry.timer);
    clearTimeout(entry.recheck);
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
      if (!wanted(entry.name)) continue;
      const check = (later: number[]) => {
        void this.sync(entry)
          .then((changed) => {
            // Some writers publish before their transaction commits: read once or twice more.
            if (changed || !later.length || event !== "page" || entry.gone || entry.recheck) return;
            entry.recheck = setTimeout(() => {
              entry.recheck = undefined;
              check(later.slice(1));
            }, later[0]);
            entry.recheck.unref?.();
          })
          .catch((error: unknown) => this.onError(error));
      };
      check(this.timing.recheckMs);
    }
    for (const [name, pending] of this.loading) {
      if (wanted(name)) void pending.then((entry) => (entry ? this.sync(entry) : undefined)).catch((error: unknown) => this.onError(error));
    }
  }

  /** Writes back one document now (before converting or deleting it, say). */
  async flush(key: DocKey): Promise<void> {
    const entry = this.entries.get(nameOf(key)) ?? (await this.loading.get(nameOf(key))?.catch(() => null));
    if (entry) await this.persist(entry);
  }

  /** Writes back every open page of a space (before pages are moved to Trash, say). */
  async flushSpace(space: string): Promise<void> {
    const open = [...this.entries.values()].filter((entry) => entry.key.space === space);
    await Promise.all(open.map((entry) => this.persist(entry).catch((error: unknown) => this.failed(entry, error))));
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
