import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { moveBlock, moveBlockTo } from "./block-move";
import { measureTargets, targetAt, type BlockTarget, type MeasuredTarget } from "./block-targets";
import { motionReduced } from "@/lib/motion/drag";

/**
 * Dragging a block by its handle, the way cards move on a board: the block lifts into a copy that
 * follows the pointer, its neighbours slide aside to open the slot it will land in, and on release
 * it glides into place. Over a block of another container (another list, a nested item, the page
 * around a list) a line shows where it will land instead, as in Notion, and the drop moves it there
 * (`moveBlockTo`). The place comes from the pointer's height alone, so the pointer can stay in the
 * gutter. Nothing here writes to the editor's DOM: the copy and the line live outside it and the
 * sliding is Web Animations, which ProseMirror does not see as edits.
 */

type Slot = { node: PMNode; element: HTMLElement; top: number; height: number; step: number };

const SLIDE = { duration: 170, easing: "cubic-bezier(0.2, 0, 0, 1)", fill: "forwards" as const };
const SETTLE = { duration: 200, easing: "cubic-bezier(0.2, 0, 0, 1)" };
const EDGE = 56;

const canAnimate = (element: Element): boolean => typeof (element as HTMLElement).animate === "function";

function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (/(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

export class BlockDrag {
  private readonly root: HTMLElement;
  private readonly slots: Slot[];
  private readonly source: number;
  private readonly parentStart: number;
  private readonly grab: number;
  private readonly ghost: HTMLElement | null;
  private readonly frame: HTMLElement;
  private readonly scroller: HTMLElement | null;
  /** Reduced motion: neighbours and the drop still move, at once rather than gliding. */
  private readonly slideTiming = motionReduced() ? { ...SLIDE, duration: 0 } : SLIDE;
  private readonly settleTiming = motionReduced() ? { ...SETTLE, duration: 0 } : SETTLE;
  private readonly slides = new Map<HTMLElement, { to: number; animation: Animation | null }>();
  private index: number;
  private pointerY: number;
  private scrollFrame = 0;
  private done = false;
  private readonly spots: MeasuredTarget[];
  private line: HTMLElement | null = null;
  /** Where it lands when that is outside its own container: before or after another block. */
  private target: { pos: number; after: boolean } | null = null;

  /** Null when the block cannot be dragged (the view has no element for it or one of its siblings). */
  static start(editor: Editor, from: number, pointerY: number, frame: HTMLElement, targets: readonly BlockTarget[] = []): BlockDrag | null {
    const view = editor.view;
    const $from = editor.state.doc.resolve(from);
    const parent = $from.parent;
    const size = editor.state.doc.nodeAt(from)?.nodeSize ?? 0;
    const root = view.dom as HTMLElement;
    const base = root.getBoundingClientRect().top;
    const slots: Slot[] = [];
    let pos = $from.start();
    for (let index = 0; index < parent.childCount; index++) {
      const node = parent.child(index);
      const element = view.nodeDOM(pos);
      if (!(element instanceof HTMLElement)) return null;
      const rect = element.getBoundingClientRect();
      slots.push({ node, element, top: rect.top - base, height: rect.height, step: 0 });
      pos += node.nodeSize;
    }
    slots.forEach((slot, index) => {
      const next = slots[index + 1];
      const previous = slots[index - 1];
      slot.step = next ? next.top - slot.top : slot.height + (previous ? Math.max(0, slot.top - (previous.top + previous.height)) : 0);
    });
    // Where else it can land, measured before anything moves; never inside itself.
    const spots = measureTargets(root, targets.filter((target) => target.pos < from || target.pos >= from + size));
    return new BlockDrag(editor, slots, $from.index(), $from.start(), pointerY, frame, spots);
  }

  private constructor(private readonly editor: Editor, slots: Slot[], source: number, parentStart: number, pointerY: number, frame: HTMLElement, spots: MeasuredTarget[]) {
    this.root = editor.view.dom as HTMLElement;
    this.spots = spots;
    this.slots = slots;
    this.source = source;
    this.parentStart = parentStart;
    this.index = source;
    this.pointerY = pointerY;
    this.frame = frame;
    this.scroller = scrollParent(this.root);
    const base = this.root.getBoundingClientRect().top;
    this.grab = pointerY - base - slots[source]!.top;
    this.ghost = this.makeGhost();
    document.body.classList.add("block-dragging");
    const element = slots[source]!.element;
    if (canAnimate(element)) this.slides.set(element, { to: 0, animation: element.animate([{ opacity: 0.16 }], { duration: 120, fill: "forwards" }) });
    this.render();
  }

  /** A copy of the block to carry, with the page's text styles (it sits in a box styled like the page). */
  private makeGhost(): HTMLElement | null {
    const slot = this.slots[this.source]!;
    const copy = slot.element.cloneNode(true) as HTMLElement;
    copy.removeAttribute("contenteditable");
    copy.querySelectorAll("[contenteditable]").forEach((node) => node.removeAttribute("contenteditable"));
    const list = slot.element.tagName === "LI" ? slot.element.parentElement : null;
    const holder = document.createElement("div");
    holder.className = `${this.root.className} block-drag-ghost`;
    holder.setAttribute("aria-hidden", "true");
    holder.removeAttribute("contenteditable");
    if (list) {
      const wrap = list.cloneNode(false) as HTMLElement;
      // A numbered item keeps its number in the copy.
      if (wrap.tagName === "OL") wrap.setAttribute("start", String(Number(list.getAttribute("start") ?? 1) + this.source));
      wrap.appendChild(copy);
      holder.appendChild(wrap);
    } else holder.appendChild(copy);
    const rootBox = this.root.getBoundingClientRect();
    const frameBox = this.frame.getBoundingClientRect();
    // As wide as what it carries (a short line is a short card), never wider than the page.
    holder.style.left = `${rootBox.left - frameBox.left}px`;
    holder.style.maxWidth = `${rootBox.width}px`;
    holder.style.minWidth = `${Math.min(160, rootBox.width)}px`;
    this.frame.appendChild(holder);
    return holder;
  }

  move(pointerY: number): void {
    if (this.done) return;
    this.pointerY = pointerY;
    this.render();
    this.autoScroll();
  }

  private render(): void {
    const base = this.root.getBoundingClientRect().top;
    const slot = this.slots[this.source]!;
    const top = this.pointerY - base - this.grab;
    if (this.ghost) {
      const offset = base - this.frame.getBoundingClientRect().top;
      this.ghost.style.transform = `translate3d(0, ${Math.round(offset + top)}px, 0)`;
    }
    // Over a block of another container (or inside a neighbour): a line where it will land.
    const spot = targetAt(this.spots, this.pointerY - base);
    if (spot && spot.parent !== this.parentStart) {
      const after = this.pointerY - base > spot.middle;
      this.target = { pos: spot.pos, after };
      this.showLine(spot, after, base);
      if (this.index !== this.source) {
        this.index = this.source;
        this.layout();
      }
      return;
    }
    this.target = null;
    this.hideLine();
    const center = top + slot.height / 2;
    let index = 0;
    this.slots.forEach((other, at) => {
      if (at !== this.source && other.top + other.height / 2 < center) index++;
    });
    if (index !== this.index) {
      this.index = index;
      this.layout();
    }
  }

  private showLine(spot: MeasuredTarget, after: boolean, base: number): void {
    if (!this.line) {
      this.line = document.createElement("div");
      this.line.className = "block-drop-line";
      this.line.setAttribute("aria-hidden", "true");
      this.frame.appendChild(this.line);
    }
    const frameBox = this.frame.getBoundingClientRect();
    const rootBox = this.root.getBoundingClientRect();
    const inset = spot.left - (spot.marker ? 22 : 0);
    this.line.style.top = `${Math.round(base - frameBox.top + (after ? spot.bottom : spot.top))}px`;
    this.line.style.left = `${Math.round(rootBox.left - frameBox.left + inset)}px`;
    this.line.style.width = `${Math.max(24, Math.round(rootBox.width - inset))}px`;
    this.line.hidden = false;
  }

  private hideLine(): void {
    if (this.line) this.line.hidden = true;
  }

  /** Neighbours between the block's old place and its new one slide by its height; it waits, faded, in its new slot. */
  private layout(): void {
    const source = this.slots[this.source]!;
    this.slots.forEach((slot, at) => {
      let to = 0;
      if (at === this.source) {
        if (this.index > this.source) {
          const landing = this.slots[this.index]!;
          to = landing.top - source.step + landing.step - source.top;
        } else if (this.index < this.source) to = this.slots[this.index]!.top - source.top;
      } else if (at > this.source && at <= this.index) to = -source.step;
      else if (at < this.source && at >= this.index) to = source.step;
      this.slide(slot.element, to, at === this.source);
    });
  }

  private slide(element: HTMLElement, to: number, faded: boolean): void {
    if (!canAnimate(element)) return;
    const current = this.slides.get(element);
    if (current && current.to === to && current.animation) return;
    const from = current ? new DOMMatrixReadOnly(getComputedStyle(element).transform === "none" ? undefined : getComputedStyle(element).transform).m42 : 0;
    current?.animation?.cancel();
    const opacity = faded ? 0.16 : 1;
    const animation = element.animate(
      [{ transform: `translate3d(0, ${from}px, 0)`, opacity }, { transform: `translate3d(0, ${to}px, 0)`, opacity }],
      this.slideTiming,
    );
    this.slides.set(element, { to, animation });
  }

  private autoScroll(): void {
    cancelAnimationFrame(this.scrollFrame);
    const box = this.scroller ? this.scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    const speed = this.pointerY < box.top + EDGE ? -Math.ceil((box.top + EDGE - this.pointerY) / 4) : this.pointerY > box.bottom - EDGE ? Math.ceil((this.pointerY - (box.bottom - EDGE)) / 4) : 0;
    if (!speed) return;
    this.scrollFrame = requestAnimationFrame(() => {
      if (this.done) return;
      if (this.scroller) this.scroller.scrollTop += speed;
      else window.scrollBy(0, speed);
      this.render();
      this.autoScroll();
    });
  }

  /** Releases the block: moves it in the document (one transaction) and lets it glide into its slot. */
  drop(): boolean {
    if (this.done) return false;
    if (this.target) return this.dropElsewhere(this.target);
    if (this.index === this.source) {
      this.cancel();
      return false;
    }
    const view = this.editor.view;
    const before = new Map<PMNode, number>();
    for (const slot of this.slots) before.set(slot.node, slot.element.getBoundingClientRect().top);
    const ghostTop = this.ghost?.getBoundingClientRect().top ?? null;
    this.finish();
    const from = this.parentStart + this.slots.slice(0, this.source).reduce((size, slot) => size + slot.node.nodeSize, 0);
    const landing = this.index > this.source ? this.index : this.index;
    const targetPos = this.parentStart + this.slots.slice(0, landing).reduce((size, slot) => size + slot.node.nodeSize, 0);
    const tr = moveBlock(this.editor.state, from, targetPos, this.index > this.source);
    if (!tr) return false;
    view.dispatch(tr);
    // The page is in its new order: each block starts where it was drawn a moment ago and settles.
    const moved = this.slots[this.source]!.node;
    const $start = view.state.doc.resolve(this.parentStart);
    let pos = this.parentStart;
    for (let index = 0; index < $start.parent.childCount; index++) {
      const node = $start.parent.child(index);
      const element = view.nodeDOM(pos);
      pos += node.nodeSize;
      if (!(element instanceof HTMLElement) || !canAnimate(element)) continue;
      const was = node === moved && ghostTop !== null ? ghostTop : before.get(node);
      if (was === undefined) continue;
      const delta = was - element.getBoundingClientRect().top;
      if (Math.abs(delta) < 0.5) continue;
      element.animate([{ transform: `translate3d(0, ${delta}px, 0)` }, { transform: "translate3d(0, 0, 0)" }], this.settleTiming);
    }
    return true;
  }

  /** Lands it in another container: the blocks that moved settle from where they were drawn. */
  private dropElsewhere(target: { pos: number; after: boolean }): boolean {
    const view = this.editor.view;
    const home = this.slots[this.source]!.element;
    const before = new Map<HTMLElement, number>();
    for (const element of [...this.slots.map((slot) => slot.element), ...this.spots.map((spot) => spot.element)]) {
      if (element !== home) before.set(element, element.getBoundingClientRect().top);
    }
    const ghostTop = this.ghost?.getBoundingClientRect().top ?? null;
    const from = this.parentStart + this.slots.slice(0, this.source).reduce((size, slot) => size + slot.node.nodeSize, 0);
    this.finish();
    const moved = moveBlockTo(this.editor.state, from, target.pos, target.after);
    if (!moved) return false;
    view.dispatch(moved.tr);
    for (const [element, was] of before) {
      if (!element.isConnected || !canAnimate(element)) continue;
      const delta = was - element.getBoundingClientRect().top;
      if (Math.abs(delta) >= 0.5) element.animate([{ transform: `translate3d(0, ${delta}px, 0)` }, { transform: "translate3d(0, 0, 0)" }], this.settleTiming);
    }
    const landed = view.nodeDOM(moved.at);
    if (landed instanceof HTMLElement && canAnimate(landed) && ghostTop !== null) {
      const delta = ghostTop - landed.getBoundingClientRect().top;
      landed.animate([{ transform: `translate3d(0, ${delta}px, 0)` }, { transform: "translate3d(0, 0, 0)" }], this.settleTiming);
    }
    return true;
  }

  /** Puts everything back where it was. */
  cancel(): void {
    if (this.done) return;
    const ghost = this.ghost;
    const home = this.slots[this.source]!.element;
    const ghostTop = ghost?.getBoundingClientRect().top ?? null;
    this.finish();
    if (ghostTop !== null && canAnimate(home)) {
      const delta = ghostTop - home.getBoundingClientRect().top;
      if (Math.abs(delta) > 0.5) home.animate([{ transform: `translate3d(0, ${delta}px, 0)` }, { transform: "translate3d(0, 0, 0)" }], this.settleTiming);
    }
  }

  private finish(): void {
    this.done = true;
    cancelAnimationFrame(this.scrollFrame);
    for (const { animation } of this.slides.values()) animation?.cancel();
    this.slides.clear();
    this.ghost?.remove();
    this.line?.remove();
    document.body.classList.remove("block-dragging");
  }
}
