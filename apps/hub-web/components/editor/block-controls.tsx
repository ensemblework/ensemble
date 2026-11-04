"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { Check, Copy, GripVertical, MessageSquare, Plus, Trash2 } from "lucide-react";
import { placeAnchoredPanel } from "@/lib/place-layer";
import { deleteBlock, duplicateBlock, moveBlock } from "./block-move";
import { BlockDrag } from "./block-drag";
import { BlockSelection, duplicateBlocks, selectedBlocks } from "./block-selection";
import { blockTargets, measureTargets, targetAt, targetIndent, type BlockTarget } from "./block-targets";
import { BLOCK_COMMANDS, blockKind, turnBlockInto, turnIntoChoices, type BlockCommandId } from "./editor-commands";

type Block = { pos: number; element: HTMLElement; top: number; indent: number };
/** `count` above 1: the menu acts on every selected block (Delete, Duplicate); Turn into is for one. */
type Menu = { pos: number; kind: BlockCommandId | null; count: number };

/** Pointer travel (px) after pressing the handle before it counts as a drag rather than a click. */
const DRAG_SLOP = 4;

/** Asks the page's comment layer to start a comment on this text range (see comment-layer.tsx). */
export const COMMENT_BLOCK_EVENT = "ensemble:comment-block";

/**
 * The hover controls beside a block: + and the drag handle on the left, and (when the page has
 * comments) a comment button on the right. All of them stand for one block position, found from
 * what the pointer is over and found again when the page scrolls.
 */
export function BlockControls({ editor, comment = false }: { editor: Editor; comment?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLButtonElement>(null);
  const [block, setBlock] = useState<Block | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const menuOpen = useRef(false);
  menuOpen.current = menu !== null;
  const dragged = useRef<number | null>(null);
  const pressedAt = useRef<{ x: number; y: number } | null>(null);
  const moved = useRef(false);
  useEffect(() => {
    const root = editor.view.dom;
    // The page's blocks (every list item its own), read again after each change to the page.
    let known: { targets: BlockTarget[]; byElement: Map<HTMLElement, BlockTarget> } | null = null;
    const blocks = () => {
      if (!known) {
        const targets = blockTargets(editor.view);
        known = { targets, byElement: new Map(targets.map((target) => [target.element, target])) };
      }
      return known;
    };
    const placed = (target: BlockTarget): Block => {
      const frame = (host.current?.offsetParent as HTMLElement | null) ?? root;
      const rect = target.element.getBoundingClientRect();
      const indent = targetIndent({ left: rect.left - root.getBoundingClientRect().left, marker: target.marker });
      return { pos: target.pos, element: target.element, top: rect.top - frame.getBoundingClientRect().top, indent };
    };
    /**
     * The block the pointer is on. Over a block's own content, the nearest block it is in (an item's
     * text is that item, a nested item's text that nested item). Over what only holds blocks (a list's
     * bullets and indent, a collapsible block's edge, the gutter beside the page), the block at that
     * height, so going for an item's handle never lands on its list. Undefined over the controls.
     */
    const find = (target: EventTarget | null, y: number): Block | null | undefined => {
      const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
      const body = host.current?.parentElement;
      if (!element || !(root.contains(element) || body?.contains(element))) return null;
      if (host.current?.contains(element) || element.closest(".block-comment-action")) return undefined;
      const { targets, byElement } = blocks();
      if (root.contains(element) && element !== root && !element.matches("ul, ol, li, .toggle-block, .toggle-block-content")) {
        for (let node: Element | null = element; node && node !== root; node = node.parentElement) {
          const found = byElement.get(node as HTMLElement);
          if (found) return placed(found);
        }
      }
      const found = targetAt(measureTargets(root, targets), y - root.getBoundingClientRect().top);
      return found ? placed(found) : null;
    };
    let pointer: { x: number; y: number } | null = null;
    let frameId = 0;
    // Scrolling moves blocks under a still pointer; the controls follow whatever is under it now.
    const rescan = () => {
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => {
        if (dragged.current !== null || menuOpen.current || !pointer) return;
        const next = find(document.elementFromPoint(pointer.x, pointer.y), pointer.y);
        if (next !== undefined) show(next);
      });
    };
    const show = (next: Block | null) => setBlock((current) => (current && next && current.pos === next.pos && current.top === next.top && current.indent === next.indent && current.element === next.element ? current : next));
    const hover = (event: PointerEvent) => {
      if (dragged.current !== null || menuOpen.current) return;
      // Over the controls, and where there is no block, they stay where they are, so they can be reached.
      const next = find(event.target, event.clientY);
      if (next) show(next);
    };
    let drag: BlockDrag | null = null;
    const clear = () => {
      drag?.cancel();
      drag = null;
      dragged.current = null;
    };
    const move = (event: PointerEvent) => {
      pointer = { x: event.clientX, y: event.clientY };
      if (dragged.current === null) return;
      if (!moved.current) {
        const origin = pressedAt.current;
        if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) < DRAG_SLOP) return;
        moved.current = true;
        const frame = host.current?.parentElement;
        drag = frame ? BlockDrag.start(editor, dragged.current, origin?.y ?? event.clientY, frame, blocks().targets) : null;
        if (!drag) {
          dragged.current = null;
          return;
        }
      }
      drag?.move(event.clientY);
    };
    const drop = () => {
      const current = drag;
      drag = null;
      dragged.current = null;
      if (!current) return;
      current.drop();
      setBlock(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && drag) {
        event.preventDefault();
        clear();
        setBlock(null);
      }
    };
    const transaction = ({ transaction }: { transaction: import("@tiptap/pm/state").Transaction }) => {
      if (!transaction.docChanged) return;
      known = null;
      // Someone else's edit while a block is carried: it goes back rather than land on a changed page.
      clear();
      setBlock(null);
      setMenu(null);
    };
    // The whole editor body, gutter included: the pointer on its way to a handle keeps that handle.
    const body = host.current?.parentElement ?? root;
    const scopes = body.contains(root) ? [body] : [root, body];
    for (const scope of scopes) {
      scope.addEventListener("pointermove", hover);
      // A tap has no hover: touching a block shows its controls.
      scope.addEventListener("pointerdown", hover);
    }
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", drop);
    document.addEventListener("pointercancel", clear);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("scroll", rescan, true);
    window.addEventListener("resize", rescan);
    editor.on("transaction", transaction);
    return () => {
      cancelAnimationFrame(frameId);
      for (const scope of scopes) {
        scope.removeEventListener("pointermove", hover);
        scope.removeEventListener("pointerdown", hover);
      }
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", drop);
      document.removeEventListener("pointercancel", clear);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("scroll", rescan, true);
      clear();
      window.removeEventListener("resize", rescan);
      editor.off("transaction", transaction);
    };
  }, [editor]);

  // Room beside the page for the controls. Where the view is narrow (a side peek, a small window) the
  // + goes, and the handle and the comment button sit just inside the page's edges instead of being cut off
  // by a scrolling ancestor or spilling over the border of a card the page sits in (meeting notes).
  useEffect(() => {
    const body = host.current?.parentElement;
    if (!body) return;
    const clipOf = (): HTMLElement | null => {
      for (let node = body.parentElement; node && node !== document.body; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.overflowX !== "visible") return node;
        if (parseFloat(style.borderLeftWidth) > 0 && parseFloat(style.borderRightWidth) > 0 && style.borderLeftStyle !== "none") return node;
      }
      return null;
    };
    const clip = clipOf();
    const measure = () => {
      const box = body.getBoundingClientRect();
      const edge = clip ? clip.getBoundingClientRect() : { left: 0, right: document.documentElement.clientWidth };
      const left = box.left - edge.left < 54 ? "tight" : "";
      const right = edge.right - box.right < 34 ? "tight" : "";
      if ((body.dataset.gutterLeft ?? "") !== left) body.dataset.gutterLeft = left;
      if ((body.dataset.gutterRight ?? "") !== right) body.dataset.gutterRight = right;
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(body);
    if (clip) observer?.observe(clip);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      delete body.dataset.gutterLeft;
      delete body.dataset.gutterRight;
    };
  }, []);

  const add = () => {
    if (block) {
      const node = editor.state.doc.nodeAt(block.pos);
      if (!node) return;
      const pos = block.pos + node.nodeSize;
      const listItem = node.type.name === "listItem" || node.type.name === "taskItem";
      const next = listItem ? { type: node.type.name, content: [{ type: "paragraph", content: [{ type: "text", text: "/" }] }] } : { type: "paragraph", content: [{ type: "text", text: "/" }] };
      editor.chain().focus().insertContentAt(pos, next).setTextSelection(pos + (listItem ? 3 : 2)).run();
    } else {
      const end = editor.state.doc.content.size;
      editor.chain().focus().insertContentAt(end, { type: "paragraph", content: [{ type: "text", text: "/" }] }).setTextSelection(end + 2).run();
    }
  };
  const openMenu = () => {
    if (!block) return;
    // As in Notion: the block whose handle is clicked is selected, or the selection it is part of stays.
    const { state } = editor;
    const current = state.selection;
    const within = current instanceof BlockSelection && selectedBlocks(state.doc, current.from, current.to).some((row) => row.pos === block.pos);
    const selection = within ? current : BlockSelection.create(state.doc, block.pos, block.pos);
    if (selection && !within) editor.view.dispatch(state.tr.setSelection(selection));
    const count = selection instanceof BlockSelection ? selectedBlocks(editor.state.doc, selection.from, selection.to).length : 1;
    setMenu({ pos: block.pos, kind: blockKind(editor.state.doc, block.pos), count });
  };
  const closeMenu = (refocus: boolean) => {
    setMenu(null);
    if (refocus) handle.current?.focus();
  };
  const run = (work: () => void) => {
    setMenu(null);
    work();
  };
  const node = block ? editor.state.doc.nodeAt(block.pos) : null;
  const commentable = comment && block && node && !node.isLeaf && node.textContent.trim() ? { from: block.pos + 1, to: block.pos + node.nodeSize - 1 } : null;
  return <>
  {commentable ? <button type="button" className="block-comment-action" style={{ top: block!.top }} aria-label="Comment on this block" title="Comment on this block" onMouseDown={(event) => event.preventDefault()} onClick={() => {
    editor.view.dom.dispatchEvent(new window.CustomEvent(COMMENT_BLOCK_EVENT, { detail: commentable }));
  }}><MessageSquare size={13} /></button> : null}
  <div ref={host} className="block-controls" data-idle={block ? undefined : ""} style={{ top: block?.top ?? 0, ["--controls-indent" as string]: `${block?.indent ?? 0}px` }}>
    <button type="button" aria-label="Add block" title="Add a block" onMouseDown={(event) => event.preventDefault()} onClick={add}><Plus size={15} /></button>
    {block ? <button ref={handle} type="button" data-block-position={block.pos} aria-label="Block actions" aria-haspopup="menu" aria-expanded={menu !== null} title="Click for actions · Drag to reorder · Arrow up/down to move" onPointerDown={(event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragged.current = block.pos;
      pressedAt.current = { x: event.clientX, y: event.clientY };
      moved.current = false;
      event.currentTarget.setPointerCapture(event.pointerId);
    }} onClick={(event) => {
      // A click that ended a drag is not a request for the menu; keyboard clicks have no pointer travel.
      if (event.detail !== 0 && moved.current) return;
      if (menu) closeMenu(false);
      else openMenu();
    }} onContextMenu={(event) => {
      event.preventDefault();
      openMenu();
    }} onKeyDown={(event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      const resolved = editor.state.doc.resolve(block.pos);
      const index = resolved.index();
      const next = index + (event.key === "ArrowUp" ? -1 : 1);
      if (next < 0 || next >= resolved.parent.childCount) return;
      let target = resolved.start();
      for (let i = 0; i < next; i++) target += resolved.parent.child(i).nodeSize;
      const tr = moveBlock(editor.state, block.pos, target, event.key === "ArrowDown");
      if (tr) editor.view.dispatch(tr);
    }}><GripVertical size={15} /></button> : null}
    {menu && block && handle.current ? <BlockMenu
      anchor={handle.current}
      kind={menu.count > 1 ? null : menu.kind}
      count={menu.count}
      onClose={closeMenu}
      onDelete={() => run(() => {
        const tr = menu.count > 1 && editor.state.selection instanceof BlockSelection ? editor.state.tr.deleteSelection().scrollIntoView() : deleteBlock(editor.state, menu.pos);
        if (tr) editor.view.dispatch(tr);
        editor.view.focus();
      })}
      onDuplicate={() => run(() => {
        const tr = (menu.count > 1 ? duplicateBlocks(editor.state) : null) ?? duplicateBlock(editor.state, menu.pos);
        if (tr) editor.view.dispatch(tr);
        editor.view.focus();
      })}
      onTurn={(kind) => run(() => {
        if (!turnBlockInto(editor, menu.pos, kind)) editor.view.focus();
      })}
    /> : null}
  </div>
  </>;
}

const MENU_WIDTH = 232;
const ITEM = "row-tile flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] outline-none focus:bg-hover";

/** The drag handle's menu: Delete, Duplicate and Turn into. Arrow keys move between items; Esc returns to the handle. */
function BlockMenu({ anchor, kind, count = 1, onClose, onDelete, onDuplicate, onTurn }: {
  anchor: HTMLElement;
  kind: BlockCommandId | null;
  count?: number;
  onClose: (refocus: boolean) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onTurn: (kind: BlockCommandId) => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const [box, setBox] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const choices = count > 1 ? [] : turnIntoChoices(kind);

  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    const next = placeAnchoredPanel({
      anchor: anchor.getBoundingClientRect(),
      panelWidth: MENU_WIDTH,
      panelHeight: element.scrollHeight,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      gap: 4,
    });
    setBox({ top: next.top, left: next.left, maxHeight: next.maxHeight });
    element.querySelector<HTMLElement>("[role^='menuitem']")?.focus({ preventScroll: true });
  }, [anchor]);

  useEffect(() => {
    const element = panel.current;
    if (!element) return;
    const items = () => Array.from(element.querySelectorAll<HTMLElement>("[role^='menuitem']"));
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Tab") {
        // Handled here so focus mode and the side peek do not also take this Esc.
        event.preventDefault();
        event.stopPropagation();
        close.current(true);
        return;
      }
      const list = items();
      const index = list.indexOf(document.activeElement as HTMLElement);
      const next =
        event.key === "ArrowDown" ? (index + 1) % list.length
        : event.key === "ArrowUp" ? (index - 1 + list.length) % list.length
        : event.key === "Home" ? 0
        : event.key === "End" ? list.length - 1
        : null;
      if (next === null) return;
      event.preventDefault();
      list[next]?.focus();
    };
    const outside = (event: Event) => {
      const target = event.target as Node | null;
      if (target && (element.contains(target) || anchor.contains(target))) return;
      close.current(false);
    };
    element.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", outside);
    window.addEventListener("scroll", outside, true);
    return () => {
      element.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", outside);
      window.removeEventListener("scroll", outside, true);
    };
  }, [anchor]);

  return createPortal(
    <div
      ref={panel}
      role="menu"
      aria-label="Block actions"
      className="pop-in overflow-y-auto rounded-lg bg-raised p-1 shadow-pop"
      style={{ position: "fixed", zIndex: 120, width: MENU_WIDTH, top: box?.top ?? 0, left: box?.left ?? 0, maxHeight: box?.maxHeight ?? 360, visibility: box ? "visible" : "hidden" }}
    >
      <button type="button" role="menuitem" className={ITEM} onClick={onDelete}>
        <Trash2 size={14} className="text-muted" />
        <span className="flex-1">{count > 1 ? `Delete ${count} blocks` : "Delete"}</span>
      </button>
      <button type="button" role="menuitem" className={ITEM} onClick={onDuplicate}>
        <Copy size={14} className="text-muted" />
        <span className="flex-1">{count > 1 ? `Duplicate ${count} blocks` : "Duplicate"}</span>
      </button>
      {choices.length ? (
        <div role="group" aria-labelledby={headingId}>
          <div role="separator" className="mx-1 my-1 h-px bg-line" />
          <div id={headingId} className="px-2 pb-1 pt-1 text-2xs font-medium uppercase tracking-wide text-faint">Turn into</div>
          {choices.map((id) => {
            const command = BLOCK_COMMANDS.find((item) => item.id === id)!;
            const current = id === kind;
            return (
              <button key={id} type="button" role="menuitemradio" aria-checked={current} className={ITEM} onClick={() => (current ? onClose(true) : onTurn(id))}>
                <span className="flex w-[14px] shrink-0 justify-center text-[11.5px] font-semibold text-muted">{command.symbol}</span>
                <span className="flex-1">{command.label}</span>
                {current ? <Check size={13} className="text-muted" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
