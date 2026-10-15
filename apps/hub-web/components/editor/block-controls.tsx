"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { Check, Copy, GripVertical, MessageSquare, Plus, Trash2 } from "lucide-react";
import { placeAnchoredPanel } from "@/lib/place-layer";
import { deleteBlock, duplicateBlock, moveBlock } from "./block-move";
import { BLOCK_COMMANDS, blockKind, turnBlockInto, turnIntoChoices, type BlockCommandId } from "./editor-commands";

type Block = { pos: number; element: HTMLElement; top: number };
type Menu = { pos: number; kind: BlockCommandId | null };

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
    /** The document position of a block's element, or null when the element is not a block the view knows. */
    const blockPos = (element: HTMLElement): number | null => {
      try {
        const { doc } = editor.state;
        const raw = editor.view.posAtDOM(element, 0);
        if (raw < 0 || raw > doc.content.size) return null;
        if (editor.view.nodeDOM(raw) === element) return raw;
        const resolved = doc.resolve(raw);
        for (let depth = resolved.depth; depth > 0; depth--) {
          if (editor.view.nodeDOM(resolved.before(depth)) === element) return resolved.before(depth);
        }
        return null;
      } catch {
        return null;
      }
    };
    const find = (target: EventTarget | null): Block | null => {
      let element = target instanceof HTMLElement ? target : target instanceof Node ? target.parentElement : null;
      // The gaps between blocks are the editor itself: no block there.
      if (!element || element === root || !root.contains(element)) return null;
      const li = element.closest("li");
      if (li && root.contains(li)) element = li;
      else while (element.parentElement && element.parentElement !== root && !element.parentElement.classList.contains("toggle-block-content")) element = element.parentElement;
      // A summary line stands for its whole collapsible block.
      if (element.parentElement?.classList.contains("toggle-block-content") && !element.previousElementSibling && element.parentElement.parentElement) element = element.parentElement.parentElement;
      const pos = blockPos(element);
      if (pos === null) return null;
      const frame = (host.current?.offsetParent as HTMLElement | null) ?? root;
      return { pos, element, top: element.getBoundingClientRect().top - frame.getBoundingClientRect().top };
    };
    let pointer: { x: number; y: number } | null = null;
    let frameId = 0;
    // Scrolling moves blocks under a still pointer; the controls follow whatever is under it now.
    const rescan = () => {
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => {
        if (dragged.current !== null || menuOpen.current || !pointer) return;
        show(find(document.elementFromPoint(pointer.x, pointer.y)));
      });
    };
    const show = (next: Block | null) => setBlock((current) => (current && next && current.pos === next.pos && current.top === next.top && current.element === next.element ? current : next));
    const hover = (event: PointerEvent) => {
      if (dragged.current !== null || menuOpen.current) return;
      // Between blocks the controls stay where they are, so they can be reached.
      const next = find(event.target);
      if (next) show(next);
    };
    let target: { block: Block; after: boolean } | null = null;
    const clear = () => {
      dragged.current = null;
      target = null;
      root.querySelectorAll(".block-drop-before, .block-drop-after").forEach((el) => el.classList.remove("block-drop-before", "block-drop-after"));
    };
    const move = (event: PointerEvent) => {
      pointer = { x: event.clientX, y: event.clientY };
      if (dragged.current === null) return;
      if (!moved.current) {
        const origin = pressedAt.current;
        if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) < DRAG_SLOP) return;
        moved.current = true;
      }
      const block = find(document.elementFromPoint(event.clientX, event.clientY));
      root.querySelectorAll(".block-drop-before, .block-drop-after").forEach((el) => el.classList.remove("block-drop-before", "block-drop-after"));
      target = null;
      if (!block || editor.state.doc.resolve(block.pos).parent !== editor.state.doc.resolve(dragged.current).parent) return;
      const rect = block.element.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      target = { block, after };
      block.element.classList.add(after ? "block-drop-after" : "block-drop-before");
      if (event.clientY < 60) block.element.scrollIntoView({ block: "nearest" });
    };
    const drop = () => {
      const from = dragged.current;
      const to = target;
      clear();
      if (from === null || !to) return;
      const tr = moveBlock(editor.state, from, to.block.pos, to.after);
      if (tr) editor.view.dispatch(tr);
      setBlock(null);
    };
    const transaction = ({ transaction }: { transaction: import("@tiptap/pm/state").Transaction }) => {
      if (!transaction.docChanged) return;
      clear();
      setBlock(null);
      setMenu(null);
    };
    root.addEventListener("pointermove", hover);
    // A tap has no hover: touching a block shows its controls.
    root.addEventListener("pointerdown", hover);
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", drop);
    document.addEventListener("pointercancel", clear);
    window.addEventListener("scroll", rescan, true);
    window.addEventListener("resize", rescan);
    editor.on("transaction", transaction);
    return () => {
      cancelAnimationFrame(frameId);
      root.removeEventListener("pointermove", hover);
      root.removeEventListener("pointerdown", hover);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", drop);
      document.removeEventListener("pointercancel", clear);
      window.removeEventListener("scroll", rescan, true);
      window.removeEventListener("resize", rescan);
      editor.off("transaction", transaction);
    };
  }, [editor]);

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
    if (block) setMenu({ pos: block.pos, kind: blockKind(editor.state.doc, block.pos) });
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
  <div ref={host} className="block-controls" data-idle={block ? undefined : ""} style={{ top: block?.top ?? 0 }}>
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
      kind={menu.kind}
      onClose={closeMenu}
      onDelete={() => run(() => {
        const tr = deleteBlock(editor.state, menu.pos);
        if (tr) editor.view.dispatch(tr);
        editor.view.focus();
      })}
      onDuplicate={() => run(() => {
        const tr = duplicateBlock(editor.state, menu.pos);
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
function BlockMenu({ anchor, kind, onClose, onDelete, onDuplicate, onTurn }: {
  anchor: HTMLElement;
  kind: BlockCommandId | null;
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
  const choices = turnIntoChoices(kind);

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
        <span className="flex-1">Delete</span>
      </button>
      <button type="button" role="menuitem" className={ITEM} onClick={onDuplicate}>
        <Copy size={14} className="text-muted" />
        <span className="flex-1">Duplicate</span>
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
