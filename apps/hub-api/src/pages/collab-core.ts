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
import { Step } from "prosemirror-transform";
import type { PageDocument } from "@ensemble/shared-types";
import { mergeDocs } from "@ensemble/shared-types/page-merge";
import { diffSteps, rebaseSteps } from "./page-diff.js";

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

/** What the stored copy holds. */
type Known = {
  revision: number;
  raw: unknown;
  doc: Node;
  /** The live version this copy was written from, or last compared with. */
  version: number;
  /** `doc` is the live document as it was at `version`, so the steps since apply to it. */
  exact: boolean;
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
    this.known = { revision: start.revision, raw: start.raw, doc: start.doc, version: 0, exact: true };
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
    this.known = { revision, raw, doc, version, exact: true };
  }

  /**
   * The stored copy changed under the authority (it now holds `theirs`): takes the change in as
   * server steps and returns them to broadcast, or null when the live document is unchanged.
   */
  absorb(raw: unknown, revision: number, theirs: Node): StepBatch | null {
    const known = this.known;
    const from = this.version;
    const change = diffSteps(known.doc, theirs);
    if (!change.length) {
      this.known = { ...known, revision, raw };
      return null;
    }
    let steps: Step[] | null = null;
    if (known.exact && known.version >= this.first) steps = rebaseSteps(known.doc, change, this.log.slice(known.version - this.first));
    steps ??= this.merged(known.doc, theirs);
    let doc = this.doc;
    const applied: Step[] = [];
    for (const step of steps) {
      const result = step.apply(doc);
      if (!result.doc) break;
      doc = result.doc;
      applied.push(step);
    }
    if (applied.length) this.commit(applied, SERVER_CLIENT, doc);
    this.known = { revision, raw, doc: theirs, version: this.version, exact: this.doc.eq(theirs) };
    return this.version > from ? this.since(from) : null;
  }

  /** Three-way merge of the stored copy's change into the live document, when mapping cannot place it. */
  private merged(base: Node, theirs: Node): Step[] {
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
    return diffSteps(this.doc, result);
  }
}
