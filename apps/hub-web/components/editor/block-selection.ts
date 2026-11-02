import { Extension } from "@tiptap/core";
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { AllSelection, Plugin, PluginKey, Selection, SelectionRange, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import type { Mappable } from "@tiptap/pm/transform";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { joinLists, removalRange } from "./block-move";
import { blockAround, blockPositions, blockTargets, measureTargets, type BlockPosition, type MeasuredTarget } from "./block-targets";
import { writeAtEnd } from "./trailing-block";

/**
 * Blocks as the units of a page, the way Notion treats them. A drag that starts beside the text (the
 * page's margins, the gaps between blocks, the space after a short line) draws a rectangle that
 * selects whole blocks; a drag through text selects text, until it crosses into another block, when
 * it selects those blocks instead. A double-click (and a drag from it) always selects text. Esc in a
 * block selects that block; with blocks selected, Delete removes them, copy and cut take them whole,
 * Enter goes back to writing, Esc lets go, ↑ ↓ move and Shift extends, Mod+A selects every block.
 */

/** The blocks between two blocks, in document order (`BlockPosition`), as one range of the page. */
function rangeOf(blocks: readonly BlockPosition[], anchor: number, head: number): { from: number; to: number } | null {
  const a = blocks.findIndex((block) => block.pos === anchor);
  const b = blocks.findIndex((block) => block.pos === head);
  if (a < 0 || b < 0) return null;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  let to = 0;
  for (let index = lo; index <= hi; index++) to = Math.max(to, blocks[index]!.pos + blocks[index]!.node.nodeSize);
  return { from: blocks[lo]!.pos, to };
}

/** The selected blocks themselves: each block wholly inside the range, but not the ones inside another selected block. */
export function selectedBlocks(doc: PMNode, from: number, to: number): BlockPosition[] {
  const out: BlockPosition[] = [];
  let end = -1;
  for (const block of blockPositions(doc)) {
    if (block.pos < from) continue;
    if (block.pos >= to) break;
    const blockEnd = block.pos + block.node.nodeSize;
    if (blockEnd > to || block.pos < end) continue;
    out.push(block);
    end = blockEnd;
  }
  return out;
}

class BlockBookmark {
  constructor(readonly anchor: number, readonly head: number) {}
  map(mapping: Mappable) {
    return new BlockBookmark(mapping.map(this.anchor, 1), mapping.map(this.head, 1));
  }
  resolve(doc: PMNode): Selection {
    return BlockSelection.create(doc, this.anchor, this.head) ?? TextSelection.near(doc.resolve(Math.min(this.anchor, doc.content.size)));
  }
}

/**
 * Whole blocks selected: from the block it started on (`anchorBlock`) to the block it reaches
 * (`headBlock`), with everything between them. Its range starts and ends between blocks, so copying
 * it copies whole blocks and deleting it removes them.
 */
export class BlockSelection extends Selection {
  readonly anchorBlock: number;
  readonly headBlock: number;

  /** Null when either position is not the start of a block. */
  static create(doc: PMNode, anchorBlock: number, headBlock: number): BlockSelection | null {
    const range = rangeOf(blockPositions(doc), anchorBlock, headBlock);
    return range ? new BlockSelection(doc, anchorBlock, headBlock, range) : null;
  }

  private constructor(doc: PMNode, anchorBlock: number, headBlock: number, range: { from: number; to: number }) {
    const $from = doc.resolve(range.from);
    const $to = doc.resolve(range.to);
    super($from, $to, [new SelectionRange($from, $to)]);
    this.anchorBlock = anchorBlock;
    this.headBlock = headBlock;
  }

  map(doc: PMNode, mapping: Mappable): Selection {
    const anchor = mapping.mapResult(this.anchorBlock, 1);
    const head = mapping.mapResult(this.headBlock, 1);
    if (!anchor.deleted && !head.deleted) {
      const next = BlockSelection.create(doc, anchor.pos, head.pos);
      if (next) return next;
    }
    return TextSelection.near(doc.resolve(Math.min(mapping.map(this.from, -1), doc.content.size)), -1);
  }

  /** Taking the blocks out (Delete, Backspace, cut, typing) removes them whole; a paste puts its content in their place. */
  replace(tr: Transaction, content: Slice = Slice.empty): void {
    if (content.size) {
      super.replace(tr, content);
      return;
    }
    const blocks = selectedBlocks(tr.doc, this.from, this.to);
    let at = this.from;
    for (const block of [...blocks].reverse()) {
      const [from, to] = removalRange(tr.doc, block.pos, block.node.nodeSize);
      const $from = tr.doc.resolve(from);
      if ($from.parent.canReplace($from.index(), $from.index() + 1)) tr.delete(from, to);
      else tr.replaceWith(from, to, tr.doc.type.schema.nodes.paragraph!.create());
      joinLists(tr, from);
      at = from;
    }
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(at, tr.doc.content.size)), -1));
  }

  eq(other: Selection): boolean {
    return other instanceof BlockSelection && other.anchorBlock === this.anchorBlock && other.headBlock === this.headBlock;
  }

  toJSON() {
    return { type: "blocks", anchor: this.anchorBlock, head: this.headBlock };
  }

  static fromJSON(doc: PMNode, json: { anchor: number; head: number }): Selection {
    return BlockSelection.create(doc, json.anchor, json.head) ?? TextSelection.near(doc.resolve(0));
  }

  getBookmark() {
    return new BlockBookmark(this.anchorBlock, this.headBlock);
  }
}
// Like a node selection: the browser's own highlight and caret are hidden, the blocks are marked instead.
BlockSelection.prototype.visible = false;
try {
  Selection.jsonID("blocks", BlockSelection);
} catch {
  // Registered already (the module loaded twice in development).
}

/** Every block of the page, selected. */
export function selectAllBlocks(state: EditorState): BlockSelection | null {
  const blocks = blockPositions(state.doc);
  const first = blocks[0];
  let last = first;
  for (const block of blocks) if (block.depth === 0) last = block;
  return first && last ? BlockSelection.create(state.doc, first.pos, last.pos) : null;
}

/** A copy of the selected blocks right after them, selected; null when they are not siblings. */
export function duplicateBlocks(state: EditorState): Transaction | null {
  const selection = state.selection;
  if (!(selection instanceof BlockSelection)) return null;
  const blocks = selectedBlocks(state.doc, selection.from, selection.to);
  const first = blocks[0];
  const last = blocks.at(-1);
  if (!first || !last || blocks.some((block) => block.parent !== first.parent)) return null;
  const at = last.pos + last.node.nodeSize;
  const tr = state.tr.insert(at, Fragment.fromArray(blocks.map((block) => block.node)));
  const comment = state.schema.marks.comment;
  const size = blocks.reduce((total, block) => total + block.node.nodeSize, 0);
  if (comment) tr.removeMark(at, at + size, comment);
  const copied = BlockSelection.create(tr.doc, at, at + size - last.node.nodeSize);
  if (copied) tr.setSelection(copied);
  return tr.scrollIntoView();
}

/** A text selection running from one block into another, as the blocks it touches (not across table cells). */
function blocksOfText(state: EditorState, blocks?: readonly BlockPosition[]): BlockSelection | null {
  const selection = state.selection;
  if (!(selection instanceof TextSelection) || selection.empty || selection.$from.sameParent(selection.$to)) return null;
  for (let depth = selection.$from.depth; depth > 0; depth--) {
    const name = selection.$from.node(depth).type.name;
    if (name === "table" && selection.$to.depth >= depth && selection.$to.node(depth) === selection.$from.node(depth)) return null;
  }
  const all = blocks ?? blockPositions(state.doc);
  const anchor = blockAround(all, selection.anchor);
  const head = blockAround(all, selection.head);
  return anchor && head ? BlockSelection.create(state.doc, anchor.pos, head.pos) : null;
}

type PluginState = { pressing: boolean };
export const BLOCK_SELECTION_KEY = new PluginKey<PluginState>("blockSelection");

/** What the selection marks: the selected blocks, or the blocks a text drag runs through. */
export function marked(state: EditorState): BlockSelection | null {
  if (state.selection instanceof BlockSelection) return state.selection;
  return BLOCK_SELECTION_KEY.getState(state)?.pressing ? blocksOfText(state) : null;
}

const SKIP = "button, a, input, textarea, select, label, img, video, iframe, table, pre, [contenteditable='false'], [role='menu'], [role='dialog'], .block-controls, .block-comment-action, .comment-selection-action, .tableWrapper";
const SLOP = 4;
const EDGE = 48;

/** Whether a point is on the text of a line (with a little room around the letters). */
function overText(element: Element, x: number, y: number): boolean {
  const range = document.createRange();
  range.selectNodeContents(element);
  // Where text cannot be measured, count it as text: the editor keeps the press.
  if (typeof range.getClientRects !== "function") return true;
  for (const rect of Array.from(range.getClientRects())) {
    if (x >= rect.left - 4 && x <= rect.right + 4 && y >= rect.top - 2 && y <= rect.bottom + 2) return true;
  }
  return false;
}

function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (/(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

/** The rectangle a drag from beside the text draws, and the clicks there (which still place the caret). */
class Marquee {
  private pointerType = "mouse";
  private start: { x: number; y: number; scroll: number } | null = null;
  private point = { x: 0, y: 0 };
  private moved = false;
  private box: HTMLElement | null = null;
  private prior: Selection | null = null;
  private scroller: HTMLElement | null = null;
  private frame = 0;

  constructor(private readonly view: EditorView) {
    document.addEventListener("pointerdown", this.onPointer, true);
    document.addEventListener("mousedown", this.onDown, true);
  }

  destroy() {
    this.finish();
    document.removeEventListener("pointerdown", this.onPointer, true);
    document.removeEventListener("mousedown", this.onDown, true);
  }

  private onPointer = (event: PointerEvent) => {
    this.pointerType = event.pointerType || "mouse";
  };

  /** The editor's body: the page column the blocks and their handles sit in. */
  private body(): HTMLElement {
    return (this.view.dom.closest(".block-editor-body") as HTMLElement | null) ?? (this.view.dom.parentElement as HTMLElement) ?? this.view.dom;
  }

  /** A press beside the text: on the page around the editor, its gutter, a gap, or the space after a line. */
  private beside(target: Element, x: number, y: number): boolean {
    const root = this.view.dom;
    const body = this.body();
    const box = body.getBoundingClientRect();
    if (y < box.top - 4 || y > box.bottom + 64) return false;
    // The page's background around the editor (something that holds it), not anything beside it.
    if (!body.contains(target)) return target.contains(body);
    if (target.closest(SKIP)) return false;
    if (target === root || !root.contains(target)) return true;
    const line = target.closest("p, h1, h2, h3, h4, h5, h6");
    return !(line && root.contains(line) && overText(line, x, y));
  }

  private onDown = (event: MouseEvent) => {
    const view = this.view;
    if (!view.editable || event.button !== 0) return;
    // Selected blocks keep a hidden text range in the page; pressing on it must start a fresh click, not drag that text away.
    if (view.state.selection instanceof BlockSelection && !event.shiftKey && event.target instanceof Node && view.dom.contains(event.target)) document.getSelection()?.removeAllRanges();
    if (event.detail > 1 || event.ctrlKey || event.metaKey || event.altKey) return;
    if (this.pointerType !== "mouse" && this.pointerType !== "pen") return;
    if (!(event.target instanceof Element) || !this.beside(event.target, event.clientX, event.clientY)) return;
    if (event.shiftKey) {
      // Shift-click beside a block stretches the block selection to it.
      const selection = view.state.selection;
      if (!(selection instanceof BlockSelection)) return;
      const hit = this.blockAt(event.clientY);
      if (!hit) return;
      event.preventDefault();
      const next = BlockSelection.create(view.state.doc, selection.anchorBlock, hit.pos);
      if (next) view.dispatch(view.state.tr.setSelection(next));
      return;
    }
    // The editor ignores a press whose default is prevented (no text selection starts, focus stays).
    event.preventDefault();
    this.scroller = scrollParent(view.dom);
    this.start = { x: event.clientX, y: event.clientY, scroll: this.scrollTop() };
    this.point = { x: event.clientX, y: event.clientY };
    this.moved = false;
    const selection = view.state.selection;
    this.prior = selection instanceof BlockSelection ? TextSelection.near(view.state.doc.resolve(selection.to), -1) : selection;
    window.addEventListener("mousemove", this.onMove, true);
    window.addEventListener("mouseup", this.onUp, true);
    window.addEventListener("keydown", this.onKey, true);
    window.addEventListener("scroll", this.onScroll, true);
  };

  private scrollTop(): number {
    return this.scroller ? this.scroller.scrollTop : window.scrollY;
  }

  private blockAt(y: number): MeasuredTarget | null {
    const root = this.view.dom;
    const top = y - root.getBoundingClientRect().top;
    const hits = measureTargets(root, blockTargets(this.view)).filter((target) => top >= target.headTop && top <= target.headBottom);
    return hits.at(-1) ?? null;
  }

  private onMove = (event: MouseEvent) => {
    if (!this.start) return;
    this.point = { x: event.clientX, y: event.clientY };
    if (!this.moved) {
      if (Math.hypot(event.clientX - this.start.x, event.clientY - this.start.y) < SLOP) return;
      this.moved = true;
      this.box = document.createElement("div");
      this.box.className = "block-marquee";
      this.box.setAttribute("aria-hidden", "true");
      document.body.appendChild(this.box);
      document.body.classList.add("block-marquee-active");
      (this.view.dom as HTMLElement).focus({ preventScroll: true });
    }
    event.preventDefault();
    this.draw();
    this.autoScroll();
  };

  private onScroll = () => {
    if (this.moved) this.draw();
  };

  /** The rectangle, from where the press started (moved with the page as it scrolls) to the pointer, and the blocks it covers. */
  private draw() {
    const start = this.start;
    if (!start || !this.box) return;
    const startY = start.y - (this.scrollTop() - start.scroll);
    const left = Math.min(start.x, this.point.x);
    const top = Math.min(startY, this.point.y);
    const bottom = Math.max(startY, this.point.y);
    Object.assign(this.box.style, { left: `${left}px`, top: `${top}px`, width: `${Math.abs(this.point.x - start.x)}px`, height: `${bottom - top}px` });
    const view = this.view;
    const root = view.dom;
    const base = root.getBoundingClientRect().top;
    const measured = measureTargets(root, blockTargets(view));
    // A block with blocks inside counts by its own first line, so a rectangle over only its nested blocks selects those.
    const hits = measured.filter((target) => target.headTop <= bottom - base && target.headBottom >= top - base);
    const state = view.state;
    if (!hits.length) {
      if (state.selection instanceof BlockSelection && this.prior) view.dispatch(state.tr.setSelection(this.prior));
      return;
    }
    const down = this.point.y >= startY;
    const anchor = down ? hits[0]! : hits.at(-1)!;
    const head = down ? hits.at(-1)! : hits[0]!;
    const next = BlockSelection.create(state.doc, anchor.pos, head.pos);
    if (next && !next.eq(state.selection)) view.dispatch(state.tr.setSelection(next));
  }

  private autoScroll() {
    cancelAnimationFrame(this.frame);
    const box = this.scroller ? this.scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    const y = this.point.y;
    const speed = y < box.top + EDGE ? -Math.ceil((box.top + EDGE - y) / 3) : y > box.bottom - EDGE ? Math.ceil((y - (box.bottom - EDGE)) / 3) : 0;
    if (!speed) return;
    this.frame = requestAnimationFrame(() => {
      if (!this.start) return;
      if (this.scroller) this.scroller.scrollTop += speed;
      else window.scrollBy(0, speed);
      this.draw();
      this.autoScroll();
    });
  }

  private onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !this.start) return;
    event.preventDefault();
    event.stopPropagation();
    const prior = this.prior;
    this.finish();
    if (prior) this.view.dispatch(this.view.state.tr.setSelection(prior.map(this.view.state.doc, this.view.state.tr.mapping)));
  };

  private onUp = (event: MouseEvent) => {
    if (!this.start) return;
    const moved = this.moved;
    this.finish();
    if (moved) return;
    // Not a drag: the click puts the caret where the editor would have (the nearest line, or the empty last line).
    const view = this.view;
    const root = view.dom;
    const rect = root.getBoundingClientRect();
    const blocks = Array.from(root.children).filter((child) => !child.classList.contains("trailing-line"));
    const last = blocks.at(-1);
    if (last && event.clientY > last.getBoundingClientRect().bottom) {
      writeAtEnd(view);
      return;
    }
    const x = Math.min(Math.max(event.clientX, rect.left + 2), rect.right - 2);
    const y = Math.min(Math.max(event.clientY, rect.top + 1), rect.bottom - 1);
    const at = view.posAtCoords({ left: x, top: y });
    (root as HTMLElement).focus({ preventScroll: true });
    if (at) view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at.pos))));
  };

  private finish() {
    cancelAnimationFrame(this.frame);
    this.start = null;
    this.box?.remove();
    this.box = null;
    document.body.classList.remove("block-marquee-active");
    window.removeEventListener("mousemove", this.onMove, true);
    window.removeEventListener("mouseup", this.onUp, true);
    window.removeEventListener("keydown", this.onKey, true);
    window.removeEventListener("scroll", this.onScroll, true);
  }
}

const isModA = (event: KeyboardEvent) => (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "a";

/** ↑ and ↓ over blocks: the block before the selection's top, or after its bottom (past the blocks inside it). */
function step(state: EditorState, selection: BlockSelection, down: boolean, extend: boolean): BlockSelection | null {
  const blocks = blockPositions(state.doc);
  if (extend) {
    const head = blocks.find((block) => block.pos === selection.headBlock);
    if (!head) return null;
    const below = selection.headBlock >= selection.anchorBlock;
    const next = down
      ? blocks.find((block) => block.pos > head.pos && (!below || block.pos >= head.pos + head.node.nodeSize))
      : [...blocks].reverse().find((block) => block.pos < head.pos && (below || block.pos + block.node.nodeSize <= head.pos));
    return next ? BlockSelection.create(state.doc, selection.anchorBlock, next.pos) : null;
  }
  const next = down
    ? blocks.find((block) => block.pos >= selection.to)
    : [...blocks].reverse().find((block) => block.pos + block.node.nodeSize <= selection.from);
  return next ? BlockSelection.create(state.doc, next.pos, next.pos) : null;
}

function handleBlockKeys(view: EditorView, event: KeyboardEvent): boolean {
  if (!view.editable || event.isComposing) return false;
  const state = view.state;
  const selection = state.selection;
  if (!(selection instanceof BlockSelection)) {
    if (!isModA(event)) return false;
    // Notion's Mod+A: the line's text first, then every block.
    const { $from, $to } = selection;
    if (selection instanceof AllSelection) {
      const all = selectAllBlocks(state);
      if (all) view.dispatch(state.tr.setSelection(all));
      return Boolean(all);
    }
    if (!$from.sameParent($to) || !$from.parent.isTextblock) return false;
    const whole = $from.parentOffset === 0 && $to.parentOffset === $from.parent.content.size;
    if (!whole && $from.parent.content.size > 0) {
      view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, $from.start(), $from.end())));
      return true;
    }
    const all = selectAllBlocks(state);
    if (all) view.dispatch(state.tr.setSelection(all));
    return Boolean(all);
  }
  const mod = event.metaKey || event.ctrlKey;
  switch (event.key) {
    case "Backspace":
    case "Delete":
      view.dispatch(state.tr.deleteSelection().scrollIntoView());
      return true;
    case "Escape":
      // Let go of the blocks; a second Esc goes on to whatever holds the page (a peek closes, focus mode ends).
      view.dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(selection.to), -1)));
      (view.dom as HTMLElement).blur();
      return true;
    case "Enter": {
      if (mod || event.shiftKey || event.altKey) return false;
      const head = blockPositions(state.doc).find((block) => block.pos === selection.headBlock);
      const end = head ? head.pos + head.node.nodeSize : selection.to;
      view.dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(Math.max(0, end - 1)), -1)).scrollIntoView());
      return true;
    }
    case "ArrowUp":
    case "ArrowDown": {
      if (mod || event.altKey) return false;
      const next = step(state, selection, event.key === "ArrowDown", event.shiftKey);
      if (next) view.dispatch(state.tr.setSelection(next).scrollIntoView());
      return true;
    }
    case "Tab":
      return true;
    default:
      break;
  }
  if (isModA(event)) {
    const all = selectAllBlocks(state);
    if (all) view.dispatch(state.tr.setSelection(all));
    return true;
  }
  if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "d") {
    const tr = duplicateBlocks(state);
    if (tr) view.dispatch(tr);
    return true;
  }
  // Typing does not write over selected blocks; shortcuts (copy, cut, undo, bold…) still work.
  return !mod && !event.altKey && event.key.length === 1;
}

export const BlockSelectionExtension = Extension.create({
  name: "blockSelection",
  // Ahead of the editor's own keys, so Enter, arrows and Backspace act on the selected blocks.
  priority: 1000,
  addProseMirrorPlugins() {
    return [
      new Plugin<PluginState>({
        key: BLOCK_SELECTION_KEY,
        state: {
          init: () => ({ pressing: false }),
          apply(tr, value) {
            const meta = tr.getMeta(BLOCK_SELECTION_KEY) as Partial<PluginState> | undefined;
            return meta ? { ...value, ...meta } : value;
          },
        },
        view: (view) => {
          const marquee = new Marquee(view);
          // A text drag that ran into other blocks ends as those blocks selected.
          const up = () => {
            if (!BLOCK_SELECTION_KEY.getState(view.state)?.pressing) return;
            window.setTimeout(() => {
              if (view.isDestroyed) return;
              const state = view.state;
              const blocks = blocksOfText(state);
              const tr = state.tr.setMeta(BLOCK_SELECTION_KEY, { pressing: false });
              if (blocks) tr.setSelection(blocks);
              view.dispatch(tr);
            }, 0);
          };
          // The button can come up where no mouseup is heard (the window lost focus): the drag is over all the same.
          const lost = () => {
            if (BLOCK_SELECTION_KEY.getState(view.state)?.pressing) view.dispatch(view.state.tr.setMeta(BLOCK_SELECTION_KEY, { pressing: false }));
          };
          window.addEventListener("mouseup", up);
          window.addEventListener("blur", lost);
          return {
            destroy() {
              marquee.destroy();
              window.removeEventListener("mouseup", up);
              window.removeEventListener("blur", lost);
            },
          };
        },
        props: {
          handleKeyDown: handleBlockKeys,
          handleTextInput: (view) => view.state.selection instanceof BlockSelection,
          handleDOMEvents: {
            mousedown(view, event) {
              // One click and a drag through text: if it reaches another block, it selects blocks (a double-click never does).
              const pressing = event.button === 0 && event.detail === 1 && !event.shiftKey && view.editable;
              if (pressing !== Boolean(BLOCK_SELECTION_KEY.getState(view.state)?.pressing)) view.dispatch(view.state.tr.setMeta(BLOCK_SELECTION_KEY, { pressing }));
              return false;
            },
            // Dragging selected text (or a file, a card) is a move, not a selection: no blocks to mark, and no mouseup will say it ended.
            dragstart(view) {
              if (BLOCK_SELECTION_KEY.getState(view.state)?.pressing) view.dispatch(view.state.tr.setMeta(BLOCK_SELECTION_KEY, { pressing: false }));
              return false;
            },
            beforeinput(view, event) {
              const input = event as InputEvent;
              if (!(view.state.selection instanceof BlockSelection) || !input.inputType.startsWith("insert") || input.inputType === "insertFromPaste" || input.inputType === "insertFromDrop") return false;
              event.preventDefault();
              return true;
            },
          },
          attributes(state): Record<string, string> {
            if (state.selection instanceof BlockSelection) return { class: "has-block-selection" };
            return marked(state) ? { class: "is-selecting-blocks" } : {};
          },
          decorations(state) {
            const selection = marked(state);
            if (!selection) return null;
            const blocks = selectedBlocks(state.doc, selection.from, selection.to);
            return DecorationSet.create(state.doc, blocks.map((block) => Decoration.node(block.pos, block.pos + block.node.nodeSize, { class: "block-selected" })));
          },
        },
      }),
    ];
  },
});

/**
 * Esc in a block selects it (and a second Esc lets it go). After everything else that answers Esc in
 * the editor (an open menu closes first); not in focus mode, where Esc leaves it.
 */
export const BlockEscape = Extension.create({
  name: "blockEscape",
  priority: 10,
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleKeyDown(view, event) {
            if (event.key !== "Escape" || event.isComposing || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false;
            const selection = view.state.selection;
            if (!view.editable || selection instanceof BlockSelection || view.dom.closest(".page-focus")) return false;
            const block = blockAround(blockPositions(view.state.doc), selection.$head.pos);
            const next = block ? BlockSelection.create(view.state.doc, block.pos, block.pos) : null;
            if (!next) return false;
            view.dispatch(view.state.tr.setSelection(next));
            return true;
          },
        },
      }),
    ];
  },
});
