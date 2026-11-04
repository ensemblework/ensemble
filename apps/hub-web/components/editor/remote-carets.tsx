"use client";

import type { Editor } from "@tiptap/core";
import type { Node as ProseNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { useEffect } from "react";
import { api, type PresenceEntry } from "@/lib/api";
import { useFollowing } from "@/lib/follow";
import { tabId, usePresence } from "@/lib/presence";
import { sessionOf } from "./collab";

/** Caret moves go out at most this often, and only while someone else is on the page. */
const SEND_EVERY_MS = 300;
const AFTER_EDIT_MS = 120;
/** Scroll positions go out at most this often, also only while someone else is here. */
const SCROLL_EVERY_MS = 200;
/** Where the first line in view sits below the top of the scroll area. */
const TOP_GAP = 12;

/** The element a page scrolls in (the Hub's main area, a peek, a shared item's body), or null for the window. */
export function scrollParentOf(node: HTMLElement): HTMLElement | null {
  for (let element = node.parentElement; element; element = element.parentElement) {
    if (/(auto|scroll|overlay)/.test(getComputedStyle(element).overflowY)) return element;
  }
  return null;
}

function visibleBox(scroller: HTMLElement | null): { top: number; bottom: number } {
  if (scroller) {
    const box = scroller.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom };
  }
  return { top: 0, bottom: window.innerHeight };
}

function reducedMotion(): boolean {
  return document.documentElement.dataset.reduceMotion === "true" || Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

/** The first document position in view, or 0 while the top of the page shows. */
function firstInView(editor: Editor, scroller: HTMLElement | null): number | null {
  const view = editor.view;
  const box = visibleBox(scroller);
  const rect = view.dom.getBoundingClientRect();
  if (rect.top >= box.top) return 0;
  const hit = view.posAtCoords({ left: rect.left + Math.min(24, rect.width / 2), top: box.top + TOP_GAP });
  return hit ? hit.pos : null;
}

const carets = new PluginKey<DecorationSet>("remote-carets");

function caretElement(entry: PresenceEntry): HTMLElement {
  const caret = document.createElement("span");
  caret.contentEditable = "false";
  caret.setAttribute("aria-hidden", "true");
  caret.dataset.remoteCaret = entry.accountId;
  Object.assign(caret.style, { position: "relative", display: "inline-block", width: "0", height: "1em", verticalAlign: "text-bottom", pointerEvents: "none" });
  const line = document.createElement("span");
  Object.assign(line.style, { position: "absolute", left: "-1px", top: "-0.15em", bottom: "-0.15em", width: "2px", borderRadius: "1px", background: entry.color });
  const flag = document.createElement("span");
  flag.textContent = entry.name;
  Object.assign(flag.style, {
    position: "absolute",
    left: "-1px",
    bottom: "100%",
    marginBottom: "2px",
    padding: "1px 4px",
    borderRadius: "3px 3px 3px 0",
    background: entry.color,
    color: "#fff",
    font: "600 10.5px/1.3 system-ui, sans-serif",
    whiteSpace: "nowrap",
    userSelect: "none",
  });
  caret.append(line, flag);
  return caret;
}

type Caret = NonNullable<PresenceEntry["caret"]>;

/**
 * Other people's carets and selections. On a live page `place` maps a caret from the version it
 * was sent at to this document; otherwise its positions are clamped to ours.
 */
export function caretDecorations(doc: ProseNode, entries: PresenceEntry[], place?: (caret: Caret) => { anchor: number; head: number } | null): DecorationSet {
  const size = doc.content.size;
  const clamp = (pos: number) => Math.max(0, Math.min(size, pos));
  const list: Decoration[] = [];
  for (const entry of entries) {
    if (!entry.caret) continue;
    const placed = place?.(entry.caret);
    const anchor = clamp(placed?.anchor ?? entry.caret.anchor);
    const head = clamp(placed?.head ?? entry.caret.head);
    if (anchor !== head) list.push(Decoration.inline(Math.min(anchor, head), Math.max(anchor, head), { style: `background-color: ${entry.color}33` }));
    list.push(Decoration.widget(head, () => caretElement(entry), { key: `${entry.accountId}:${entry.tabId}:${entry.color}:${entry.name}`, side: -1, ignoreSelection: true }));
  }
  return DecorationSet.create(doc, list);
}

function caretPlugin(editor: Editor): Plugin<DecorationSet> {
  const place = (caret: Caret) => sessionOf(editor)?.place(caret) ?? null;
  return new Plugin<DecorationSet>({
    key: carets,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        const entries = tr.getMeta(carets) as PresenceEntry[] | undefined;
        return entries ? caretDecorations(tr.doc, entries, place) : set.map(tr.mapping, tr.doc);
      },
    },
    props: { decorations: (state) => carets.getState(state) },
  });
}

/**
 * Shows where the other people on this page are typing, in their colour with their full name,
 * and sends your own caret (through presence, like diagram cursors) while anyone else is here.
 */
export function RemoteCarets({ editor, page }: { editor: Editor; page: { kind: string; id: string } }) {
  const here = usePresence().filter((entry) => entry.resource?.kind === page.kind && entry.resource.id === page.id);
  const following = useFollowing();
  // Their tab in front, if they have several here.
  const followed = following ? here.filter((entry) => entry.accountId === following.accountId).sort((a, b) => Number(Boolean(a.away)) - Number(Boolean(b.away)) || b.at - a.at)[0] : undefined;
  const shown = here.filter((entry) => entry.caret);
  const signature = JSON.stringify(shown.map((entry) => [entry.accountId, entry.tabId, entry.caret, entry.color, entry.name]));
  const watched = here.length > 0;

  useEffect(() => {
    if (editor.isDestroyed) return;
    editor.registerPlugin(caretPlugin(editor));
    return () => {
      if (!editor.isDestroyed) editor.unregisterPlugin(carets);
    };
  }, [editor]);

  useEffect(() => {
    if (editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setMeta(carets, shown).setMeta("addToHistory", false));
    // `signature` names everything `shown` draws.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, signature]);

  useEffect(() => {
    if (!watched || editor.isDestroyed) return;
    let timer: number | undefined;
    let last = 0;
    let sent = "";
    const send = () => {
      if (editor.isDestroyed) return;
      // On a live page, positions are sent once your typing is on the server, with its version.
      const session = sessionOf(editor);
      const version = session?.caretVersion();
      if (session && version === null) {
        schedule(SEND_EVERY_MS);
        return;
      }
      const { anchor, head } = editor.state.selection;
      const caret = editor.isFocused && editor.isEditable ? { anchor, head, ...(typeof version === "number" ? { version } : {}) } : null;
      const value = JSON.stringify(caret);
      if (value === sent) return;
      sent = value;
      last = Date.now();
      void api.sendPresence({ tabId: tabId(), caret }).catch(() => undefined);
    };
    const schedule = (wait = 0) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(send, Math.max(wait, SEND_EVERY_MS - (Date.now() - last)));
    };
    const moved = () => schedule();
    // An edit sends the "is editing" ping at once, and the API drops a second post from the
    // same tab within 40 ms (`MIN_GAP_MS` in hub-api's sharing/presence.ts).
    const edited = () => schedule(AFTER_EDIT_MS);
    editor.on("selectionUpdate", moved);
    editor.on("update", edited);
    editor.on("focus", moved);
    editor.on("blur", moved);
    moved();
    return () => {
      window.clearTimeout(timer);
      editor.off("selectionUpdate", moved);
      editor.off("update", edited);
      editor.off("focus", moved);
      editor.off("blur", moved);
    };
  }, [editor, watched, page.kind, page.id]);

  // Where you are scrolled to, so someone following you sees the same part of the page.
  useEffect(() => {
    if (!watched || editor.isDestroyed) return;
    const scroller = scrollParentOf(editor.view.dom);
    const target: HTMLElement | Window = scroller ?? window;
    let timer: number | undefined;
    let last = 0;
    let sent = "";
    const send = () => {
      if (editor.isDestroyed) return;
      const pos = firstInView(editor, scroller);
      if (pos === null) return;
      const version = sessionOf(editor)?.caretVersion();
      const scroll = { pos, ...(typeof version === "number" ? { version } : {}) };
      const value = JSON.stringify(scroll);
      if (value === sent) return;
      sent = value;
      last = Date.now();
      void api.sendPresence({ tabId: tabId(), scroll }).catch(() => undefined);
    };
    const onScroll = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(send, Math.max(0, SCROLL_EVERY_MS - (Date.now() - last)));
    };
    target.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    onScroll();
    return () => {
      window.clearTimeout(timer);
      target.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [editor, watched, page.kind, page.id]);

  // Following someone here: show what they see, and keep their caret in view as it moves.
  const anchor = followed?.scroll ?? null;
  const caret = followed?.caret ?? null;
  useEffect(() => {
    if (!followed || editor.isDestroyed) return;
    const view = editor.view;
    const scroller = scrollParentOf(view.dom);
    const size = editor.state.doc.content.size;
    const at = (pos: number, version?: number) => sessionOf(editor)?.place({ anchor: pos, head: pos, version })?.head ?? Math.max(0, Math.min(size, pos));
    const box = visibleBox(scroller);
    let delta: number | null = null;
    try {
      if (anchor?.pos === 0) delta = -(scroller ? scroller.scrollTop : window.scrollY);
      else if (anchor) delta = view.coordsAtPos(at(anchor.pos, anchor.version)).top - (box.top + TOP_GAP);
      if (caret) {
        const point = view.coordsAtPos(at(caret.head, caret.version));
        const shift = delta ?? 0;
        // Their caret would be out of view (screens differ in size): bring it to the upper third.
        if (point.top - shift < box.top || point.bottom - shift > box.bottom - 24) delta = point.top - (box.top + (box.bottom - box.top) / 3);
      }
    } catch {
      return;
    }
    if (delta === null || Math.abs(delta) < 2) return;
    (scroller ?? window).scrollBy({ top: delta, behavior: Math.abs(delta) < 40 || reducedMotion() ? "auto" : "smooth" });
    // The positions name everything this reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, following?.accountId, followed === undefined, anchor?.pos, anchor?.version, caret?.head, caret?.version]);

  return null;
}
