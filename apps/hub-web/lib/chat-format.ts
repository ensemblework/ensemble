/**
 * Lists and inline formatting in a chat box, which stays a plain textarea (caret, selection, undo, IME and
 * spelling stay the browser's). Typing "- " or "* " at the start of a line starts a bulleted list (shown
 * as • ◦ ▪ by depth) and "1. " or "1) " a numbered one. In a list, Enter adds the next item, Enter on an
 * empty item leaves the list (or moves it out a level), Shift+Enter breaks the line inside the item,
 * Tab and Shift+Tab nest it and Backspace right after a marker takes the marker away. Numbers follow
 * every change. Ctrl/Cmd+B, I, E and Shift+X wrap the selection in Markdown. `toMarkdown` turns the
 * bullets back into "- " for sending. Nothing inside a ``` fence is touched.
 *
 * The same file is in Ensemble (apps/hub-web/lib/chat-format.ts) and Ensemble Node
 * (apps/node-web/lib/chat-format.ts); keep them alike.
 */

export type Edit = { value: string; start: number; end: number };

type Pos = { line: number; col: number };
type Item = { indent: number; marker: string; bullet: boolean; number: number; delim: string; gap: number; task: string; content: number };

// Written as escapes so the file reads the same however a browser decodes it.
export const BULLETS = ["\u2022", "\u25E6", "\u25AA"] as const;
const GLYPHS = new Set<string>(BULLETS);
const ITEM = /^( *)(?:([-*+\u2022\u25E6\u25AA])|(\d{1,9})([.)]))( {1,4})(\[[ xX]\] )?/;
const FENCE = /^ *(`{3,}|~{3,})/;

const indentOf = (line: string) => line.length - line.trimStart().length;

function parse(line: string): Item | null {
  const match = ITEM.exec(line);
  if (!match) return null;
  const indent = match[1]!.length;
  const marker = match[2] ?? `${match[3]}${match[4]}`;
  const gap = match[5]!.length;
  const task = match[6] ?? "";
  return { indent, marker, bullet: Boolean(match[2]), number: match[3] ? Number(match[3]) : 0, delim: match[4] ?? "", gap, task, content: indent + marker.length + gap + task.length };
}

/** Which lines are inside (or open or close) a code fence. */
function fences(lines: string[]): boolean[] {
  let open: string | null = null;
  return lines.map((line) => {
    const match = FENCE.exec(line);
    if (match) {
      if (!open) open = match[1]![0]!;
      else if (match[1]![0] === open) open = null;
      return true;
    }
    return open !== null;
  });
}

type Doc = { lines: string[]; fenced: boolean[]; items: Array<Item | null> };

function doc(lines: string[]): Doc {
  const fenced = fences(lines);
  return { lines, fenced, items: lines.map((line, index) => (fenced[index] ? null : parse(line))) };
}

function position(lines: string[], offset: number): Pos {
  let rest = Math.max(0, offset);
  for (let line = 0; line < lines.length; line += 1) {
    const length = lines[line]!.length;
    if (rest <= length) return { line, col: rest };
    rest -= length + 1;
  }
  const last = lines.length - 1;
  return { line: last, col: lines[last]!.length };
}

function offset(lines: string[], pos: Pos): number {
  let total = 0;
  for (let line = 0; line < pos.line; line += 1) total += lines[line]!.length + 1;
  return total + Math.min(pos.col, lines[pos.line]?.length ?? 0);
}

/** Numbers each run of numbered items at one level from its first number; bullets get the glyph of their depth. */
function tidy(lines: string[]): string[] {
  const { items } = doc(lines);
  const out = [...lines];
  let open: Array<{ indent: number; content: number; bullet: boolean; delim: string; next: number }> = [];
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    const item = items[index];
    if (!item) {
      // Text that is not indented under an item ends the lists it is not part of.
      const indent = indentOf(line);
      open = open.filter((row) => row.content <= indent);
      return;
    }
    open = open.filter((row) => row.indent <= item.indent);
    const top = open[open.length - 1];
    const sibling = top && top.indent === item.indent && top.bullet === item.bullet && top.delim === item.delim ? top : null;
    if (top && top.indent === item.indent && !sibling) open.pop();
    const depth = open.filter((row) => row.indent < item.indent).length;
    let text = line;
    if (item.bullet && GLYPHS.has(item.marker)) text = `${line.slice(0, item.indent)}${BULLETS[depth % BULLETS.length]}${line.slice(item.indent + 1)}`;
    if (!item.bullet && sibling && item.number !== sibling.next) text = `${line.slice(0, item.indent)}${sibling.next}${item.delim}${line.slice(item.indent + item.marker.length)}`;
    out[index] = text;
    if (sibling) {
      sibling.next += 1;
      sibling.content = item.content;
    } else open.push({ indent: item.indent, content: item.content, bullet: item.bullet, delim: item.delim, next: item.number + 1 });
  });
  return out;
}

/** Where a position on a line lands after its marker changed length (9. → 10.). */
function follow(before: string[], after: string[], pos: Pos): Pos {
  const old = before[pos.line];
  const now = after[pos.line];
  if (old === undefined || now === undefined || old === now) return pos;
  const item = parse(old);
  if (!item || pos.col < item.indent + item.marker.length) return pos;
  return { line: pos.line, col: Math.max(0, pos.col + now.length - old.length) };
}

function finish(lines: string[], start: Pos, end: Pos = start): Edit {
  const tidied = tidy(lines);
  return { value: tidied.join("\n"), start: offset(tidied, follow(lines, tidied, start)), end: offset(tidied, follow(lines, tidied, end)) };
}

/** The item a line belongs to: itself, or the item above whose text it continues (indented under it). */
function ownerOf(d: Doc, line: number): number {
  if (d.items[line]) return line;
  if (d.fenced[line]) return -1;
  const text = d.lines[line]!;
  const indent = indentOf(text);
  if (!text.trim() || !indent) return -1;
  for (let at = line - 1; at >= 0; at -= 1) {
    const item = d.items[at];
    if (item) {
      if (indent >= item.content) return at;
      continue;
    }
    const above = d.lines[at]!;
    if (d.fenced[at] || !above.trim() || !indentOf(above)) return -1;
  }
  return -1;
}

const nextMarker = (item: Item) => (item.bullet ? item.marker : `${item.number + 1}${item.delim}`);
const prefixOf = (item: Item, marker = nextMarker(item)) => `${" ".repeat(item.indent)}${marker}${" ".repeat(item.gap)}${item.task ? "[ ] " : ""}`;

/** The last line of an item's own lines and everything nested under it. */
function subtreeEnd(d: Doc, line: number): number {
  const item = d.items[line]!;
  let last = line;
  for (let at = line + 1; at < d.lines.length; at += 1) {
    const text = d.lines[at]!;
    if (!text.trim()) continue;
    if (indentOf(text) <= item.indent) break;
    last = at;
  }
  return last;
}

/** Moves one item (and, with `withChildren`, what is nested under it) in or out a level. Null when it cannot move. */
function shift(d: Doc, line: number, dir: 1 | -1, withChildren: boolean): { lines: string[]; delta: number } | null {
  const item = d.items[line];
  if (!item) return null;
  let target = -1;
  let number = 1;
  if (dir === 1) {
    // Under the item above at the same level, as its child.
    for (let at = line - 1; at >= 0; at -= 1) {
      const above = d.items[at];
      const text = d.lines[at]!;
      if (!above) {
        if (!text.trim() || indentOf(text) >= item.indent + 1) continue;
        break;
      }
      if (above.indent > item.indent) continue;
      if (above.indent === item.indent) target = above.indent + above.marker.length + above.gap;
      break;
    }
    if (target < 0) return null;
    for (let at = line - 1; at >= 0; at -= 1) {
      const above = d.items[at];
      if (!above) continue;
      if (above.indent === target && !above.bullet) {
        number = above.number + 1;
        break;
      }
      if (above.indent < target) break;
    }
  } else {
    if (!item.indent) return null;
    target = 0;
    for (let at = line - 1; at >= 0; at -= 1) {
      const above = d.items[at];
      if (above && above.indent < item.indent) {
        target = above.indent;
        if (!above.bullet) number = above.number + 1;
        break;
      }
    }
  }
  const delta = target - item.indent;
  const last = withChildren ? subtreeEnd(d, line) : line;
  const lines = [...d.lines];
  for (let at = line; at <= last; at += 1) {
    const text = lines[at]!;
    if (!text.trim()) continue;
    lines[at] = delta > 0 ? " ".repeat(delta) + text : text.slice(Math.min(-delta, indentOf(text)));
  }
  if (!item.bullet) {
    const moved = lines[line]!;
    lines[line] = `${moved.slice(0, target)}${number}${item.delim}${moved.slice(target + item.marker.length)}`;
  }
  return { lines, delta };
}

const moveCol = (col: number, from: number, delta: number) => (col >= from ? Math.max(0, col + delta) : Math.min(col, from + delta));

/** Enter in a list: the next item, or out of the list from an empty one. Null when the caret is not in a list. */
export function enterInList(edit: Edit): Edit | null {
  const d = doc(edit.value.split("\n"));
  const start = position(d.lines, edit.start);
  const end = position(d.lines, edit.end);
  if (start.line !== end.line) return null;
  const owner = ownerOf(d, start.line);
  if (owner < 0) return null;
  const item = d.items[owner]!;
  const text = d.lines[start.line]!;
  const lines = [...d.lines];
  if (owner === start.line) {
    const body = text.slice(item.content);
    if (!body.trim() && start.col === end.col) {
      if (item.indent) {
        const moved = shift(d, start.line, -1, true);
        if (moved) return finish(moved.lines, { line: start.line, col: text.length + moved.delta });
      }
      lines[start.line] = "";
      return finish(lines, { line: start.line, col: 0 });
    }
    if (start.col < item.content) {
      // At the marker: an empty item goes in above, and the caret stays with this item's text.
      if (!body.trim()) return null;
      lines.splice(start.line, 0, prefixOf(item, item.marker));
      return finish(lines, { line: start.line + 1, col: item.content });
    }
  }
  const head = text.slice(0, start.col);
  const keep = owner === start.line ? item.content : 0;
  const trimmed = head.length > keep ? head.slice(0, keep) + head.slice(keep).trimEnd() : head;
  const prefix = prefixOf(item);
  lines.splice(start.line, 1, trimmed, prefix + text.slice(end.col).trimStart());
  return finish(lines, { line: start.line + 1, col: prefix.length });
}

/** Shift+Enter in a list: a new line inside the item, lined up with its text. */
export function breakInItem(edit: Edit): Edit | null {
  const d = doc(edit.value.split("\n"));
  const start = position(d.lines, edit.start);
  const end = position(d.lines, edit.end);
  if (start.line !== end.line) return null;
  const owner = ownerOf(d, start.line);
  if (owner < 0) return null;
  const item = d.items[owner]!;
  if (owner === start.line && start.col < item.content) return null;
  const text = d.lines[start.line]!;
  const pad = " ".repeat(item.content);
  const lines = [...d.lines];
  lines.splice(start.line, 1, text.slice(0, start.col), pad + text.slice(end.col));
  return finish(lines, { line: start.line + 1, col: pad.length });
}

/** Tab or Shift+Tab: the items picked (or the one with the caret, with what is under it) move a level. */
export function indentList(edit: Edit, outdent: boolean): Edit | null {
  const d0 = doc(edit.value.split("\n"));
  const start = position(d0.lines, edit.start);
  const end = position(d0.lines, edit.end);
  const owner = ownerOf(d0, start.line);
  const targets: number[] = [];
  for (let line = start.line; line <= end.line; line += 1) if (d0.items[line]) targets.push(line);
  if (!targets.length && owner >= 0) targets.push(owner);
  if (!targets.length) return null;
  const single = start.line === end.line;
  let d = d0;
  let caretStart = start;
  let caretEnd = end;
  let moved = false;
  for (const line of targets) {
    const item = d.items[line]!;
    const result = shift(d, line, outdent ? -1 : 1, single);
    if (!result) continue;
    moved = true;
    const last = single ? subtreeEnd(d, line) : line;
    const adjust = (pos: Pos): Pos => (pos.line >= line && pos.line <= last ? { line: pos.line, col: moveCol(pos.col, item.indent, result.delta) } : pos);
    caretStart = adjust(caretStart);
    caretEnd = adjust(caretEnd);
    d = doc(result.lines);
  }
  // Nothing could move (the first item cannot nest): the key is still the list's, not the next field's.
  if (!moved) return edit;
  return finish(d.lines, caretStart, caretEnd);
}

/** Backspace right after a marker: out a level, or the marker goes and the text stays. */
export function backspaceInList(edit: Edit): Edit | null {
  if (edit.start !== edit.end) return null;
  const d = doc(edit.value.split("\n"));
  const caret = position(d.lines, edit.start);
  const item = d.items[caret.line];
  if (!item || caret.col !== item.content) return null;
  if (item.indent) {
    const moved = shift(d, caret.line, -1, true);
    if (moved) return finish(moved.lines, { line: caret.line, col: caret.col + moved.delta });
  }
  const lines = [...d.lines];
  lines[caret.line] = lines[caret.line]!.slice(item.content);
  return finish(lines, { line: caret.line, col: 0 });
}

/**
 * After a change typed or pasted: "- " or "* " just typed at the start of a line becomes a bullet, and
 * when lines came or went the numbers follow. Null when nothing changes.
 */
export function afterInput(previous: string, edit: Edit): Edit | null {
  const lines = edit.value.split("\n");
  if (edit.start === edit.end && edit.value.length === previous.length + 1 && edit.value[edit.start - 1] === " ") {
    const at = edit.start - 1;
    if (edit.value.startsWith(previous.slice(0, at)) && edit.value.endsWith(previous.slice(at))) {
      const caret = position(lines, edit.start);
      const head = lines[caret.line]!.slice(0, caret.col);
      const typed = /^( *)([-*]) $/.exec(head);
      if (typed && !fences(lines)[caret.line]) {
        const next = [...lines];
        next[caret.line] = `${typed[1]}${BULLETS[0]}${lines[caret.line]!.slice(typed[1]!.length + 1)}`;
        return finish(next, caret);
      }
    }
  }
  if (previous.split("\n").length === lines.length) return null;
  const tidied = tidy(lines);
  if (tidied.every((line, index) => line === lines[index])) return null;
  const start = position(lines, edit.start);
  const end = position(lines, edit.end);
  return { value: tidied.join("\n"), start: offset(tidied, follow(lines, tidied, start)), end: offset(tidied, follow(lines, tidied, end)) };
}

/** Whether the caret is in a list item (for the key hint). */
export function inList(value: string, caret: number): boolean {
  const d = doc(value.split("\n"));
  return ownerOf(d, position(d.lines, caret).line) >= 0;
}

/** The text to send: the box's bullets back as Markdown's "- ". */
export function toMarkdown(value: string): string {
  const d = doc(value.split("\n"));
  return d.lines.map((line, index) => {
    const item = d.items[index];
    return item && GLYPHS.has(item.marker) ? `${line.slice(0, item.indent)}-${line.slice(item.indent + 1)}` : line;
  }).join("\n");
}

const wrapped = (value: string, from: number, to: number, mark: string) => {
  if (value.slice(from - mark.length, from) !== mark || value.slice(to, to + mark.length) !== mark) return false;
  // "*" is italic only when it is not half of a bold "**".
  return mark !== "*" || (value[from - 2] !== "*" && value[to + 1] !== "*");
};

/** Ctrl/Cmd+B, I, E, Shift+X: wraps the selection (each line of it) in `mark`, or unwraps it when it is wrapped. */
export function wrapInline(edit: Edit, mark: string): Edit {
  const { value } = edit;
  let start = edit.start;
  let end = edit.end;
  while (start < end && /\s/.test(value[start]!)) start += 1;
  while (end > start && /\s/.test(value[end - 1]!)) end -= 1;
  const inner = value.slice(start, end);
  const size = mark.length;
  if (start === end) {
    if (wrapped(value, start, start, mark)) return { value: value.slice(0, start - size) + value.slice(start + size), start: start - size, end: start - size };
    return { value: value.slice(0, start) + mark + mark + value.slice(start), start: start + size, end: start + size };
  }
  if (inner.length > size * 2 && inner.startsWith(mark) && inner.endsWith(mark) && !inner.includes("\n")) {
    const text = inner.slice(size, -size);
    return { value: value.slice(0, start) + text + value.slice(end), start, end: start + text.length };
  }
  if (wrapped(value, start, end, mark)) return { value: value.slice(0, start - size) + inner + value.slice(end + size), start: start - size, end: end - size };
  if (!inner.includes("\n")) return { value: value.slice(0, start) + mark + inner + mark + value.slice(end), start: start + size, end: end + size };
  // Several lines: each line's text is wrapped on its own, after any list marker.
  const lines = inner.split("\n").map((line) => {
    const item = parse(line);
    const from = item ? item.content : indentOf(line);
    const text = line.slice(from).trimEnd();
    return text ? `${line.slice(0, from)}${mark}${text}${mark}${line.slice(from + text.length)}` : line;
  });
  const next = lines.join("\n");
  return { value: value.slice(0, start) + next + value.slice(end), start, end: start + next.length };
}

/** The Markdown mark a formatting shortcut wraps with, or null. */
export function inlineMark(key: string, shift: boolean): string | null {
  const name = key.toLowerCase();
  if (shift) return name === "x" ? "~~" : null;
  return name === "b" ? "**" : name === "i" ? "*" : name === "e" ? "`" : null;
}
