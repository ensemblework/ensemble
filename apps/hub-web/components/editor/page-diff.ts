import { Fragment, Mark, Slice, type Node } from "@tiptap/pm/model";
import { AttrStep, Mapping, ReplaceStep, Transform, type Step } from "@tiptap/pm/transform";
// The same file is apps/hub-api/src/pages/page-diff.ts with the imports from prosemirror-*;
// components/editor/page-diff.test.ts fails when the two differ below this line.
// ---

/**
 * Differences between two versions of a page as ProseMirror steps, and moving one person's
 * changes onto another version. Small steps (a word typed, a paragraph split) map over
 * concurrent edits without touching them; one step replacing a whole stretch would overwrite
 * whatever someone typed inside it.
 */

/** Past this many cells, a changed stretch is replaced as one piece instead of compared. */
const MAX_CELLS = 250_000;

type Hunk = [aFrom: number, aTo: number, bFrom: number, bTo: number];

/** Changed stretches between two lists, by longest common subsequence after the common ends. */
function hunks(a: readonly string[], b: readonly string[]): Hunk[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  if (start === endA && start === endB) return [];
  const n = endA - start;
  const m = endB - start;
  if (!n || !m || n * m > MAX_CELLS) return [[start, endA, start, endB]];
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[start + i] === b[start + j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const out: Hunk[] = [];
  let i = 0;
  let j = 0;
  let openA = -1;
  let openB = -1;
  const close = () => {
    if (openA < 0) return;
    out.push([start + openA, start + i, start + openB, start + j]);
    openA = -1;
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) {
      close();
      i += 1;
      j += 1;
      continue;
    }
    if (openA < 0) {
      openA = i;
      openB = j;
    }
    if (j < m && (i >= n || table[i * width + j + 1]! >= table[(i + 1) * width + j]!)) j += 1;
    else i += 1;
  }
  close();
  return out;
}

const WORDS = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

/**
 * Inline content as words, runs of spaces, single other characters and inline leaves, each with
 * its marks, and where each starts. Comparing words keeps a typed word whole: compared letter by
 * letter, "b20" against "b2" would come out as "b2" plus an inserted "0".
 */
function inlineUnits(node: Node): { keys: string[]; text: string[]; offsets: number[] } {
  const keys: string[] = [];
  const text: string[] = [];
  const offsets: number[] = [0];
  node.forEach((child) => {
    const marks = child.marks.length ? JSON.stringify(child.marks.map((mark) => mark.toJSON())) : "";
    if (child.isText) {
      for (const word of (child.text ?? "").match(WORDS) ?? []) {
        keys.push(`${marks}\u0000${word}`);
        text.push(word);
        offsets.push(offsets.at(-1)! + word.length);
      }
    } else if (child.nodeSize === 1) {
      keys.push(`${marks}\u0001${JSON.stringify(child.toJSON())}`);
      text.push("");
      offsets.push(offsets.at(-1)! + 1);
    } else throw new RangeError("inline node with content");
  });
  return { keys, text, offsets };
}

/** One word changed into another with the same marks: the letters that changed. */
function letterHunks(a: string, b: string): Hunk[] {
  return hunks(a.split(""), b.split(""));
}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

function replaceNodes(tr: Transform, from: number, to: number, nodes: Node[]): void {
  tr.step(new ReplaceStep(from, to, new Slice(Fragment.from(nodes), 0, 0)));
}

/** `a` (at `pos` in the original document) becomes `b`. Works from the end so earlier positions hold. */
function diffNode(tr: Transform, a: Node, b: Node, pos: number): void {
  if (a === b || a.eq(b)) return;
  if (a.type !== b.type || !Mark.sameSet(a.marks, b.marks) || a.isLeaf || b.isLeaf) {
    replaceNodes(tr, pos, pos + a.nodeSize, [b]);
    return;
  }
  diffContent(tr, a, b, pos + 1);
  for (const name of new Set([...Object.keys(a.attrs), ...Object.keys(b.attrs)])) {
    if (!same(a.attrs[name], b.attrs[name])) tr.step(new AttrStep(pos, name, b.attrs[name]));
  }
}

/** Pairs blocks of two changed stretches that are likely the same block, in order. */
function pairBlocks(a: Node[], b: Node[]): Array<[number, number]> {
  if (a.length * b.length > 10_000) return [];
  const score = (x: Node, y: Node) => {
    if (x.type !== y.type) return 0;
    const left = x.textContent;
    const right = y.textContent;
    let prefix = 0;
    const shorter = Math.min(left.length, right.length);
    while (prefix < shorter && left[prefix] === right[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < shorter - prefix && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix += 1;
    return 1 + Math.floor((10 * (prefix + suffix)) / Math.max(1, left.length, right.length));
  };
  const width = b.length + 1;
  const best = new Int32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const value = score(a[i]!, b[j]!);
      best[i * width + j] = Math.max(best[(i + 1) * width + j]!, best[i * width + j + 1]!, value ? value + best[(i + 1) * width + j + 1]! : 0);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const value = score(a[i]!, b[j]!);
    if (value && best[i * width + j] === value + best[(i + 1) * width + j + 1]!) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (best[(i + 1) * width + j] === best[i * width + j]) i += 1;
    else j += 1;
  }
  return pairs;
}

/** The content of `a` (starting at `start` in the original document) becomes that of `b`. */
function diffContent(tr: Transform, a: Node, b: Node, start: number): void {
  if (a.inlineContent) {
    const left = inlineUnits(a);
    const right = inlineUnits(b);
    for (const [aFrom, aTo, bFrom, bTo] of hunks(left.keys, right.keys).reverse()) {
      const posA = left.offsets[aFrom]!;
      const posB = right.offsets[bFrom]!;
      const sameMarks = aTo - aFrom === 1 && bTo - bFrom === 1 && left.keys[aFrom]!.split("\u0000")[0] === right.keys[bFrom]!.split("\u0000")[0];
      const pieces: Hunk[] = sameMarks && left.text[aFrom] && right.text[bFrom] ? letterHunks(left.text[aFrom]!, right.text[bFrom]!) : [[0, left.offsets[aTo]! - posA, 0, right.offsets[bTo]! - posB]];
      for (const [from, to, cutFrom, cutTo] of pieces.reverse()) {
        tr.step(new ReplaceStep(start + posA + from, start + posA + to, new Slice(b.content.cut(posB + cutFrom, posB + cutTo), 0, 0)));
      }
    }
    return;
  }
  const left: Node[] = [];
  const right: Node[] = [];
  a.forEach((child) => left.push(child));
  b.forEach((child) => right.push(child));
  const offsets: number[] = [start];
  for (const child of left) offsets.push(offsets.at(-1)! + child.nodeSize);
  const keys = (list: Node[]) => list.map((child) => JSON.stringify(child.toJSON()));
  for (const [aFrom, aTo, bFrom, bTo] of hunks(keys(left), keys(right)).reverse()) {
    const pairs = pairBlocks(left.slice(aFrom, aTo), right.slice(bFrom, bTo));
    // Between and around the pairs, blocks are replaced outright; paired blocks are compared inside.
    let nextA = aTo;
    let nextB = bTo;
    for (const [pi, pj] of [...pairs].reverse()) {
      const i = aFrom + pi;
      const j = bFrom + pj;
      if (i + 1 < nextA || j + 1 < nextB) replaceNodes(tr, offsets[i + 1]!, offsets[nextA]!, right.slice(j + 1, nextB));
      diffNode(tr, left[i]!, right[j]!, offsets[i]!);
      nextA = i;
      nextB = j;
    }
    if (aFrom < nextA || bFrom < nextB) replaceNodes(tr, offsets[aFrom]!, offsets[nextA]!, right.slice(bFrom, nextB));
  }
}

/** Steps that turn `from` into `to`, each as small as it can be. Empty when they are the same. */
export function diffSteps(from: Node, to: Node): Step[] {
  if (from.eq(to)) return [];
  const tr = new Transform(from);
  try {
    diffContent(tr, from, to, 0);
    if (tr.doc.eq(to)) return tr.steps;
  } catch {
    // A change the small steps cannot express on the way; replace the changed stretch instead.
  }
  const start = from.content.findDiffStart(to.content) ?? 0;
  const end = from.content.findDiffEnd(to.content) ?? { a: from.content.size, b: to.content.size };
  const overlap = Math.max(0, start - Math.min(end.a, end.b));
  const step = new ReplaceStep(start, end.a + overlap, to.slice(start, end.b + overlap));
  if (step.apply(from).doc?.eq(to)) return [step];
  return [new ReplaceStep(0, from.content.size, to.slice(0, to.content.size))];
}

/** A moved step that would now delete more than it did: it would take text typed meanwhile with it. */
function swallows(step: Step, mapped: Step): boolean {
  return step instanceof ReplaceStep && mapped instanceof ReplaceStep && mapped.to - mapped.from > step.to - step.from;
}

/**
 * `steps` were made on `base`; `over` too, and they come first. Returns `steps` moved to apply
 * after `over`, or null when one of them no longer fits or would delete what `over` added.
 */
export function rebaseSteps(base: Node, steps: Step[], over: Step[]): Step[] | null {
  try {
    const docs: Node[] = [];
    let doc = base;
    for (const step of steps) {
      docs.push(doc);
      doc = step.apply(doc).doc!;
    }
    // Back to `base` (inverting `steps`), forward over `over`, then each step mapped through
    // that, its inverse mirrored so text it inserted keeps its place.
    const mapping = new Mapping();
    const advance = (step: Step) => {
      const result = step.apply(doc);
      if (!result.doc) throw new RangeError(result.failed ?? "step does not apply");
      doc = result.doc;
    };
    for (let at = steps.length - 1; at >= 0; at -= 1) {
      const inverse = steps[at]!.invert(docs[at]!);
      advance(inverse);
      mapping.appendMap(inverse.getMap());
    }
    for (const step of over) {
      advance(step);
      mapping.appendMap(step.getMap());
    }
    const result: Step[] = [];
    for (let at = 0, mapFrom = steps.length; at < steps.length; at += 1) {
      const mapped = steps[at]!.map(mapping.slice(mapFrom));
      mapFrom -= 1;
      if (!mapped || swallows(steps[at]!, mapped)) return null;
      advance(mapped);
      mapping.appendMap(mapped.getMap(), mapFrom);
      result.push(mapped);
    }
    return result;
  } catch {
    return null;
  }
}

/**
 * `mine` and `theirs` were both edited from `base`. Returns the steps that put mine's changes
 * onto `theirs`, or null when some of them cannot be placed (the caller then merges).
 */
export function changesOnto(base: Node, mine: Node, theirs: Node): Step[] | null {
  return rebaseSteps(base, diffSteps(base, mine), diffSteps(base, theirs));
}
