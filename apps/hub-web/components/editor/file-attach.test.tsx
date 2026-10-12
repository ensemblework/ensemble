/** @jsxRuntime automatic */
/** @jsxImportSource react */
import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Editor, type JSONContent } from "@tiptap/core";
import { Slice } from "@tiptap/pm/model";
import { documentMentions, restoreMentionLinks, type FileRecord, type PageDocument } from "@ensemble/shared-types";
import { bindToast } from "@/lib/toast-bus";
import { applyBlock, matchCommands } from "./editor-commands";
import { editorExtensions } from "./extensions";
import { FileChooser } from "./file-chooser";
import { pastedFiles } from "./file-attach";
import { mentionItems } from "./mention-items";

Object.defineProperty(globalThis, "self", { configurable: true, value: window });

type Call = { method: string; url: string; body: unknown };

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function record(id: string, filename: string, extra: Partial<FileRecord> = {}): FileRecord {
  return {
    id,
    filename,
    mediaType: "application/pdf",
    byteSize: 2048,
    format: "pdf",
    kind: "pdf",
    sha256: "0".repeat(64),
    textStatus: "ready",
    textCharacters: 10,
    pageCount: 1,
    warnings: [],
    summary: null,
    source: null,
    hasStyle: false,
    createdAt: "2026-10-12T09:00:00.000Z",
    updatedAt: "2026-10-12T09:00:00.000Z",
    ...extra,
  };
}

/** Answers file reads and uploads; every other request is a 404 so previews fail quietly. */
function serve(files: Record<string, FileRecord>, upload: (body: { filename: string }) => Response = (body) => json({ file: record(`up-${body.filename}`, body.filename) })) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method: init?.method ?? "GET", url, body });
    const path = new URL(url, "http://localhost").pathname;
    if (path === "/api/documents" && init?.method === "POST") return upload(body as { filename: string });
    if (path === "/api/documents") return json({ files: Object.values(files), usage: { count: 1, bytes: 1, maxCount: null, maxBytes: null, maxFileBytes: 1 } });
    const one = path.match(/^\/api\/documents\/([^/]+)$/);
    if (one && files[decodeURIComponent(one[1]!)]) return json({ file: files[decodeURIComponent(one[1]!)] });
    return json({ error: "Not found" }, 404);
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

// gcTime Infinity: no garbage-collection timers left behind to keep the test process alive.
const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
test.afterEach(() => client.clear());

function makeEditor(content: JSONContent | string, choose: (pos: number) => void = () => undefined) {
  let editor!: Editor;
  // File cards are React roots mounted by the node view.
  act(() => {
    editor = new Editor({ extensions: editorExtensions(() => [], "Type", () => true, () => true, { client: () => client, choose: (_editor, pos) => choose(pos) }), content });
  });
  return editor;
}

async function settle(until: () => boolean = () => false) {
  for (let index = 0; index < 50 && !until(); index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
    });
  }
}

function fileMentions(editor: Editor) {
  return documentMentions(editor.getJSON() as PageDocument).filter((mention) => mention.kind === "file");
}

function mentionAttrs(editor: Editor) {
  const found: Array<Record<string, unknown>> = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === "mention") found.push({ ...node.attrs });
  });
  return found;
}

test("a file mention is a card with its type, size and Open link, and survives save and reload", async () => {
  const server = serve({ "file-1": record("file-1", "report.pdf") });
  const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: "file-1", label: "report.pdf", kind: "file", height: 300 } }] }] };
  const editor = makeEditor(doc);
  let reopened: Editor | null = null;
  try {
    await settle(() => Boolean(editor.view.dom.querySelector("[data-file-embed] .diagram-inline-head")?.textContent?.includes("2.0 KB")));
    const card = editor.view.dom.querySelector<HTMLElement>("[data-file-embed='file-1']");
    assert.ok(card, "the mention renders as a card, not a chip");
    assert.equal(editor.view.dom.querySelector("a.mention"), null);
    assert.match(card.textContent ?? "", /report\.pdf/);
    assert.match(card.textContent ?? "", /PDF · 2\.0 KB/);
    assert.equal(card.querySelector("a")?.getAttribute("href"), "/files/file-1");
    assert.ok(card.querySelector(".file-embed-body"));
    assert.equal(card.querySelector("[role='separator']")?.getAttribute("aria-valuenow"), "300");

    const saved = editor.getJSON() as PageDocument;
    assert.deepEqual(documentMentions(saved), [{ kind: "file", id: "file-1", label: "report.pdf" }]);
    reopened = makeEditor(saved as JSONContent);
    assert.deepEqual(reopened.getJSON(), saved);
    assert.deepEqual(mentionAttrs(reopened), [{ id: "file-1", label: "report.pdf", kind: "file", height: 300 }]);

    assert.match(editor.getHTML(), /<a class="mention" href="\/files\/file-1" data-id="file-1" data-label="report.pdf" data-kind="file" data-height="300">/);

    const linked = restoreMentionLinks({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "@report.pdf", marks: [{ type: "link", attrs: { href: "ensemble://file/file-1" } }] }] }] });
    assert.deepEqual(documentMentions(linked), [{ kind: "file", id: "file-1", label: "report.pdf" }]);
  } finally {
    reopened?.destroy();
    await act(async () => editor.destroy());
    server.restore();
  }
});

test("a removed file shows a quiet note instead of breaking the page", async () => {
  const server = serve({});
  const editor = makeEditor({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "See " }, { type: "mention", attrs: { id: "gone", label: "old.pdf", kind: "file" } }] }] });
  try {
    await settle(() => Boolean(editor.view.dom.textContent?.includes("removed")));
    assert.match(editor.view.dom.textContent ?? "", /old\.pdf/);
    assert.match(editor.view.dom.textContent ?? "", /This file was removed\./);
    assert.equal(editor.view.dom.querySelector("[data-file-embed] a"), null);
    assert.equal(editor.getText().startsWith("See "), true);
  } finally {
    await act(async () => editor.destroy());
    server.restore();
  }
});

test("the card's remove button takes the file off the page, leaves the rest, and is absent when read-only", async () => {
  const server = serve({ "file-1": record("file-1", "report.pdf") });
  const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Before " }, { type: "mention", attrs: { id: "file-1", label: "report.pdf", kind: "file" } }, { type: "text", text: " after" }] }] };
  const editor = makeEditor(doc);
  let readOnly: Editor | null = null;
  try {
    await settle(() => Boolean(editor.view.dom.querySelector("[data-file-embed] button[aria-label='Remove report.pdf from the page']")));
    const remove = editor.view.dom.querySelector<HTMLButtonElement>("[data-file-embed] button[aria-label='Remove report.pdf from the page']");
    assert.ok(remove, "editable pages offer a remove button on the card");
    assert.match(remove.title, /stays in Files/);
    await act(async () => remove.click());
    assert.deepEqual(fileMentions(editor), []);
    assert.equal(editor.getText(), "Before  after");
    assert.ok(!server.calls.some((call) => call.method === "DELETE"), "the file itself is not deleted");

    act(() => {
      readOnly = new Editor({ editable: false, extensions: editorExtensions(() => [], "Type", () => true, () => true, { client: () => client }), content: doc });
    });
    await settle(() => Boolean(readOnly!.view.dom.querySelector("[data-file-embed] .diagram-inline-head")?.textContent?.includes("2.0 KB")));
    assert.equal(readOnly!.view.dom.querySelector("[data-file-embed] button[aria-label^='Remove']"), null);
  } finally {
    const opened = readOnly as Editor | null;
    if (opened) await act(async () => opened.destroy());
    await act(async () => editor.destroy());
    server.restore();
  }
});

test("files are in the @ menu with their type, scoped and unscoped", () => {
  const rows = () => [
    { kind: "file", id: "file-1", label: "Q3 report.pdf", detail: "2.0 MB" },
    { kind: "file", id: "file-2", label: "budget.xlsx", detail: "Excel workbook · 40 KB" },
    { kind: "task", id: "task-1", label: "Q3 review", detail: "Task" },
  ];
  const on = () => true;
  const unscoped = mentionItems("q3", rows, on, on);
  assert.deepEqual(unscoped.filter((item) => item.type === "entity").map((item) => item.label), ["Q3 report.pdf", "Q3 review"]);
  const scoped = mentionItems("file:", rows, on, on);
  assert.deepEqual(scoped.map((item) => item.type === "entity" && item.detail), ["PDF · 2.0 MB", "Excel workbook · 40 KB"]);
  assert.ok(mentionItems("", rows, on, on).some((item) => item.type === "group" && item.kind === "file"));
});

test("/file and its synonyms open the chooser, and an upload lands as a card where the command was", async () => {
  for (const word of ["file", "attach", "upload", "pdf", "image"]) assert.equal(matchCommands(word)[0]?.id, "file", word);
  const server = serve({});
  const opened: number[] = [];
  const editor = makeEditor("<p>Intro /file</p>", (pos) => opened.push(pos));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    applyBlock(editor, { from: 7, to: 12 }, "file");
    assert.equal(editor.getText(), "Intro ");
    assert.deepEqual(opened, [7]);

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <FileChooser editor={editor} pos={opened[0]!} onClose={() => root.render(null)} />
        </QueryClientProvider>,
      );
    });
    const dialog = document.querySelector("[role='dialog'][aria-label='Attach a file']")!;
    assert.match(dialog.textContent ?? "", /Upload from this computer/);
    assert.match(dialog.textContent ?? "", /Choose from Files/);
    assert.equal(dialog.querySelector("a")?.getAttribute("href"), "/files");

    const input = dialog.querySelector<HTMLInputElement>("input[type='file']")!;
    assert.equal(input.multiple, true);
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["%PDF-1.7"], "notes.pdf", { type: "application/pdf" })] });
    await act(async () => {
      input.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    await settle(() => fileMentions(editor).length > 0);
    const upload = server.calls.find((call) => call.method === "POST")!;
    assert.deepEqual(upload.body, { filename: "notes.pdf", mediaType: "application/pdf", dataBase64: Buffer.from("%PDF-1.7").toString("base64") });
    assert.deepEqual(fileMentions(editor), [{ kind: "file", id: "up-notes.pdf", label: "notes.pdf" }]);
    const paragraph = editor.getJSON().content![0]!;
    assert.deepEqual(paragraph.content!.map((node) => node.type), ["text", "mention", "text"]);
    assert.equal(document.querySelector("[aria-label='Attach a file']"), null);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    await act(async () => editor.destroy());
    server.restore();
  }
});

test("Choose from Files searches what is there and inserts the picked file", async () => {
  const server = serve({ "file-9": record("file-9", "brief.docx", { kind: "document", format: "docx", byteSize: 4096 }) });
  const editor = makeEditor("<p>Hi</p>");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <FileChooser editor={editor} pos={3} onClose={() => root.render(null)} />
        </QueryClientProvider>,
      );
    });
    const choose = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Choose from Files"))!;
    await act(async () => choose.click());
    await settle(() => Boolean(document.body.textContent?.includes("brief.docx")));
    const row = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("brief.docx"))!;
    assert.match(row.textContent ?? "", /Word document · 4\.0 KB/);
    await act(async () => row.click());
    assert.deepEqual(fileMentions(editor), [{ kind: "file", id: "file-9", label: "brief.docx" }]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    await act(async () => editor.destroy());
    server.restore();
  }
});

function pasteEvent(data: { files?: File[]; types?: string[]; text?: string; html?: string }) {
  const event = new window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      files: data.files ?? [],
      types: data.types ?? [],
      getData: (type: string) => (type === "text/plain" || type === "Text" ? data.text ?? "" : type === "text/html" ? data.html ?? "" : ""),
    },
  });
  return event as ClipboardEvent;
}

test("pasting an image uploads it with an inline placeholder and puts a card at the cursor", async () => {
  const server = serve({});
  const editor = makeEditor("<p>Hello world</p>");
  try {
    editor.commands.setTextSelection(6);
    const shot = new File(["png"], "shot.png", { type: "image/png" });
    const event = pasteEvent({ files: [shot], types: ["Files"] });
    editor.view.dom.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    assert.equal(editor.view.dom.querySelector(".file-upload-placeholder")?.textContent, "Uploading shot.png…");
    assert.equal(editor.getText(), "Hello world", "the placeholder is not part of the saved page");
    await settle(() => fileMentions(editor).length > 0);
    assert.equal(server.calls.filter((call) => call.method === "POST").length, 1);
    assert.equal(editor.view.dom.querySelector(".file-upload-placeholder"), null);
    const paragraph = editor.getJSON().content![0]!;
    assert.deepEqual(paragraph.content!.map((node) => node.text ?? node.attrs?.label), ["Hello", "shot.png", "  world"]);
  } finally {
    await act(async () => editor.destroy());
    server.restore();
  }
});

test("text, HTML and Office pastes are left to the editor", async () => {
  const server = serve({});
  const editor = makeEditor("<p>Hello</p>");
  try {
    editor.commands.setTextSelection(6);
    editor.view.dom.dispatchEvent(pasteEvent({ types: ["text/plain"], text: " there" }));
    assert.equal(editor.getText(), "Hello there");
    const picture = new File(["png"], "image.png", { type: "image/png" });
    assert.deepEqual(pastedFiles(pasteEvent({ files: [picture], types: ["text/plain", "text/html", "text/rtf", "Files"], text: "A1", html: "<table><tr><td>A1</td></tr></table>" }).clipboardData), []);
    assert.deepEqual(pastedFiles(pasteEvent({ files: [picture], types: ["text/html", "Files"], html: "<p>Copied words</p>" }).clipboardData), []);
    assert.deepEqual(pastedFiles(pasteEvent({ files: [picture], types: ["text/html", "Files"], html: "<meta charset='utf-8'><img src='https://example.com/a.png'>" }).clipboardData), [picture]);
    await settle();
    assert.equal(server.calls.length, 0);
  } finally {
    await act(async () => editor.destroy());
    server.restore();
  }
});

function dropEvent(files: File[]) {
  const event = new window.Event("drop", { bubbles: true, cancelable: true }) as unknown as DragEvent;
  Object.defineProperty(event, "dataTransfer", { value: { files, types: ["Files"], getData: () => "" } });
  Object.defineProperty(event, "clientX", { value: 10 });
  Object.defineProperty(event, "clientY", { value: 10 });
  return event;
}

test("dropping files uploads each in order where they were dropped", async () => {
  const server = serve({});
  const editor = makeEditor("<p>One</p><p>Two</p>");
  try {
    // jsdom has no layout; the drop lands at the start of the second paragraph.
    editor.view.posAtCoords = () => ({ pos: 6, inside: -1 });
    const event = dropEvent([new File(["a"], "a.pdf"), new File(["b"], "b.csv")]);
    const handled = editor.view.someProp("handleDrop", (handle) => handle(editor.view, event, Slice.empty, false));
    assert.equal(handled, true);
    assert.equal(event.defaultPrevented, true);
    assert.equal(editor.view.dom.querySelectorAll(".file-upload-placeholder").length, 2);
    await settle(() => fileMentions(editor).length === 2);
    assert.deepEqual(fileMentions(editor).map((mention) => mention.label), ["a.pdf", "b.csv"]);
    assert.equal(editor.getJSON().content![1]!.content!.at(-1)?.text, " Two");
    assert.equal(editor.view.someProp("handleDrop", (handle) => handle(editor.view, dropEvent([]), Slice.empty, false)) ?? false, false);
  } finally {
    await act(async () => editor.destroy());
    server.restore();
  }
});

test("read-only pages do not take drops or pastes", async () => {
  const server = serve({});
  const editor = makeEditor("<p>Shared</p>");
  try {
    editor.setEditable(false);
    const file = new File(["a"], "a.pdf");
    assert.equal(editor.view.someProp("handlePaste", (handle) => handle(editor.view, pasteEvent({ files: [file], types: ["Files"] }), Slice.empty)) ?? false, false);
    assert.equal(editor.view.someProp("handleDrop", (handle) => handle(editor.view, dropEvent([file]), Slice.empty, false)) ?? false, false);
    await settle();
    assert.equal(server.calls.length, 0);
  } finally {
    await act(async () => editor.destroy());
    server.restore();
  }
});

test("a refused upload says why in a toast and leaves no placeholder", async () => {
  const server = serve({}, () => json({ error: "Hosted Ensemble keeps up to 10 files. Remove one in Files to add more." }, 403));
  const toasts: string[] = [];
  bindToast((text) => toasts.push(text));
  const editor = makeEditor("<p>Hi</p>");
  try {
    editor.commands.setTextSelection(3);
    editor.view.dom.dispatchEvent(pasteEvent({ files: [new File(["a"], "a.pdf"), new File(["b"], "b.pdf")], types: ["Files"] }));
    await settle(() => server.calls.length === 2 && !editor.view.dom.querySelector(".file-upload-placeholder"));
    assert.deepEqual(toasts, ["Could not upload a.pdf. Hosted Ensemble keeps up to 10 files. Remove one in Files to add more."]);
    assert.equal(editor.view.dom.querySelector(".file-upload-placeholder"), null);
    assert.equal(fileMentions(editor).length, 0);
  } finally {
    bindToast(null);
    await act(async () => editor.destroy());
    server.restore();
  }
});
