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
import { BlockControls } from "../editor/block-controls";
import { CommentLayer, commentButtonPlace } from "./comment-layer";

Object.defineProperty(globalThis, "self", { configurable: true, value: window });
// comment-layer.tsx uses the classic JSX runtime.
(globalThis as { React?: typeof React }).React = React;
// jsdom has no CSS.escape or layout: text ranges get a fixed box.
Object.defineProperty(globalThis, "CSS", { configurable: true, value: { escape: (value: string) => value.replace(/["\\]/g, "\\$&") } });
const box = { top: 10, left: 10, right: 20, bottom: 20, width: 10, height: 10, x: 10, y: 10, toJSON: () => ({}) };
Object.defineProperty(window.Range.prototype, "getClientRects", { configurable: true, value: () => [box] });
Object.defineProperty(window.Range.prototype, "getBoundingClientRect", { configurable: true, value: () => box });

const p = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const comment = (id: string, text: string, markId: string | null = null) => ({ id, markId, quote: markId ? "Plant" : "", body: { text }, parentId: null, kind: "comment", status: "open", authorKind: "human" });

type Request = { method: string; url: string; body: unknown };

async function mount(content: object[], options: { canComment?: boolean; comments?: object[]; fail?: boolean } = {}) {
  const requests: Request[] = [];
  const posted: Array<{ markId?: string; quote?: string }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, url: String(input), body });
    if (options.fail && method !== "GET") return Response.json({ error: "You can't comment on this page." }, { status: 403 });
    if (method === "POST") {
      posted.push(body);
      return Response.json({ comment: { id: `c${posted.length}`, markId: body.markId, quote: body.quote, body: { text: "x" }, parentId: null, kind: "comment", status: "open" } });
    }
    if (method === "DELETE") return new Response(null, { status: 204 });
    if (method === "PATCH") return Response.json({ comment: { id: "c1" } });
    return Response.json({ comments: options.comments ?? [] });
  }) as typeof fetch;
  const toasts: string[] = [];
  bindToast((text) => toasts.push(text));
  const editor = new Editor({ extensions: [StarterKit, ToggleBlock, CommentMark], content: { type: "doc", content } });
  const page = document.createElement("div");
  page.className = "comment-host";
  page.appendChild(editor.view.dom);
  document.body.appendChild(page);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  const root = createRoot(host);
  const canComment = options.canComment ?? true;
  await act(async () => root.render(
    <QueryClientProvider client={client}>
      {canComment ? <BlockControls editor={editor} comment /> : null}
      <CommentLayer editor={editor as never} pageKind="page" pageId="p1" canComment={canComment} />
    </QueryClientProvider>,
  ));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  return {
    editor,
    posted,
    requests,
    toasts,
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
const action = () => document.querySelector<HTMLButtonElement>(".block-comment-action");
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
const type = (field: HTMLTextAreaElement, value: string) => act(async () => { setter.call(field, value); field.dispatchEvent(new Event("input", { bubbles: true })); });
const button = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent === label);
const openComment = () => act(async () => document.querySelector<HTMLButtonElement>(".comment-marker")!.click());
const key = (target: Element, name: string) => fire(target, new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));

test("a block comment highlights its block even when the page changes while the comment is being written", async () => {
  const { editor, posted, done } = await mount([p("Intro"), p("Plant the beans")]);
  const errors: unknown[] = [];
  const onError = (event: ErrorEvent) => errors.push(event.error);
  window.addEventListener("error", onError);
  try {
    await fire(editor.view.dom.children[1]!, new MouseEvent("pointermove", { bubbles: true }));
    assert.ok(action(), "hovering a block offers a comment on it");
    await fire(action()!, new MouseEvent("click", { bubbles: true }));
    const field = document.querySelector<HTMLTextAreaElement>("textarea[aria-label='Comment']");
    assert.ok(field, "the comment form opens");
    // Someone else's edit lands above the block while the comment is being typed.
    await act(async () => { editor.commands.insertContentAt(0, p("New first line")); });
    await type(field, "Which beans?");
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
    await fire(editor.view.dom.querySelector("hr")!, new MouseEvent("pointermove", { bubbles: true }));
    assert.equal(action(), null);
    await fire(editor.view.dom.children[2]!, new MouseEvent("pointermove", { bubbles: true }));
    assert.ok(action());
    await act(async () => { editor.commands.setContent(p("Short")); });
    assert.equal(action(), null, "the positions it held belong to the old document");
  } finally {
    await done();
  }
});

test("someone who can only view sees comments but nothing that writes one", async () => {
  const { editor, requests, done } = await mount([p("Plant the beans")], { canComment: false, comments: [comment("c1", "Which beans?")] });
  try {
    await openComment();
    assert.match(document.body.textContent ?? "", /Which beans\?/);
    for (const label of ["Edit", "Delete", "Resolve"]) assert.equal(button(label), undefined, label);
    assert.equal(document.querySelector("input[aria-label='Ask Ensemble']"), null);
    await act(async () => { editor.commands.setTextSelection({ from: 1, to: 6 }); });
    await settle();
    assert.equal(document.querySelector(".comment-selection-action"), null);
    await fire(editor.view.dom, new window.CustomEvent("ensemble:comment-block", { detail: { from: 1, to: 6 } }));
    window.dispatchEvent(new window.CustomEvent("ensemble:page-comment"));
    await settle();
    assert.equal(document.querySelector("textarea"), null);
    assert.deepEqual(requests.filter((request) => request.method !== "GET"), []);
  } finally {
    await done();
  }
});

test("a comment that fails to save keeps its text", async () => {
  const { requests, done } = await mount([p("Plant")], { fail: true });
  try {
    await act(async () => { window.dispatchEvent(new window.CustomEvent("ensemble:page-comment")); });
    const field = document.querySelector<HTMLTextAreaElement>("textarea[aria-label='Page comment']")!;
    await type(field, "Remember the soil");
    await act(async () => {
      field.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    assert.equal(document.querySelector<HTMLTextAreaElement>("textarea[aria-label='Page comment']")?.value, "Remember the soil");
    assert.equal(requests.filter((request) => request.method === "POST").length, 1);
  } finally {
    await done();
  }
});

test("editing a comment focuses the text, can't save it empty, and Esc puts it back", async () => {
  const { requests, done } = await mount([p("Plant")], { comments: [comment("c1", "Which beans?")] });
  try {
    await openComment();
    await act(async () => button("Edit")!.click());
    const field = document.querySelector<HTMLTextAreaElement>("textarea[aria-label='Edit comment']")!;
    assert.equal(document.activeElement, field);
    await type(field, "   ");
    assert.equal(button("Save")!.disabled, true);
    await key(field, "Escape");
    assert.equal(document.querySelector("textarea[aria-label='Edit comment']"), null);
    assert.equal(document.activeElement, button("Edit"));
    assert.match(document.body.textContent ?? "", /Which beans\?/);
    await act(async () => button("Edit")!.click());
    await type(document.querySelector<HTMLTextAreaElement>("textarea[aria-label='Edit comment']")!, "Broad beans");
    await act(async () => { button("Save")!.click(); await new Promise((resolve) => setTimeout(resolve, 30)); });
    assert.deepEqual(requests.filter((request) => request.method === "PATCH").map((request) => request.body), [{ body: { text: "Broad beans" } }]);
  } finally {
    await done();
  }
});

test("Delete asks first, and a deleted comment takes its highlight off the page", async () => {
  const { editor, requests, done } = await mount([{ type: "paragraph", content: [{ type: "text", text: "Plant", marks: [{ type: "comment", attrs: { id: "m1", commentId: "c1" } }] }, { type: "text", text: " the beans" }] }], { comments: [comment("c1", "Which beans?", "m1")] });
  try {
    await openComment();
    await act(async () => button("Delete")!.click());
    assert.equal(requests.filter((request) => request.method === "DELETE").length, 0, "nothing is deleted yet");
    assert.equal(document.activeElement?.textContent, "Delete");
    await act(async () => button("Keep")!.click());
    assert.equal(button("Keep"), undefined);
    await act(async () => button("Delete")!.click());
    await act(async () => {
      Array.from(document.querySelectorAll<HTMLButtonElement>("[aria-label='Delete this comment?'] button")).find((item) => item.textContent === "Delete")!.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    assert.equal(requests.filter((request) => request.method === "DELETE").length, 1);
    assert.equal(editor.view.dom.querySelector("[data-comment-id]"), null);
    assert.equal(editor.state.doc.textContent, "Plant the beans");
  } finally {
    await done();
  }
});

test("comments stay behind compact markers and open without reserving document space", async () => {
  const quote = "A long selected paragraph. ".repeat(40);
  const { editor, done } = await mount([{ type: "paragraph", content: [{ type: "text", text: quote, marks: [{ type: "comment", attrs: { id: "m1", commentId: "c1" } }] }] }], { comments: [{ ...comment("c1", "Keep this formatting", "m1"), quote }] });
  try {
    assert.equal(document.querySelector(".comment-popover"), null);
    assert.equal(document.querySelector(".comment-host.has-comments"), null);
    assert.equal(document.querySelectorAll(".comment-marker").length, 1);
    await fire(editor.view.dom.querySelector("[data-comment-id]")!, new MouseEvent("click", { bubbles: true }));
    assert.ok(document.querySelector('[role="dialog"][aria-label="Comment"]'));
    assert.equal(document.querySelector(".comment-quote")?.textContent, quote);
    assert.equal(document.querySelector(".comment-host")?.className, "comment-host");
    assert.equal(editor.state.doc.textContent, quote);
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Close comment"]')!.click());
    assert.equal(document.querySelector(".comment-popover"), null);
    assert.equal(editor.state.doc.textContent, quote);
  } finally { await done(); }
});

test("the selection's comment button sits beside the text, or under the selection, never over the line above", () => {
  const viewport = { width: 1200, height: 800 };
  assert.deepEqual(commentButtonPlace({ top: 300, left: 200, bottom: 340 }, 900, viewport), { top: 298, left: 906 });
  const narrow = commentButtonPlace({ top: 300, left: 200, bottom: 340 }, 1190, viewport);
  assert.deepEqual(narrow, { top: 346, left: 200 });
  const low = commentButtonPlace({ top: 760, left: 200, bottom: 790 }, 1190, viewport);
  assert.ok(low.top + 28 <= 760, "above the selection when there is no room below");
});
