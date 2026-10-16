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
import type { Fragment, Node, Schema } from "prosemirror-model";
import { AttrStep, ReplaceAroundStep, ReplaceStep, Step } from "prosemirror-transform";
import { PageMention, type PageDocument } from "@ensemble/shared-types";
import { mergeDocs } from "@ensemble/shared-types/page-merge";
import { diffSteps, rebaseSteps } from "./page-diff.js";
import { LONE_SURROGATE } from "./content.js";

export type ClientID = string;
/** The client id on steps the server made (writes from elsewhere). */
export const SERVER_CLIENT = "server";

/** Steps `from` → `version`, with who sent each, and the last version written back (`saved`). */
export type StepBatch = { epoch: string; from: number; version: number; steps: unknown[]; clientIDs: ClientID[]; saved: number };

export const LIMITS = {
  /** Recent steps kept for editors that fell behind; older ones reload… */
  log: 1000,
  /** …and no more than this many bytes of them. */
  logBytes: 8_000_000,
  /** Steps in one post. */
  batch: 1000,
  /** One step, as JSON. */
  stepBytes: 1_000_000,
  /**
   * ProseMirror positions in one document (roughly characters plus block boundaries), and the
   * document as JSON: at least what a whole-page save (a 4 MiB body) could store. Only changes
   * that grow a page past them are refused; a larger page (written by an agent, say) can still
   * be edited and shortened.
   */
  docSize: 4_200_000,
  docBytes: 8_000_000,
  /** Blocks inside blocks. */
  depth: 48,
};

export type CollabCode = "COLLAB_BEHIND" | "COLLAB_RESET" | "COLLAB_REJECTED" | "COLLAB_TOO_LARGE" | "COLLAB_UNSAVED" | "PAGE_IN_TRASH" | "COLLAB_REJOIN";

export class CollabError extends Error {
  constructor(
    readonly code: CollabCode,
    message: string,
    /** For COLLAB_BEHIND: the steps the editor missed. */
    readonly batch?: StepBatch,
    /** For a refused change: which step of the batch, so the editor can take back that one. */
    readonly step?: number,
  ) {
    super(message);
  }
}


/** Why the strings in a step (text, attribute values) cannot be stored, or null. */
function badText(value: unknown, depth = 0): string | null {
  if (typeof value === "string") {
    if (value.includes("\u0000")) return "This change has a character pages cannot store (U+0000).";
    if (LONE_SURROGATE.test(value)) return "This change has a broken character (half of an emoji or symbol).";
    return null;
  }
  if (!value || typeof value !== "object" || depth > 200) return null;
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    const bad = badText(item, depth + 1);
    if (bad) return bad;
  }
  return null;
}

const RESET = "This page was reloaded on the server. Load it again.";

/** How deeply nodes nest in a fragment. */
function depthOf(fragment: Fragment): number {
  let deepest = 0;
  fragment.forEach((child) => {
    deepest = Math.max(deepest, 1 + depthOf(child.content));
  });
  return deepest;
}

/** A mention the page store can index (`PageMention`), as `documentMentions` reads it. */
function validMention(attrs: Record<string, unknown>): boolean {
  return PageMention.safeParse({ kind: String(attrs.kind ?? "people"), id: String(attrs.id ?? ""), label: String(attrs.label ?? "") }).success;
}

function mentionsValid(fragment: Fragment): boolean {
  let valid = true;
  fragment.descendants((node) => {
    if (node.type.name === "mention" && !validMention(node.attrs)) valid = false;
    return valid;
  });
  return valid;
}

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
  /** The document as loaded (version 0), and the authority that wrote it, if the stored copy says. */
  readonly loaded: Node;
  readonly previous: { epoch: string; version: number } | null;
  doc: Node;
  version = 0;
  /** The last version written back to the stored copy. */
  saved = 0;
  private log: Step[] = [];
  private ids: ClientID[] = [];
  private sizes: number[] = [];
  private logBytes = 0;
  /** The document's JSON size when last measured, and an upper bound of what was added since. */
  private docBytes: number;
  private grown = 0;
  known: Known;

  constructor(
    readonly schema: Schema,
    start: { doc: Node; revision: number; raw: unknown; previous?: { epoch: string; version: number } | null },
    private readonly limits = LIMITS,
  ) {
    this.doc = start.doc;
    this.loaded = start.doc;
    this.previous = start.previous ?? null;
    this.docBytes = JSON.stringify(start.doc.toJSON()).length;
    this.known = { revision: start.revision, raw: start.raw, doc: start.doc, version: 0, exact: true };
  }

  /** The oldest version the log still has steps from. */
  get first(): number {
    return this.version - this.log.length;
  }

  /** The live document differs from the stored copy. */
  get unsaved(): boolean {
    return this.known.version !== this.version || !this.known.doc.eq(this.doc);
  }

  since(version: number): StepBatch {
    if (!Number.isInteger(version) || version < this.first || version > this.version) throw new CollabError("COLLAB_RESET", RESET);
    const at = version - this.first;
    return { epoch: this.epoch, from: version, version: this.version, steps: this.log.slice(at).map((step) => step.toJSON()), clientIDs: this.ids.slice(at), saved: this.saved };
  }

  /** Applies an editor's steps made against `version`. All of them, or none. */
  receive(version: number, steps: unknown[], clientID: ClientID): StepBatch {
    if (!Number.isInteger(version) || version > this.version || version < this.first) throw new CollabError("COLLAB_RESET", RESET);
    if (version < this.version) throw new CollabError("COLLAB_BEHIND", "Someone else changed the page first.", this.since(version));
    if (steps.length > this.limits.batch) throw new CollabError("COLLAB_TOO_LARGE", `Send at most ${this.limits.batch} steps at a time.`);
    const docs: Node[] = [this.doc];
    let bytes = 0;
    let nests = false;
    const parsed: Step[] = [];
    const sizes: number[] = [];
    for (const [at, json] of steps.entries()) {
      const refuse = (code: CollabCode, message: string) => new CollabError(code, message, undefined, at);
      const doc = docs.at(-1)!;
      const text = JSON.stringify(json) ?? "";
      if (text.length > this.limits.stepBytes) throw refuse("COLLAB_TOO_LARGE", "This change is too large to save in one piece. Paste it in parts.");
      const bad = badText(json);
      if (bad) throw refuse("COLLAB_REJECTED", bad);
      let step: Step;
      let result;
      try {
        step = Step.fromJSON(this.schema, json);
        const refused = this.refuse(step, doc);
        if (refused) throw refuse("COLLAB_REJECTED", refused);
        result = step.apply(doc);
      } catch (error) {
        if (error instanceof CollabError) throw error;
        throw refuse("COLLAB_REJECTED", `This change does not fit the page (${error instanceof Error ? error.message : "invalid step"}).`);
      }
      if (!result.doc) throw refuse("COLLAB_REJECTED", `This change does not fit the page (${result.failed}).`);
      docs.push(result.doc);
      parsed.push(step);
      sizes.push(text.length);
      bytes += text.length;
      // Blocks put inside others: nesting is checked once the batch is applied.
      nests ||= step instanceof ReplaceAroundStep || (step instanceof ReplaceStep && depthOf(step.slice.content) > 1);
    }
    const doc = docs.at(-1)!;
    // Limits refuse growth past them, never a change that keeps a page as large or shrinks it:
    // the first step that takes the page past a limit, larger than it was, is the one refused.
    const grows = (measure: (node: Node) => number, limit: number, message: string, code: CollabCode) => {
      const before = measure(this.doc);
      if (measure(doc) <= limit || measure(doc) <= before) return;
      const at = docs.findIndex((node, index) => index > 0 && measure(node) > limit && measure(node) > before);
      throw new CollabError(code, message, undefined, Math.max(0, at - 1));
    };
    const TOO_BIG = "This page is too large to grow further. Split it into more pages.";
    grows((node) => node.nodeSize, this.limits.docSize, TOO_BIG, "COLLAB_TOO_LARGE");
    if (nests) grows((node) => depthOf(node.content), this.limits.depth, "Blocks are nested too deeply.", "COLLAB_REJECTED");
    // JSON size is measured only when what was added could take the page past the limit.
    let measured: number | null = null;
    if (this.docBytes + this.grown + bytes > this.limits.docBytes) {
      const sizes = new Map<Node, number>();
      const measure = (node: Node) => sizes.get(node) ?? sizes.set(node, JSON.stringify(node.toJSON()).length).get(node)!;
      grows(measure, this.limits.docBytes, TOO_BIG, "COLLAB_TOO_LARGE");
      measured = measure(doc);
    }
    this.commit(parsed, clientID, doc, sizes);
    if (measured !== null) {
      this.docBytes = measured;
      this.grown = 0;
    } else this.grown += bytes;
    // The answer is the steps just taken, even when the log (by steps or bytes) cannot hold them
    // all: answered from the log, a large batch would read as "start over" after it was taken.
    return { epoch: this.epoch, from: version, version: this.version, steps: parsed.map((step) => step.toJSON()), clientIDs: parsed.map(() => clientID), saved: this.saved };
  }

  /** Why a step is refused before it is applied: a mention the store cannot index. */
  private refuse(step: Step, doc: Node): string | null {
    if (step instanceof ReplaceStep || step instanceof ReplaceAroundStep) {
      if (!mentionsValid(step.slice.content)) return "This change has a mention of an unknown kind.";
    }
    if (step instanceof AttrStep) {
      const node = step.pos >= 0 && step.pos < doc.content.size ? doc.nodeAt(step.pos) : null;
      if (node?.type.name === "mention" && !validMention({ ...node.attrs, [step.attr]: step.value })) return "This change has a mention of an unknown kind.";
    }
    return null;
  }

  private commit(steps: Step[], clientID: ClientID, doc: Node, sizes: number[] = steps.map((step) => JSON.stringify(step.toJSON()).length)): void {
    this.doc = doc;
    this.log.push(...steps);
    this.ids.push(...steps.map(() => clientID));
    this.sizes.push(...sizes);
    for (const size of sizes) this.logBytes += size;
    this.version += steps.length;
    let over = Math.max(0, this.log.length - this.limits.log);
    let kept = this.logBytes;
    for (let at = 0; at < over; at += 1) kept -= this.sizes[at]!;
    while (kept > this.limits.logBytes && over < this.log.length - 1) {
      kept -= this.sizes[over]!;
      over += 1;
    }
    if (over > 0) {
      this.log.splice(0, over);
      this.ids.splice(0, over);
      for (const size of this.sizes.splice(0, over)) this.logBytes -= size;
    }
  }

  /** The stored copy now holds the live document as it was at `version`. */
  persisted(revision: number, raw: unknown, doc: Node, version: number): void {
    this.known = { revision, raw, doc, version, exact: true };
    this.saved = Math.max(this.saved, version);
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
    if (applied.length) {
      this.commit(applied, SERVER_CLIENT, doc);
      this.docBytes = JSON.stringify(doc.toJSON()).length;
      this.grown = 0;
    }
    const exact = this.doc.eq(theirs);
    this.known = { revision, raw, doc: theirs, version: this.version, exact };
    // The stored copy already holds everything typed: it is saved as it is.
    if (exact) this.saved = this.version;
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
