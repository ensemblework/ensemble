/**
 * One page's live document for collaborative editing (prosemirror-collab's central authority).
 * Pure: no database, no event stream. `collab.ts` keeps one of these per open page.
 *
 * Every accepted step moves `version` on by one. Editors send steps made against the version
 * they hold; steps against an older version are refused with what they missed, and the editor
 * rebases its own steps over them and sends again. A write from elsewhere (the assistant, an
 * agent, an older tab saving whole JSON) is taken in as one server step: the difference between
 * the stored copy it was based on and what it wrote, mapped through the steps typed meanwhile.
 */
import { randomUUID } from "node:crypto";
import type { Node, Schema } from "prosemirror-model";
import { Mapping, ReplaceStep, Step } from "prosemirror-transform";
import type { PageDocument } from "@ensemble/shared-types";
import { mergeDocs } from "@ensemble/shared-types/page-merge";

export type ClientID = string | number;
/** The client id on steps the server made (writes from elsewhere). */
export const SERVER_CLIENT = "server";

/** Steps `from` → `version`, with who sent each. */
export type StepBatch = { epoch: string; from: number; version: number; steps: unknown[]; clientIDs: ClientID[] };

export const LIMITS = {
  /** Recent steps kept for editors that fell behind; older ones reload. */
  log: 1000,
  /** Steps in one post. */
  batch: 1000,
  /** ProseMirror positions in one document (roughly characters plus block boundaries). */
  docSize: 2_000_000,
};

export type CollabCode = "COLLAB_BEHIND" | "COLLAB_RESET" | "COLLAB_REJECTED" | "COLLAB_TOO_LARGE";

export class CollabError extends Error {
  constructor(
    readonly code: CollabCode,
    message: string,
    /** For COLLAB_BEHIND: the steps the editor missed. */
    readonly batch?: StepBatch,
  ) {
    super(message);
  }
}

const RESET = "This page was reloaded on the server. Load it again.";

/** One step that turns `from` into `to`, or null when they are the same document. */
export function diffStep(from: Node, to: Node): Step | null {
  const start = from.content.findDiffStart(to.content);
  if (start === null) return null;
  const end = from.content.findDiffEnd(to.content)!;
  let endA = end.a;
  let endB = end.b;
  const overlap = start - Math.min(endA, endB);
  if (overlap > 0) {
    endA += overlap;
    endB += overlap;
  }
  const step = new ReplaceStep(start, endA, to.slice(start, endB));
  if (step.apply(from).doc?.eq(to)) return step;
  return new ReplaceStep(0, from.content.size, to.slice(0, to.content.size));
}

/** What the stored copy holds, and how its positions map onto the live document. */
type Known = {
  revision: number;
  raw: unknown;
  doc: Node;
  /** The live version `doc` corresponds to. */
  version: number;
  /** From positions in `doc` to positions in the live document at `version`; null when unknown. */
  mapping: Mapping | null;
};

export class Authority {
  /** Changes whenever an authority is loaded, so an editor never mixes versions of two. */
  readonly epoch: string = randomUUID();
  doc: Node;
  version = 0;
  private log: Step[] = [];
  private ids: ClientID[] = [];
  known: Known;

  constructor(
    readonly schema: Schema,
    start: { doc: Node; revision: number; raw: unknown },
    private readonly limits = LIMITS,
  ) {
    this.doc = start.doc;
    this.known = { revision: start.revision, raw: start.raw, doc: start.doc, version: 0, mapping: new Mapping() };
  }

  private get first(): number {
    return this.version - this.log.length;
  }

  /** The live document differs from the stored copy. */
  get unsaved(): boolean {
    return this.known.version !== this.version || !this.known.doc.eq(this.doc);
  }

  since(version: number): StepBatch {
    if (!Number.isInteger(version) || version < this.first || version > this.version) throw new CollabError("COLLAB_RESET", RESET);
    const at = version - this.first;
    return { epoch: this.epoch, from: version, version: this.version, steps: this.log.slice(at).map((step) => step.toJSON()), clientIDs: this.ids.slice(at) };
  }

  /** Applies an editor's steps made against `version`. All of them, or none. */
  receive(version: number, steps: unknown[], clientID: ClientID): StepBatch {
    if (!Number.isInteger(version) || version > this.version || version < this.first) throw new CollabError("COLLAB_RESET", RESET);
    if (version < this.version) throw new CollabError("COLLAB_BEHIND", "Someone else changed the page first.", this.since(version));
    if (steps.length > this.limits.batch) throw new CollabError("COLLAB_REJECTED", `Send at most ${this.limits.batch} steps at a time.`);
    let doc = this.doc;
    const parsed: Step[] = [];
    for (const json of steps) {
      let failed: string | null;
      try {
        const step = Step.fromJSON(this.schema, json);
        const result = step.apply(doc);
        failed = result.failed;
        if (result.doc) {
          doc = result.doc;
          parsed.push(step);
        }
      } catch (error) {
        failed = error instanceof Error ? error.message : "invalid step";
      }
      if (failed !== null) throw new CollabError("COLLAB_REJECTED", `This change does not fit the page (${failed}).`);
    }
    if (doc.nodeSize > this.limits.docSize) throw new CollabError("COLLAB_TOO_LARGE", "This page is too large to grow further. Split it into more pages.");
    this.commit(parsed, clientID, doc);
    return this.since(version);
  }

  private commit(steps: Step[], clientID: ClientID, doc: Node): void {
    this.doc = doc;
    this.log.push(...steps);
    this.ids.push(...steps.map(() => clientID));
    this.version += steps.length;
    const over = this.log.length - this.limits.log;
    if (over > 0) {
      this.log.splice(0, over);
      this.ids.splice(0, over);
    }
  }

  /** The stored copy now holds the live document as it was at `version`. */
  persisted(revision: number, raw: unknown, doc: Node, version: number): void {
    this.known = { revision, raw, doc, version, mapping: new Mapping() };
  }

  /**
   * The stored copy changed under the authority (it now holds `theirs`): takes the change in as
   * one server step and returns it to broadcast, or null when the live document is unchanged.
   */
  absorb(raw: unknown, revision: number, theirs: Node): StepBatch | null {
    const known = this.known;
    const from = this.version;
    const change = diffStep(known.doc, theirs);
    if (!change) {
      this.known = { ...known, revision, raw };
      return null;
    }
    let step: Step | null = null;
    let mapping: Mapping | null = null;
    if (known.mapping && known.version >= this.first) {
      const through = new Mapping();
      through.appendMapping(known.mapping);
      for (const done of this.log.slice(known.version - this.first)) through.appendMap(done.getMap());
      const mapped = change.map(through);
      if (mapped?.apply(this.doc).doc) {
        step = mapped;
        // Positions in `theirs`, back to the copy it was made from, forward to the live document.
        mapping = new Mapping();
        mapping.appendMap(change.invert(known.doc).getMap());
        mapping.appendMapping(through);
        mapping.appendMap(mapped.getMap(), 0);
      }
    }
    step ??= this.merged(known.doc, theirs);
    const result = step?.apply(this.doc);
    if (step && result?.doc) this.commit([step], SERVER_CLIENT, result.doc);
    this.known = { revision, raw, doc: theirs, version: this.version, mapping };
    return this.version > from ? this.since(from) : null;
  }

  /** Three-way merge of the stored copy's change into the live document, when mapping cannot place it. */
  private merged(base: Node, theirs: Node): Step | null {
    const json = (doc: Node) => doc.toJSON() as PageDocument;
    const attempt = (doc: PageDocument, check: boolean): Node | null => {
      try {
        const node = this.schema.nodeFromJSON(doc);
        if (check) node.check();
        return node;
      } catch {
        return null;
      }
    };
    const deep = mergeDocs(json(base), json(this.doc), json(theirs)).doc;
    const result = attempt(deep, true) ?? attempt(mergeDocs(json(base), json(this.doc), json(theirs), { deep: false }).doc, true) ?? attempt(deep, false) ?? theirs;
    return diffStep(this.doc, result);
  }
}
