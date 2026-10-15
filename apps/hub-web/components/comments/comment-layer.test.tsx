/** @jsxRuntime automatic */
/** @jsxImportSource react */
import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { bindToast } from "@/lib/toast-bus";
import { CommentMark } from "../editor/comment-mark";
import { ToggleBlock } from "../editor/toggle-block";
import { CommentLayer } from "./comment-layer";

Object.defineProperty(globalThis, "self", { configurable: true, value: window });
// comment-layer.tsx uses the classic JSX runtime.
(globalThis as { React?: typeof React }).React = React;
// jsdom has no layout: text ranges get a fixed box.
const box = { top: 10, left: 10, right: 20, bottom: 20, width: 10, height: 10, x: 10, y: 10, toJSON: () => ({}) };
Object.defineProperty(window.Range.prototype, "getClientRects", { configurable: true, value: () => [box] });
Object.defineProperty(window.Range.prototype, "getBoundingClientRect", { configurable: true, value: () => box });

const p = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });

async function mount(content: object[]) {
  const posted: Array<{ markId?: string; quote?: string }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { markId?: string; quote?: string };
      posted.push(body);
      return Response.json({ comment: { id: `c${posted.length}`, markId: body.markId, quote: body.quote, body: { text: "x" }, parentId: null, kind: "comment", status: "open" } });
    }
    return Response.json({ comments: [] });
  }) as typeof fetch;
  bindToast(() => undefined);
  const editor = new Editor({ extensions: [StarterKit, ToggleBlock, CommentMark], content: { type: "doc", content } });
  const page = document.createElement("div");
  page.className = "comment-host";
  page.appendChild(editor.view.dom);
  document.body.appendChild(page);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  const root = createRoot(host);
  await act(async () => root.render(<QueryClientProvider client={client}><CommentLayer editor={editor as never} pageKind="page" pageId="p1" /></QueryClientProvider>));
  return {
    editor,
    posted,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
      page.remove();
      editor.destroy();
      client.clear();
      globalThis.fetch = realFetch;
      bindToast(null);
    },
  };
}

const fire = (node: EventTarget, event: Event) => act(async () => { node.dispatchEvent(event); });
const action = () => document.querySelector<HTMLButtonElement>(".comment-block-action");

test("a block comment highlights its block even when the page changes while the comment is being written", async () => {
  const { editor, posted, done } = await mount([p("Intro"), p("Plant the beans")]);
  const errors: unknown[] = [];
  const onError = (event: ErrorEvent) => errors.push(event.error);
  window.addEventListener("error", onError);
  try {
    await fire(editor.view.dom.children[1]!, new MouseEvent("mousemove", { bubbles: true }));
    assert.ok(action(), "hovering a block offers a comment on it");
    await fire(action()!, new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    const field = document.querySelector<HTMLTextAreaElement>("textarea[aria-label='Comment']");
    assert.ok(field, "the comment form opens");
    // Someone else's edit lands above the block while the comment is being typed.
    editor.commands.insertContentAt(0, p("New first line"));
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => { setter.call(field, "Which beans?"); field.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => {
      field.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    assert.equal(posted[0]?.quote, "Plant the beans");
    const marked = Array.from(editor.view.dom.querySelectorAll("[data-comment-id]")).map((node) => node.textContent).join("");
    assert.equal(marked, "Plant the beans");
    assert.deepEqual(errors, []);
  } finally {
    window.removeEventListener("error", onError);
    await done();
  }
});

test("blocks with no text, and stale hovers after an edit, offer no comment action", async () => {
  const { editor, done } = await mount([p("Text"), { type: "horizontalRule" }, p("More")]);
  try {
    await fire(editor.view.dom.querySelector("hr")!, new MouseEvent("mousemove", { bubbles: true }));
    assert.equal(action(), null);
    await fire(editor.view.dom.children[2]!, new MouseEvent("mousemove", { bubbles: true }));
    assert.ok(action());
    await act(async () => { editor.commands.setContent(p("Short")); });
    assert.equal(action(), null, "the positions it held belong to the old document");
  } finally {
    await done();
  }
});
