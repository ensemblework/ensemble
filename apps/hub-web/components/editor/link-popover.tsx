"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { getMarkRange, type Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { mentionHref, type PageMention } from "@ensemble/shared-types";
import { ExternalLink, Pencil, Unlink } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Target = { kind: "link" | "page"; href: string; from: number; to: number; box: { top: number; left: number; bottom: number } };

const WIDTH = 300;
/** How long the pointer rests on a link before its card shows, and how long the card waits after the pointer leaves. */
export const HOVER_DELAY = 450;
const LEAVE_DELAY = 250;

const MENTION_LINK = /^ensemble:\/\/(people|project|repo|task|deliverable|skill|diagram|plot|dataset|file)\/(.+)$/;

/** The in-app path for an address, or null when it leaves the app. `ensemble://task/<id>` opens that record. */
export function inAppPath(href: string): string | null {
  if (href.startsWith("/") && !href.startsWith("//")) return href;
  const mention = MENTION_LINK.exec(href);
  if (!mention) return null;
  return mentionHref({ kind: mention[1] as PageMention["kind"], id: decodeURIComponent(mention[2]!), label: "" }) ?? null;
}

/** In-app addresses open in place; anything else opens in a new tab. */
export function openLink(href: string, navigate: (path: string) => void, newTab = false): void {
  const path = inAppPath(href);
  if (!newTab && path) navigate(path);
  else window.open(path ?? href, "_blank", "noopener,noreferrer");
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

/** The link element the caret is in, or the selected link-to-page block. */
export function linkElementAtCaret(editor: Editor): Element | null {
  const { selection } = editor.state;
  if (selection instanceof NodeSelection) {
    const dom = editor.view.nodeDOM(selection.from);
    return dom instanceof Element && dom.matches("a[data-type='pageLink']") ? dom : null;
  }
  const type = editor.schema.marks.link;
  const range = type ? getMarkRange(selection.$from, type) : undefined;
  if (!range) return null;
  const { node } = editor.view.domAtPos(range.from + 1);
  const element = node.nodeType === 3 ? node.parentElement : (node as Element);
  return element?.closest("a[href]") ?? null;
}

/**
 * Links in an editable page: a click opens one, in place for an in-app address and in a new tab
 * for the rest (Cmd/Ctrl+click always uses a new tab). Resting the pointer on a link, or Alt+Enter
 * with the caret in one, shows a small card to open, edit or remove it. Link-to-page blocks get
 * Open and Remove.
 */
export function LinkPopover({ editor, navigate }: { editor: Editor; navigate: (path: string) => void }) {
  const [target, setTarget] = useState<Target | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const shown = useRef<{ anchor: Element; focus: boolean } | null>(null);
  const timers = useRef<{ show?: number; hide?: number }>({});

  const close = () => {
    window.clearTimeout(timers.current.show);
    window.clearTimeout(timers.current.hide);
    shown.current = null;
    setTarget(null);
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    const dom = editor.view.dom;
    const show = (anchor: Element, focus: boolean) => {
      const found = linkAt(editor, anchor);
      if (!found) return;
      const rect = anchor.getBoundingClientRect();
      shown.current = { anchor, focus };
      setTarget({ ...found, box: { top: rect.top, left: rect.left, bottom: rect.bottom } });
      setEditing(false);
      setDraft(found.href);
    };
    const anchorOf = (node: EventTarget | null) => (node instanceof Element ? node.closest("a[href]") : null);
    // A card someone is typing in or tabbing through stays until they leave it.
    const busy = () => Boolean(panel.current?.contains(document.activeElement));
    const click = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || event.button !== 0) return;
      const found = linkAt(editor, event.target);
      if (!found) return;
      event.preventDefault();
      const newTab = event.metaKey || event.ctrlKey;
      // A drag or Shift+click that selected part of the link is editing, not a click on it.
      if (!newTab && !editor.state.selection.empty) return;
      closeRef.current();
      openLink(found.href, navigate, newTab);
    };
    const over = (event: MouseEvent) => {
      const anchor = anchorOf(event.target);
      if (!anchor || busy() || !linkAt(editor, anchor)) return;
      window.clearTimeout(timers.current.hide);
      if (shown.current?.anchor === anchor) return;
      window.clearTimeout(timers.current.show);
      timers.current.show = window.setTimeout(() => show(anchor, false), HOVER_DELAY);
    };
    const out = (event: MouseEvent) => {
      const anchor = anchorOf(event.target);
      if (!anchor || (event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget))) return;
      window.clearTimeout(timers.current.show);
      if (shown.current?.anchor === anchor && !busy()) timers.current.hide = window.setTimeout(() => closeRef.current(), LEAVE_DELAY);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || !event.altKey || event.isComposing) return;
      const anchor = linkElementAtCaret(editor);
      if (!anchor) return;
      event.preventDefault();
      event.stopPropagation();
      show(anchor, true);
    };
    const changed = ({ transaction }: { transaction: import("@tiptap/pm/state").Transaction }) => {
      if (transaction.docChanged) closeRef.current();
    };
    const away = () => closeRef.current();
    dom.addEventListener("click", click);
    dom.addEventListener("mouseover", over);
    dom.addEventListener("mouseout", out);
    dom.addEventListener("keydown", key, true);
    window.addEventListener("scroll", away, true);
    window.addEventListener("resize", away);
    editor.on("transaction", changed);
    return () => {
      dom.removeEventListener("click", click);
      dom.removeEventListener("mouseover", over);
      dom.removeEventListener("mouseout", out);
      dom.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", away, true);
      window.removeEventListener("resize", away);
      editor.off("transaction", changed);
      window.clearTimeout(timers.current.show);
      window.clearTimeout(timers.current.hide);
    };
  }, [editor, navigate]);

  useEffect(() => {
    if (!target) return;
    if (shown.current?.focus) panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (event: Event) => {
      const node = event.target as Node | null;
      if (node && panel.current?.contains(node)) return;
      closeRef.current();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
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
    close();
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
    <div
      ref={panel}
      role="dialog"
      aria-label={target.kind === "page" ? "Link to page" : "Link"}
      className="pop-in fixed z-[90] rounded-lg border border-line bg-raised p-2 shadow-pop"
      style={{ top, left, width: WIDTH }}
      onMouseEnter={() => window.clearTimeout(timers.current.hide)}
      onMouseLeave={() => {
        if (editing || panel.current?.contains(document.activeElement)) return;
        timers.current.hide = window.setTimeout(close, LEAVE_DELAY);
      }}
    >
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
            <button type="button" className={ITEM} onClick={() => { openLink(target.href, navigate); close(); }}>
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
