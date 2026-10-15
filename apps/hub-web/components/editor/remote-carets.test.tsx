import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import type { PresenceEntry } from "@/lib/api";
import { presenceStore } from "@/lib/presence";
import { RemoteCarets, caretDecorations } from "./remote-carets";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const content = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Plan the launch" }] }] };

function person(caret: PresenceEntry["caret"], extra: Partial<PresenceEntry> = {}): PresenceEntry {
  return {
    accountId: "ben",
    tabId: "tab-1",
    name: "Ben Ortiz",
    initials: "BO",
    color: "#1971C2",
    route: "/pages/page-1",
    resource: { kind: "page", id: "page-1" },
    cursor: null,
    viewport: null,
    caret,
    typing: false,
    at: Date.now(),
    ...extra,
  };
}

test("a caret becomes a marker at its position, a selection is shaded, and positions past the end are clamped", () => {
  const editor = new Editor({ extensions: [StarterKit], content });
  try {
    const doc = editor.state.doc;
    const set = caretDecorations(doc, [person({ anchor: 1, head: 5 }), person({ anchor: 999, head: 999 }, { accountId: "cara", tabId: "tab-2" }), person(null, { accountId: "dev" })]);
    const found = set.find();
    assert.equal(found.length, 3, "one shaded range and two carets; no caret, no marker");
    assert.ok(found.some((decoration) => decoration.from === 1 && decoration.to === 5));
    assert.ok(found.some((decoration) => decoration.from === 5 && decoration.to === 5));
    assert.ok(found.some((decoration) => decoration.from === doc.content.size));
  } finally {
    editor.destroy();
  }
});

test("other people's carets on this page show with their full name; carets on other pages do not", async () => {
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const editor = new Editor({ element: mount, extensions: [StarterKit], content });
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    presenceStore.reset([person({ anchor: 5, head: 5 }), person({ anchor: 2, head: 2 }, { accountId: "cara", tabId: "tab-9", name: "Cara Diaz", resource: { kind: "page", id: "other" } })], "me");
    await act(async () => root.render(<RemoteCarets editor={editor} page={{ kind: "page", id: "page-1" }} />));
    const markers = [...mount.querySelectorAll("[data-remote-caret]")];
    assert.deepEqual(markers.map((marker) => marker.textContent), ["Ben Ortiz"]);
    assert.equal(editor.getText(), "Plan the launch", "the marker is not part of the text");
    await act(async () => presenceStore.reset([], "me"));
    assert.equal(mount.querySelectorAll("[data-remote-caret]").length, 0, "gone when they leave");
  } finally {
    await act(async () => root.unmount());
    presenceStore.clear();
    editor.destroy();
    mount.remove();
  }
});
