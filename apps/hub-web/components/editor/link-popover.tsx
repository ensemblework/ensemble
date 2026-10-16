"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { getMarkRange, type Editor } from "@tiptap/core";
import { ExternalLink, Pencil, Unlink } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Target = { kind: "link" | "page"; href: string; from: number; to: number; box: { top: number; left: number; bottom: number } };

const WIDTH = 300;

/** In-app addresses open in place; anything else opens in a new tab. */
export function openLink(href: string, navigate: (path: string) => void, newTab = false): void {
  if (!newTab && href.startsWith("/") && !href.startsWith("//")) navigate(href);
  else window.open(href, "_blank", "noopener,noreferrer");
}

/** The link (or link-to-page block) a click in the editor landed on, with its range in the document. */
export function linkAt(editor: Editor, element: Element): Omit<Target, "box"> | null {
  const anchor = element.closest("a[href]");
  if (!anchor || anchor.classList.contains("mention") || !editor.view.dom.contains(anchor)) return null;
  const href = anchor.getAttribute("href") ?? "";
  try {
    if (anchor.getAttribute("data-type") === "pageLink") {
      const pos = editor.view.posAtDOM(anchor, 0);
      const node = pos >= 0 ? editor.state.doc.nodeAt(pos) : null;
      return node?.type.name === "pageLink" ? { kind: "page", href, from: pos, to: pos + node.nodeSize } : null;
    }
    const type = editor.schema.marks.link;
    if (!type) return null;
    const pos = editor.view.posAtDOM(anchor.firstChild ?? anchor, 0);
    const range = getMarkRange(editor.state.doc.resolve(pos), type, { href }) ?? getMarkRange(editor.state.doc.resolve(Math.min(pos + 1, editor.state.doc.content.size)), type);
    return range ? { kind: "link", href, ...range } : null;
  } catch {
    return null;
  }
}

/**
 * Links in an editable page: Cmd/Ctrl+click opens one in a new tab; a plain click shows a small
 * card to open, edit or remove it. Link-to-page blocks get Open and Remove.
 */
export function LinkPopover({ editor, navigate }: { editor: Editor; navigate: (path: string) => void }) {
  const [target, setTarget] = useState<Target | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const dom = editor.view.dom;
    const click = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || event.button !== 0) return;
      const found = linkAt(editor, event.target);
      if (!found) return;
      event.preventDefault();
      if (event.metaKey || event.ctrlKey) {
        openLink(found.href, navigate, true);
        return;
      }
      const rect = (event.target.closest("a[href]") ?? event.target).getBoundingClientRect();
      setTarget({ ...found, box: { top: rect.top, left: rect.left, bottom: rect.bottom } });
      setEditing(false);
      setDraft(found.href);
    };
    const close = () => setTarget(null);
    const changed = ({ transaction }: { transaction: import("@tiptap/pm/state").Transaction }) => {
      if (transaction.docChanged) close();
    };
    dom.addEventListener("click", click);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    editor.on("transaction", changed);
    return () => {
      dom.removeEventListener("click", click);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      editor.off("transaction", changed);
    };
  }, [editor, navigate]);

  useEffect(() => {
    if (!target) return;
    const outside = (event: Event) => {
      const node = event.target as Node | null;
      if (node && panel.current?.contains(node)) return;
      setTarget(null);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setTarget(null);
      editor.commands.focus();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [target, editor]);

  useEffect(() => {
    if (editing) field.current?.select();
  }, [editing]);

  if (!target) return null;
  const done = () => {
    setTarget(null);
    editor.commands.focus();
  };
  const remove = () => {
    const { from, to, kind } = target;
    const tr = editor.state.tr;
    if (kind === "page") tr.delete(from, to);
    else tr.removeMark(from, to, editor.schema.marks.link);
    editor.view.dispatch(tr);
    done();
  };
  const save = () => {
    const href = draft.trim();
    if (!href) return remove();
    const type = editor.schema.marks.link!;
    editor.view.dispatch(editor.state.tr.removeMark(target.from, target.to, type).addMark(target.from, target.to, type.create({ href })));
    done();
  };
  const left = Math.max(8, Math.min(target.box.left, window.innerWidth - WIDTH - 8));
  const below = target.box.bottom + 6;
  const top = below + 96 > window.innerHeight ? Math.max(8, target.box.top - 96) : below;
  const ITEM = "btn h-7 gap-1.5 px-2 text-[12.5px]";
  return createPortal(
    <div ref={panel} role="dialog" aria-label={target.kind === "page" ? "Link to page" : "Link"} className="pop-in fixed z-[90] rounded-lg border border-line bg-raised p-2 shadow-pop" style={{ top, left, width: WIDTH }}>
      {editing ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <input ref={field} value={draft} onChange={(event) => setDraft(event.target.value)} aria-label="Link address" placeholder="https://… (empty removes the link)" className="field w-full py-1 text-[12.5px]" />
          <div className="flex gap-1">
            <button type="submit" className="btn-primary h-7 px-2 text-[12.5px]">Save</button>
            <button type="button" className={ITEM} onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </form>
      ) : (
        <>
          <div className="mb-1.5 truncate px-1 text-[12px] text-muted" title={target.href}>{target.href}</div>
          <div className="flex flex-wrap gap-1">
            <button type="button" className={ITEM} onClick={() => { openLink(target.href, navigate); setTarget(null); }}>
              <ExternalLink size={13} /> Open
            </button>
            {target.kind === "link" ? (
              <button type="button" className={ITEM} onClick={() => setEditing(true)}>
                <Pencil size={13} /> Edit
              </button>
            ) : null}
            <button type="button" className={ITEM} onClick={remove}>
              <Unlink size={13} /> Remove
            </button>
          </div>
        </>
      )}
    </div>,
    document.body,
  );
}
