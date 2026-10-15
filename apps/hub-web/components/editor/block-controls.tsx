"use client";

import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { GripVertical, Plus } from "lucide-react";
import { moveBlock } from "./block-move";

type Block = { pos: number; element: HTMLElement; top: number };

export function BlockControls({ editor }: { editor: Editor }) {
  const host = useRef<HTMLDivElement>(null);
  const [block, setBlock] = useState<Block | null>(null);
  const dragged = useRef<number | null>(null);
  useEffect(() => {
    const root = editor.view.dom;
    const find = (target: EventTarget | null): Block | null => {
      let element = target instanceof HTMLElement ? target : null;
      if (!element || !root.contains(element)) return null;
      const li = element.closest("li");
      if (li && root.contains(li)) element = li;
      else while (element.parentElement && element.parentElement !== root && !element.parentElement.classList.contains("toggle-block-content")) element = element.parentElement;
      if (element === root) return null;
      const raw = editor.view.posAtDOM(element, 0);
      const resolved = editor.state.doc.resolve(raw);
      let pos = raw;
      for (let depth = resolved.depth; depth > 0; depth--) {
        if (editor.view.nodeDOM(resolved.before(depth)) === element) { pos = resolved.before(depth); break; }
      }
      return { pos, element, top: element.getBoundingClientRect().top - root.getBoundingClientRect().top };
    };
    const hover = (event: PointerEvent) => {
      if (dragged.current === null) setBlock(find(event.target));
    };
    let target: { block: Block; after: boolean } | null = null;
    const clear = () => {
      dragged.current = null;
      target = null;
      root.querySelectorAll(".block-drop-before, .block-drop-after").forEach((el) => el.classList.remove("block-drop-before", "block-drop-after"));
    };
    const move = (event: PointerEvent) => {
      if (dragged.current === null) return;
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
    };
    root.addEventListener("pointermove", hover);
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", drop);
    document.addEventListener("pointercancel", clear);
    editor.on("transaction", transaction);
    return () => {
      root.removeEventListener("pointermove", hover);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", drop);
      document.removeEventListener("pointercancel", clear);
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
  return <div ref={host} className="block-controls" style={{ top: block?.top ?? 0 }}>
    <button type="button" aria-label="Add block" title="Add a block" onMouseDown={(event) => event.preventDefault()} onClick={add}><Plus size={15} /></button>
    {block ? <button type="button" data-block-position={block.pos} aria-label="Drag block" title="Drag to reorder · Arrow up/down to move" onPointerDown={(event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragged.current = block.pos;
      event.currentTarget.setPointerCapture(event.pointerId);
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
  </div>;
}
