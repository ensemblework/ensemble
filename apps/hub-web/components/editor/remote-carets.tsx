"use client";

import type { Editor } from "@tiptap/core";
import type { Node as ProseNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { useEffect } from "react";
import { api, type PresenceEntry } from "@/lib/api";
import { tabId, usePresence } from "@/lib/presence";
import { sessionOf } from "./collab";

/** Caret moves go out at most this often, and only while someone else is on the page. */
const SEND_EVERY_MS = 300;
const AFTER_EDIT_MS = 120;

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

  return null;
}
