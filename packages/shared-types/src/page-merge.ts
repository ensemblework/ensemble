/**
 * Three-way merge of two edits to one page (ProseMirror JSON): the version both started from
 * (`base`), one side's edit (`mine`) and the other's (`theirs`). The collab authority in hub-api
 * uses it when a write from elsewhere cannot be mapped through the steps typed meanwhile, and the
 * editor when it re-proposes unsent typing after the authority restarted or a session expired.
 *
 * Edits in different places all land. Text is compared word by word, then letter by letter
 * where both people changed the same words. Two people typing at the same spot both keep
 * their text (theirs first). Where both rewrote the same words, or one deleted a block the
 * other edited, nothing is dropped: both versions, or the edited one, stay.
 */
import type { PageDocument, PageNode } from "./domain.js";

type Mark = NonNullable<PageNode["marks"]>[number];

export type MergeResult = {
  doc: PageDocument;
  /** Places where both people rewrote the same thing and both versions were kept. */
  kept: number;
};

type Context = { deep: boolean; kept: number; union: boolean };

const EMPTYABLE = new Set(["attrs", "content", "marks"]);

function blank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "object" && Object.keys(value).length === 0;
}

const keys = new WeakMap<object, string>();

/**
 * JSON with sorted keys, and empty `attrs`, `content` and `marks` left out. The database and
 * the editor write the same node with keys in a different order.
 */
function canonical(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  const cached = keys.get(value);
  if (cached !== undefined) return cached;
  let text: string;
  if (Array.isArray(value)) text = `[${value.map(canonical).join(",")}]`;
  else {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key, item]) => item !== undefined && !(EMPTYABLE.has(key) && blank(item)))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    text = `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  keys.set(value, text);
  return text;
}

/** The same document, whatever order its keys were written in. */
export function sameDoc(a: PageDocument | PageNode, b: PageDocument | PageNode): boolean {
  return canonical(a) === canonical(b);
}

// ── Alignment ────────────────────────────────────────────────────────────────

/** Past this many cells, a changed stretch of two lists is treated as one change. */
const MAX_CELLS = 1_000_000;
/** Bigger stretches are first cut at items that occur once in each list (patience diff). */
const DIRECT_CELLS = 40_000;

type Score = (i: number, j: number) => number;

/** Best-scoring pairs within a[a0, a1) and b[b0, b1), written into `map`. */
function alignRange(map: number[], a0: number, a1: number, b0: number, b1: number, score: Score, full: number): void {
  while (a0 < a1 && b0 < b1 && score(a0, b0) >= full) {
    map[a0] = b0;
    a0 += 1;
    b0 += 1;
  }
  while (a1 > a0 && b1 > b0 && score(a1 - 1, b1 - 1) >= full) {
    a1 -= 1;
    b1 -= 1;
    map[a1] = b1;
  }
  const rows = a1 - a0;
  const cols = b1 - b0;
  if (!rows || !cols || rows * cols > MAX_CELLS) return;
  const width = cols + 1;
  const best = new Int32Array((rows + 1) * width);
  const scores = new Int8Array(rows * cols);
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      const value = score(a0 + i, b0 + j);
      scores[i * cols + j] = value;
      let top = Math.max(best[(i + 1) * width + j]!, best[i * width + j + 1]!);
      if (value > 0) top = Math.max(top, value + best[(i + 1) * width + j + 1]!);
      best[i * width + j] = top;
    }
  }
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    const value = scores[i * cols + j]!;
    const here = best[i * width + j]!;
    if (value > 0 && here === value + best[(i + 1) * width + j + 1]!) {
      map[a0 + i] = b0 + j;
      i += 1;
      j += 1;
    } else if (best[(i + 1) * width + j] === here) i += 1;
    else j += 1;
  }
}

/** Items whose key occurs once in each range, as the longest run of pairs in the same order. */
function anchors(a: string[], a0: number, a1: number, b: string[], b0: number, b1: number): Array<[number, number]> {
  const inA = new Map<string, number>();
  for (let i = a0; i < a1; i += 1) inA.set(a[i]!, inA.has(a[i]!) ? -1 : i);
  const inB = new Map<string, number>();
  for (let j = b0; j < b1; j += 1) inB.set(b[j]!, inB.has(b[j]!) ? -1 : j);
  const pairs: Array<[number, number]> = [];
  for (const [key, i] of inA) {
    const j = inB.get(key);
    if (i >= 0 && j !== undefined && j >= 0) pairs.push([i, j]);
  }
  pairs.sort((x, y) => x[0] - y[0]);
  const tails: number[] = [];
  const back = new Array<number>(pairs.length).fill(-1);
  pairs.forEach(([, j], index) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]!]![1] < j) lo = mid + 1;
      else hi = mid;
    }
    back[index] = lo > 0 ? tails[lo - 1]! : -1;
    tails[lo] = index;
  });
  const out: Array<[number, number]> = [];
  for (let at = tails.length ? tails[tails.length - 1]! : -1; at >= 0; at = back[at]!) out.push(pairs[at]!);
  return out.reverse();
}

/**
 * Pairs items of two lists in order, maximising the summed score (0 = never pair). `full` is
 * the score of identical items. `keysA`/`keysB` name items that are surely the same, for
 * cutting long lists into small stretches. Returns, for each item of the first list, the index
 * of its pair in the second, or -1.
 */
function align(n: number, m: number, score: Score, full: number, keysA: string[], keysB: string[]): number[] {
  const map = new Array<number>(n).fill(-1);
  if (n * m <= DIRECT_CELLS) {
    alignRange(map, 0, n, 0, m, score, full);
    return map;
  }
  let a0 = 0;
  let b0 = 0;
  for (const [i, j] of anchors(keysA, 0, n, keysB, 0, m)) {
    alignRange(map, a0, i, b0, j, score, full);
    map[i] = j;
    a0 = i + 1;
    b0 = j + 1;
  }
  alignRange(map, a0, n, b0, m, score, full);
  return map;
}

function alignByKey(a: string[], b: string[]): number[] {
  return align(a.length, b.length, (i, j) => (a[i] === b[j] ? 1 : 0), 1, a, b);
}

// ── Three-way merge of a list ────────────────────────────────────────────────

/** One side's change: base items [start, end) became `items`. An empty range is an insertion. */
type Hunk<T> = { start: number; end: number; items: T[]; side: "mine" | "theirs" };

function hunks<T>(base: T[], other: T[], map: number[], side: Hunk<T>["side"]): Array<Hunk<T>> {
  const out: Array<Hunk<T>> = [];
  let i = 0;
  let j = 0;
  for (;;) {
    let next = i;
    while (next < base.length && map[next]! < 0) next += 1;
    const to = next < base.length ? map[next]! : other.length;
    if (next > i || to > j) out.push({ start: i, end: next, items: other.slice(j, to), side });
    if (next >= base.length) return out;
    i = next + 1;
    j = to + 1;
  }
}

function applyHunks<T>(base: T[], start: number, end: number, list: Array<Hunk<T>>): T[] {
  const out: T[] = [];
  let at = start;
  for (const hunk of list) {
    out.push(...base.slice(at, hunk.start), ...hunk.items);
    at = hunk.end;
  }
  out.push(...base.slice(at, end));
  return out;
}

/**
 * diff3 over a list. Changes from one side apply as they are. Changes from both sides that
 * overlap (or insert at the same spot) go to `conflict`; returning null gives up on the merge.
 * Changes that only touch (an insertion right after a replaced range) do not conflict.
 */
function merge3<T>(base: T[], mine: T[], theirs: T[], keyOf: (item: T) => string, conflict: (base: T[], mine: T[], theirs: T[]) => T[] | null): T[] | null {
  const baseKeys = base.map(keyOf);
  const all = [
    ...hunks(base, mine, alignByKey(baseKeys, mine.map(keyOf)), "mine"),
    ...hunks(base, theirs, alignByKey(baseKeys, theirs.map(keyOf)), "theirs"),
  ].sort((a, b) => a.start - b.start || (a.end > a.start ? 1 : 0) - (b.end > b.start ? 1 : 0));
  const out: T[] = [];
  let at = 0;
  let index = 0;
  while (index < all.length) {
    const cluster = [all[index]!];
    let end = all[index]!.end;
    index += 1;
    while (index < all.length) {
      const next = all[index]!;
      const insertion = next.start === next.end;
      const joins = next.start < end || (insertion && cluster.some((hunk) => hunk.start === hunk.end && hunk.start === next.start));
      if (!joins) break;
      cluster.push(next);
      end = Math.max(end, next.end);
      index += 1;
    }
    const start = cluster[0]!.start;
    out.push(...base.slice(at, start));
    const mineSide = cluster.filter((hunk) => hunk.side === "mine");
    const theirsSide = cluster.filter((hunk) => hunk.side === "theirs");
    if (!theirsSide.length) out.push(...applyHunks(base, start, end, mineSide));
    else if (!mineSide.length) out.push(...applyHunks(base, start, end, theirsSide));
    else {
      const mineVersion = applyHunks(base, start, end, mineSide);
      const theirsVersion = applyHunks(base, start, end, theirsSide);
      if (mineVersion.map(keyOf).join("\u0001") === theirsVersion.map(keyOf).join("\u0001")) out.push(...mineVersion);
      else {
        const resolved = conflict(base.slice(start, end), mineVersion, theirsVersion);
        if (!resolved) return null;
        out.push(...resolved);
      }
    }
    at = end;
  }
  out.push(...base.slice(at));
  return out;
}

// ── Text ─────────────────────────────────────────────────────────────────────

/** A word, a run of spaces, one punctuation mark, one letter, or an inline node (a mention). */
type Unit = { key: string; text?: string; marks?: Mark[]; node?: PageNode };

const WORDS = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
const SPACE: Unit = { key: "t\u0000 ", text: " " };

function textUnit(text: string, marks: Mark[] | undefined, markKey: string): Unit {
  return { key: `t${markKey}\u0000${text}`, text, marks };
}

function toUnits(nodes: PageNode[], split: (text: string) => string[]): Unit[] {
  const out: Unit[] = [];
  for (const node of nodes) {
    if (node.type === "text" && typeof node.text === "string") {
      const marks = node.marks?.length ? node.marks : undefined;
      const markKey = marks ? canonical(marks) : "";
      for (const piece of split(node.text)) out.push(textUnit(piece, marks, markKey));
    } else out.push({ key: `n${canonical(node)}`, node });
  }
  return out;
}

const words = (text: string) => text.match(WORDS) ?? [];
const letters = (text: string) => Array.from(text);

function toLetters(list: Unit[]): Unit[] {
  const out: Unit[] = [];
  for (const unit of list) {
    if (unit.text === undefined) out.push(unit);
    else {
      const markKey = unit.marks ? canonical(unit.marks) : "";
      for (const letter of letters(unit.text)) out.push(textUnit(letter, unit.marks, markKey));
    }
  }
  return out;
}

function toNodes(list: Unit[]): PageNode[] {
  const out: PageNode[] = [];
  let run: { text: string; marks?: Mark[]; key: string } | null = null;
  const close = () => {
    if (run?.text) out.push(run.marks ? { type: "text", marks: run.marks, text: run.text } : { type: "text", text: run.text });
    run = null;
  };
  for (const unit of list) {
    if (unit.text === undefined) {
      close();
      if (unit.node) out.push(unit.node);
      continue;
    }
    const markKey = unit.marks ? canonical(unit.marks) : "";
    if (run && run.key === markKey) run.text += unit.text;
    else {
      close();
      run = { text: unit.text, marks: unit.marks, key: markKey };
    }
  }
  close();
  return out;
}

const unitKey = (unit: Unit) => unit.key;
const endsInSpace = (list: Unit[]) => list.length > 0 && /\s$/.test(list[list.length - 1]!.text ?? "");
const startsInSpace = (list: Unit[]) => list.length > 0 && /^\s/.test(list[0]!.text ?? "");

/** Both people's text, theirs first, with a space between when neither side has one. */
function both(theirs: Unit[], mine: Unit[]): Unit[] {
  if (!theirs.length) return mine;
  if (!mine.length) return theirs;
  return endsInSpace(theirs) || startsInSpace(mine) ? [...theirs, ...mine] : [...theirs, SPACE, ...mine];
}

const oneWord = (list: Unit[]) => list.length === 1 && /[\p{L}\p{N}_]/u.test(list[0]!.text ?? "");

const isSpace = (unit: Unit | undefined) => unit?.text !== undefined && /^\s+$/.test(unit.text);
const isWord = (unit: Unit) => unit.text === undefined || /[\p{L}\p{N}_]/u.test(unit.text);

/**
 * Words with the punctuation right after them and the spaces after that ("Hello, "), so a union
 * never glues one person's word to another's. A group is named by its words alone: "Hello, "
 * and "Hello " are the same word, one with a comma typed after it.
 */
function wordGroups(list: Unit[]): Array<{ units: Unit[]; key: string }> {
  const groups: Unit[][] = [];
  for (const unit of list) {
    const last = groups[groups.length - 1];
    const trailing = isSpace(unit) || (!isWord(unit) && last !== undefined && !isSpace(last[last.length - 1]));
    if (last && trailing) last.push(unit);
    else groups.push([unit]);
  }
  return groups.map((units) => {
    const words = units.filter(isWord);
    const marks = units.filter((unit) => !isSpace(unit));
    return { units, key: (words.length ? words : marks.length ? marks : units).map(unitKey).join("\u0001") };
  });
}

/** Which item of the second list each item of the first is, or -1: base to mine, base to theirs, mine to theirs. */
type Pairs = { baseToMine: number[]; baseToTheirs: number[]; mineToTheirs: number[] };

/**
 * `mine` proposed again onto `theirs`, both edits of `base`, where `theirs` may already hold some
 * of `mine` (typing re-proposed after the server started over). Items are paired by `pairs`.
 * What mine added that theirs lacks is added, before the next item both have (theirs first);
 * what mine deleted and theirs left unchanged goes; what theirs deleted stays deleted unless
 * mine changed it (`same`: unchanged); an item both have is kept once (`both` merges its two
 * versions).
 */
function unionMerge<T>(
  base: T[],
  mine: T[],
  theirs: T[],
  { baseToMine, baseToTheirs, mineToTheirs }: Pairs,
  same: (a: T, b: T) => boolean,
  both: (base: T | null, mine: T, theirs: T) => T[],
): Array<{ item: T; mine: boolean }> {
  const invert = (map: number[], length: number) => {
    const out = new Array<number>(length).fill(-1);
    map.forEach((to, from) => {
      if (to >= 0) out[to] = from;
    });
    return out;
  };
  const mineBase = invert(baseToMine, mine.length);
  const theirsBase = invert(baseToTheirs, theirs.length);
  const theirsMine = invert(mineToTheirs, theirs.length);
  const before: T[][] = Array.from({ length: theirs.length + 1 }, () => []);
  let pending: T[] = [];
  mine.forEach((item, j) => {
    const k = mineToTheirs[j]!;
    if (k >= 0) {
      before[k]!.push(...pending);
      pending = [];
      return;
    }
    const i = mineBase[j]!;
    // From the base and not in theirs: theirs deleted it, which stands unless mine changed it.
    if (i >= 0 && (baseToTheirs[i]! >= 0 || same(base[i]!, item))) return;
    pending.push(item);
  });
  before[theirs.length]!.push(...pending);
  const out: Array<{ item: T; mine: boolean }> = [];
  theirs.forEach((item, k) => {
    for (const added of before[k]!) out.push({ item: added, mine: true });
    const j = theirsMine[k]!;
    const i = theirsBase[k]!;
    if (j < 0) {
      // Mine deleted it and theirs left it as it was: it goes.
      if (!(i >= 0 && baseToMine[i]! < 0 && same(base[i]!, item))) out.push({ item, mine: false });
      return;
    }
    const from = mineBase[j]! >= 0 ? base[mineBase[j]!]! : i >= 0 ? base[i]! : null;
    for (const merged of both(from, mine[j]!, item)) out.push({ item: merged, mine: false });
  });
  for (const added of before[theirs.length]!) out.push({ item: added, mine: true });
  return out;
}

/**
 * Mine to theirs for union: items both kept from the base are paired through it; between two
 * such anchors, items new on both sides are paired only as `pairNew` says (identical ones), never
 * by a word or two they happen to share, so nothing is interleaved.
 */
function throughBase(baseToMine: number[], baseToTheirs: number[], mineLength: number, theirsLength: number, pairNew: (mineNew: number[], theirsNew: number[]) => Array<[number, number]>): number[] {
  const mineToTheirs = new Array<number>(mineLength).fill(-1);
  const fromBase = (map: number[], length: number) => {
    const out = new Array<boolean>(length).fill(false);
    for (const to of map) if (to >= 0) out[to] = true;
    return out;
  };
  const [mineOld, theirsOld] = [fromBase(baseToMine, mineLength), fromBase(baseToTheirs, theirsLength)];
  const anchors: Array<[number, number]> = [];
  baseToMine.forEach((j, i) => {
    const k = baseToTheirs[i]!;
    if (j >= 0 && k >= 0) {
      mineToTheirs[j] = k;
      anchors.push([j, k]);
    }
  });
  let [fromJ, fromK] = [0, 0];
  for (const [j, k] of [...anchors, [mineLength, theirsLength] as [number, number]]) {
    const mineNew: number[] = [];
    const theirsNew: number[] = [];
    for (let at = fromJ; at < j; at += 1) if (!mineOld[at]) mineNew.push(at);
    for (let at = fromK; at < k; at += 1) if (!theirsOld[at]) theirsNew.push(at);
    if (mineNew.length && theirsNew.length) for (const [mj, tk] of pairNew(mineNew, theirsNew)) mineToTheirs[mj] = tk;
    [fromJ, fromK] = [j + 1, k + 1];
  }
  return mineToTheirs;
}

/** Runs of consecutive indices. */
function runs(indices: number[]): number[][] {
  const out: number[][] = [];
  for (const index of indices) {
    const last = out[out.length - 1];
    if (last && last[last.length - 1] === index - 1) last.push(index);
    else out.push([index]);
  }
  return out;
}

const groupText = (group: Unit[]) => group.map((unit) => (unit.text === undefined ? "x" : unit.text)).join("");

/**
 * Union of a paragraph's text, word by word. Words typed on both sides at the same place are
 * one only when the whole run of them is the same ("Hello world" both times, a comma aside);
 * otherwise both runs stay whole, theirs first. A word followed by another person's word gets
 * a space between them, so "there" and "world" never come out as "thereworld".
 */
function unionText(base: Unit[], mine: Unit[], theirs: Unit[]): Unit[] {
  const [b, m, t] = [base, mine, theirs].map(wordGroups);
  const pair = (x: typeof b, y: typeof b) => alignByKey(x!.map((group) => group.key), y!.map((group) => group.key));
  const [baseToMine, baseToTheirs] = [pair(b, m), pair(b, t)];
  const sameRun = (x: number[], y: number[]) => x.length === y.length && x.every((j, at) => m![j]!.key === t![y[at]!]!.key);
  const mineToTheirs = throughBase(baseToMine, baseToTheirs, m!.length, t!.length, (mineNew, theirsNew) => {
    const out: Array<[number, number]> = [];
    const theirsRuns = runs(theirsNew);
    let next = 0;
    for (const run of runs(mineNew)) {
      const found = theirsRuns.findIndex((other, at) => at >= next && sameRun(run, other));
      if (found < 0) continue;
      run.forEach((j, at) => out.push([j, theirsRuns[found]![at]!]));
      next = found + 1;
    }
    return out;
  });
  const pairs = { baseToMine, baseToTheirs, mineToTheirs };
  const full = (group: { units: Unit[] }) => group.units.map(unitKey).join("\u0001");
  // One word both have: mine's version (a comma typed after it) where theirs left it as it was.
  const both = (from: (typeof b)[number] | null, mineGroup: (typeof b)[number], theirsGroup: (typeof b)[number]) => [from && full(from) === full(theirsGroup) ? mineGroup : theirsGroup];
  const merged = unionMerge(b!, m!, t!, pairs, (x, y) => x.key === y.key, both);
  const out: Unit[] = [];
  merged.forEach(({ item, mine: fromMine }, at) => {
    const previous = merged[at - 1];
    if (previous && previous.mine !== fromMine && /[\p{L}\p{N}_.,;:!?)\]}]$/u.test(groupText(previous.item.units)) && /^[\p{L}\p{N}_]/u.test(groupText(item.units))) out.push(SPACE);
    out.push(...item.units);
  });
  return out;
}

function textConflict(base: Unit[], mine: Unit[], theirs: Unit[], context: Context): Unit[] {
  if (!base.length) return both(theirs, mine);
  // Both changed one word: merge its letters when they changed different ones ("recieve" made
  // "receive" and "recieved"). Anything bigger, merged letter by letter, comes out mangled.
  if (oneWord(base) && oneWord(mine) && oneWord(theirs)) {
    const fine = merge3(toLetters(base), toLetters(mine), toLetters(theirs), unitKey, () => null);
    if (fine) return fine;
  }
  context.kept += 1;
  return both(theirs, mine);
}

function mergeText(base: PageNode[], mine: PageNode[], theirs: PageNode[], context: Context): PageNode[] {
  if (context.union) return toNodes(unionText(toUnits(base, words), toUnits(mine, words), toUnits(theirs, words)));
  const merged = merge3(toUnits(base, words), toUnits(mine, words), toUnits(theirs, words), unitKey, (b, m, t) => textConflict(b, m, t, context))!;
  return toNodes(merged);
}

// ── Blocks ───────────────────────────────────────────────────────────────────

const INLINE = new Set(["text", "hardBreak", "mention"]);
const holdsText = (nodes: PageNode[]) => nodes.some((node) => INLINE.has(node.type));

function textOf(node: PageNode): string {
  if (typeof node.text === "string") return node.text;
  return (node.content ?? []).map(textOf).join(node.content?.some((child) => child.content) ? "\n" : "");
}

/**
 * How likely two blocks are one block before and after an edit: 12 identical, 2 to 11 the same
 * kind of block with more or less of its text unchanged at both ends, 1 the same kind with no
 * text to compare, 0 a different kind.
 */
function likeness(a: PageNode, b: PageNode): number {
  if (canonical(a) === canonical(b)) return 12;
  if (a.type !== b.type) return 0;
  const x = textOf(a);
  const y = textOf(b);
  if (!x || !y) return 1;
  const shorter = Math.min(x.length, y.length);
  let prefix = 0;
  while (prefix < shorter && x[prefix] === y[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < shorter - prefix && x[x.length - 1 - suffix] === y[y.length - 1 - suffix]) suffix += 1;
  return 1 + Math.floor((10 * (prefix + suffix)) / Math.max(x.length, y.length));
}

function mergeRecord(base?: Record<string, unknown>, mine?: Record<string, unknown>, theirs?: Record<string, unknown>): Record<string, unknown> | undefined {
  const names = new Set([...Object.keys(base ?? {}), ...Object.keys(mine ?? {}), ...Object.keys(theirs ?? {})]);
  if (!names.size) return undefined;
  const out: Record<string, unknown> = {};
  for (const name of names) {
    const value = canonical(mine?.[name]) === canonical(base?.[name]) ? theirs?.[name] : mine?.[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

function mergeNode(base: PageNode, mine: PageNode, theirs: PageNode, context: Context): PageNode[] {
  const b = canonical(base);
  const m = canonical(mine);
  const t = canonical(theirs);
  if (m === b || m === t) return [theirs];
  if (t === b) return [mine];
  if (!context.deep || mine.type !== theirs.type || typeof mine.text === "string") {
    context.kept += 1;
    return [theirs, mine];
  }
  const node: PageNode = { type: mine.type };
  const attrs = mergeRecord(base.attrs, mine.attrs, theirs.attrs);
  if (attrs && Object.keys(attrs).length) node.attrs = attrs;
  const [bc, mc, tc] = [base.content ?? [], mine.content ?? [], theirs.content ?? []];
  if (bc.length || mc.length || tc.length) {
    const content = holdsText(bc) || holdsText(mc) || holdsText(tc) ? mergeText(bc, mc, tc, context) : mergeBlocks(bc, mc, tc, context);
    if (content.length) node.content = content;
  }
  const marks = canonical(mine.marks) === canonical(base.marks) ? theirs.marks : mine.marks;
  if (marks?.length) node.marks = marks;
  return [node];
}

/** Names a block by its kind and text, for lining up blocks whose details differ. */
const gist = (node: PageNode) => `${node.type}\u0000${textOf(node)}`;

/**
 * Both sides changed the same run of blocks. Pairs up the blocks that are still the same block
 * (merged inside); of the rest, a block one side deleted and the other edited stays edited,
 * and blocks both rewrote are all kept, theirs first.
 */
function blockConflict(base: PageNode[], mine: PageNode[], theirs: PageNode[], context: Context): PageNode[] {
  const [baseGist, mineGist, theirsGist] = [base.map(gist), mine.map(gist), theirs.map(gist)];
  const toMine = align(base.length, mine.length, (i, j) => likeness(base[i]!, mine[j]!), 12, baseGist, mineGist);
  const toTheirs = align(base.length, theirs.length, (i, j) => likeness(base[i]!, theirs[j]!), 12, baseGist, theirsGist);
  const out: PageNode[] = [];
  let i = 0;
  let j = 0;
  let k = 0;
  for (;;) {
    if (i < base.length && toMine[i] === j && toTheirs[i] === k) {
      out.push(...mergeNode(base[i]!, mine[j]!, theirs[k]!, context));
      i += 1;
      j += 1;
      k += 1;
      continue;
    }
    let next = i;
    while (next < base.length && (toMine[next]! < 0 || toTheirs[next]! < 0)) next += 1;
    const toJ = next < base.length ? toMine[next]! : mine.length;
    const toK = next < base.length ? toTheirs[next]! : theirs.length;
    if (next === i && toJ === j && toK === k) break;
    const [b, m, t] = [base.slice(i, next), mine.slice(j, toJ), theirs.slice(k, toK)];
    const [bk, mk, tk] = [b, m, t].map((list) => list.map(canonical).join("\u0001"));
    if (mk === bk || mk === tk) out.push(...t);
    else if (tk === bk) out.push(...m);
    else {
      // A block stays when it is new, or when the other side kept it too.
      const [inBase, inMine, inTheirs] = [b, m, t].map((list) => new Set(list.map(canonical)));
      const theirsPart = t.filter((node) => !inBase!.has(canonical(node)) || inMine!.has(canonical(node)));
      const seen = new Set(theirsPart.map(canonical));
      const minePart = m.filter((node) => !seen.has(canonical(node)) && (!inBase!.has(canonical(node)) || inTheirs!.has(canonical(node))));
      if (b.length && [...theirsPart, ...minePart].some((node) => !inBase!.has(canonical(node)))) context.kept += 1;
      out.push(...theirsPart, ...minePart);
    }
    i = next;
    j = toJ;
    k = toK;
  }
  return out;
}

/** A block's words (letters and numbers), counted, for pairing it with its edited self. */
function wordCounts(node: PageNode): Map<string, number> {
  const counts = new Map<string, number>();
  for (const word of textOf(node).match(/[\p{L}\p{N}_]+/gu) ?? []) counts.set(word, (counts.get(word) ?? 0) + 1);
  return counts;
}

/**
 * How surely `edited` is the base block `base` after an edit, for union: 12 identical; 2 to 11
 * the same kind keeping at least half of the base block's words (wherever they are: both sides
 * may have typed at either end; an empty block counts as kept), more for more alike; 0 else.
 */
function kinship(base: PageNode, edited: PageNode, wa: Map<string, number>, wb: Map<string, number>): number {
  if (canonical(base) === canonical(edited)) return 12;
  if (base.type !== edited.type) return 0;
  let total = 0;
  let other = 0;
  let shared = 0;
  for (const count of wa.values()) total += count;
  for (const [word, count] of wb) {
    other += count;
    shared += Math.min(count, wa.get(word) ?? 0);
  }
  if (!total) return 2;
  return shared / total >= 0.5 ? 2 + Math.floor((9 * shared) / Math.max(total, other)) : 0;
}

/**
 * Union of a run of blocks. A block mine and theirs both have from the base (as it was, or
 * edited: sharing enough of its words) is paired through it, and merged inside when both
 * changed it. Blocks new on both sides are one only when identical; otherwise both stay,
 * theirs first.
 */
function unionBlocks(base: PageNode[], mine: PageNode[], theirs: PageNode[], context: Context): PageNode[] {
  const words = (list: PageNode[]) => list.map(wordCounts);
  const [wb, wm, wt] = [words(base), words(mine), words(theirs)];
  const pair = (a: PageNode[], wa: Array<Map<string, number>>, a0: number, a1: number, b: PageNode[], wbb: Array<Map<string, number>>, b0: number, b1: number) =>
    align(a1 - a0, b1 - b0, (i, j) => kinship(a[a0 + i]!, b[b0 + j]!, wa[a0 + i]!, wbb[b0 + j]!), 12, a.slice(a0, a1).map(gist), b.slice(b0, b1).map(gist));
  const baseToMine = pair(base, wb, 0, base.length, mine, wm, 0, mine.length);
  const baseToTheirs = pair(base, wb, 0, base.length, theirs, wt, 0, theirs.length);
  const mineToTheirs = throughBase(baseToMine, baseToTheirs, mine.length, theirs.length, (mineNew, theirsNew) => {
    const map = alignByKey(
      mineNew.map((j) => canonical(mine[j])),
      theirsNew.map((k) => canonical(theirs[k])),
    );
    return mineNew.flatMap((j, at) => (map[at]! >= 0 ? [[j, theirsNew[map[at]!]!] as [number, number]] : []));
  });
  const same = (a: PageNode, b: PageNode) => canonical(a) === canonical(b);
  const both = (from: PageNode | null, mineNode: PageNode, theirsNode: PageNode) => mergeNode(from ?? { type: mineNode.type }, mineNode, theirsNode, context);
  return unionMerge(base, mine, theirs, { baseToMine, baseToTheirs, mineToTheirs }, same, both).map(({ item }) => item);
}

function mergeBlocks(base: PageNode[], mine: PageNode[], theirs: PageNode[], context: Context): PageNode[] {
  if (context.union) return unionBlocks(base, mine, theirs, context);
  return merge3(base, mine, theirs, canonical, (b, m, t) => blockConflict(b, m, t, context))!;
}

/**
 * Merges `mine` and `theirs`, both edited from `base`. `deep: false` never merges inside a
 * block: a block both changed is kept twice, theirs then mine. Use it when the deep result does
 * not fit the editor's schema (for example two summaries in one toggle). `union`: for when
 * `theirs` may already hold some of `mine` (typing re-proposed after the server started over):
 * words and blocks mine added are added only where theirs lacks them, what mine deleted goes,
 * and what theirs deleted stays deleted (see `unionMerge`).
 */
export function mergeDocs(base: PageDocument, mine: PageDocument, theirs: PageDocument, options: { deep?: boolean; union?: boolean } = {}): MergeResult {
  const context: Context = { deep: options.deep ?? true, kept: 0, union: options.union ?? false };
  const content = mergeBlocks(base.content ?? [], mine.content ?? [], theirs.content ?? [], context);
  return { doc: { type: "doc", content: content.length ? content : [{ type: "paragraph" }] }, kept: context.kept };
}
