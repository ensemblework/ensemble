/** @jsxRuntime automatic */
/** @jsxImportSource react */
import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { QueryClient } from "@tanstack/react-query";
import { Editor, type JSONContent } from "@tiptap/core";
import { Slice } from "@tiptap/pm/model";
import type { FileRecord } from "@ensemble/shared-types";
import { testPng } from "@ensemble/shared-types/page-images-testing";
import { setOpenShare } from "@/lib/api";
import { bindToast, type ToastOptions } from "@/lib/toast-bus";
import { applyBlock, matchCommands } from "./editor-commands";
import { editorExtensions } from "./extensions";

Object.defineProperty(globalThis, "self", { configurable: true, value: window });

type Call = { method: string; url: string; body: Record<string, unknown> | undefined; headers: Record<string, string> };

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function record(id: string, filename: string): FileRecord {
  return {
    id,
    filename,
    mediaType: "image/png",
    byteSize: 100,
    format: "png",
    kind: "image",
    sha256: "a".repeat(64),
    textStatus: "none",
    textCharacters: 0,
    pageCount: null,
    warnings: [],
    summary: null,
    source: null,
    hasStyle: false,
    createdAt: "2026-10-12T09:00:00.000Z",
    updatedAt: "2026-10-12T09:00:00.000Z",
  };
}

/** Uploads answer as the API does for page images; originals come from `originals`; the rest is 404. */
function serve(options: { upload?: (body: Record<string, unknown>) => Response; originals?: Record<string, Uint8Array> } = {}) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  let uploads = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string> | undefined) ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
    calls.push({ method: init?.method ?? "GET", url, body, headers });
    const path = new URL(url, "http://localhost").pathname;
    if (path === "/api/documents" && init?.method === "POST") {
      if (options.upload) return options.upload(body!);
      uploads += 1;
      const file = record(`img-${uploads}`, String(body!.filename));
      return json(body!.purpose === "page-image" ? { file, image: { format: "png", width: 40, height: 30 } } : { file }, 201);
    }
    const bytes = path.match(/^\/api\/documents\/([^/]+)\/original$/);
    const found = bytes ? options.originals?.[decodeURIComponent(bytes[1]!)] : undefined;
    if (found) {
      if (headers["if-none-match"] === '"sha-1"') return new Response(null, { status: 304 });
      return new Response(found as BodyInit, { status: 200, headers: { "Content-Type": "image/png", "Content-Length": String(found.length), ETag: '"sha-1"' } });
    }
    return json({ error: "File not found." }, 404);
  }) as typeof fetch;
  return { calls, posts: () => calls.filter((call) => call.method === "POST"), restore: () => (globalThis.fetch = original) };
}

const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });

function makeEditor(content: JSONContent | string, picked: File[] = [], editable = true) {
  let editor!: Editor;
  act(() => {
    editor = new Editor({
      editable,
      extensions: editorExtensions(() => [], "Type", () => true, () => true, { client: () => client, pickImages: (_accept, done) => done(picked) }),
      content,
    });
  });
  return editor;
}

async function settle(until: () => boolean = () => false) {
  for (let index = 0; index < 60 && !until(); index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
    });
  }
}

async function done(editor: Editor) {
  await act(async () => editor.destroy());
}

function images(editor: Editor) {
  const found: Array<Record<string, unknown>> = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === "image") found.push({ ...node.attrs });
  });
  return found;
}

function toasts() {
  const seen: Array<{ text: string; options?: ToastOptions }> = [];
  bindToast((text, options) => seen.push({ text, options }));
  return seen;
}

const png = (name: string, bytes = testPng(40, 30)) => new File([bytes as BlobPart], name, { type: "image/png" });

test("/image opens the picker and the image lands where the command was, as one undoable step", async () => {
  for (const word of ["image", "photo", "picture", "screenshot", "png"]) assert.equal(matchCommands(word)[0]?.id, "image", word);
  const server = serve();
  const editor = makeEditor("<p>Intro</p><p>/image</p>", [png("site.png")]);
  try {
    applyBlock(editor, { from: 8, to: 14 }, "image");
    assert.equal(editor.view.dom.querySelector(".image-upload-placeholder [role='progressbar']")?.getAttribute("aria-label"), "Uploading site.png");
    await settle(() => images(editor).length > 0);
    const [post] = server.posts();
    assert.equal(post?.body?.purpose, "page-image");
    assert.equal(post?.body?.filename, "site.png");
    assert.equal(post?.body?.mediaType, "image/png");
    assert.deepEqual(images(editor), [{ src: null, alt: "", fileId: "img-1", width: null, align: "center", naturalWidth: 40, naturalHeight: 30 }]);
    assert.deepEqual(editor.getJSON().content!.map((node) => node.type), ["paragraph", "image"], "the empty line the command left became the image");
    assert.equal(editor.view.dom.querySelector(".image-upload-placeholder"), null);
    editor.commands.undo();
    assert.deepEqual(images(editor), [], "one undo takes the image back out");
    assert.equal(editor.getText().startsWith("Intro"), true);
  } finally {
    await done(editor);
    server.restore();
  }
});

test("dropped and pasted images land as images, other files as cards", async () => {
  const server = serve();
  const editor = makeEditor("<p>One</p><p>Two</p>");
  try {
    // jsdom has no layout: the drop lands at the end of "One".
    editor.view.posAtCoords = () => ({ pos: 4, inside: -1 });
    const drop = new window.Event("drop", { bubbles: true, cancelable: true }) as unknown as DragEvent;
    Object.defineProperty(drop, "dataTransfer", { value: { files: [png("site.png"), new File(["%PDF-1.7"], "brief.pdf", { type: "application/pdf" })], types: ["Files"], getData: () => "" } });
    const handled = editor.view.someProp("handleDrop", (handle) => handle(editor.view, drop, Slice.empty, false));
    assert.equal(handled, true);
    await settle(() => server.posts().length === 2 && JSON.stringify(editor.getJSON()).includes('"kind":"file"'));
    assert.deepEqual(server.posts().map((post) => post.body!.purpose ?? "file"), ["page-image", "file"]);
    const blocks = editor.getJSON().content!;
    assert.deepEqual(blocks.map((node) => node.type), ["paragraph", "image", "paragraph"], "an image dropped at the end of a line goes below it");
    assert.deepEqual(blocks[0]!.content!.map((node) => node.text ?? node.attrs?.label), ["One", "brief.pdf", " "], "a file card stays in the line");

    editor.commands.setTextSelection(1);
    const paste = new window.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { files: [png("image.png")], types: ["Files"], getData: () => "" } });
    editor.view.dom.dispatchEvent(paste);
    await settle(() => images(editor).length === 2);
    assert.deepEqual(editor.getJSON().content!.map((node) => node.type), ["image", "paragraph", "image", "paragraph"], "a screenshot pasted at the start of a line goes before it");
  } finally {
    await done(editor);
    server.restore();
  }
});

test("upload progress shows as a percentage while the image is sent", async () => {
  const server = serve();
  const sent: Array<{ finish: () => void }> = [];
  class FakeRequest {
    upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
    status = 0;
    responseText = "";
    withCredentials = false;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    headers: Record<string, string> = {};
    open() {}
    setRequestHeader(name: string, value: string) {
      this.headers[name] = value;
    }
    send(body: string) {
      const parsed = JSON.parse(body) as { filename: string };
      this.upload.onprogress?.({ lengthComputable: true, loaded: 42, total: 100 });
      sent.push({
        finish: () => {
          this.status = 201;
          this.responseText = JSON.stringify({ file: record("img-xhr", parsed.filename), image: { format: "png", width: 40, height: 30 } });
          this.onload?.();
        },
      });
    }
  }
  Object.defineProperty(globalThis, "XMLHttpRequest", { configurable: true, writable: true, value: FakeRequest });
  const editor = makeEditor("<p></p>", [png("chart.png")]);
  try {
    editor.commands.chooseImage(1);
    await settle(() => sent.length > 0);
    const placeholder = editor.view.dom.querySelector(".image-upload-placeholder")!;
    assert.match(placeholder.textContent ?? "", /Uploading chart\.png… 42%/);
    assert.equal(placeholder.querySelector("[role='progressbar']")?.getAttribute("aria-valuenow"), "42");
    await act(async () => sent[0]!.finish());
    await settle(() => images(editor).length > 0);
    assert.equal(images(editor)[0]!.fileId, "img-xhr");
  } finally {
    delete (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
    await done(editor);
    server.restore();
  }
});

test("an image over 2 MB, an SVG or another format is refused before sending, with what to do", async () => {
  const server = serve();
  const seen = toasts();
  const atLimit = png("exact.png", testPng(10, 10, 2_097_152));
  const over = png("poster.png", testPng(10, 10, 2_097_153));
  const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg"></svg>'], "logo.svg", { type: "image/svg+xml" });
  const heic = new File([new Uint8Array(64)], "IMG_2041.heic", { type: "image/heic" });
  const editor = makeEditor("<p></p>", [over, svg, heic, atLimit]);
  try {
    editor.commands.chooseImage(1);
    await settle(() => images(editor).length > 0);
    assert.deepEqual(
      seen.map((toast) => toast.text),
      [
        "poster.png is just over 2 MB. Images in pages can be up to 2 MB: make it smaller, or attach it as a file with /file.",
        "logo.svg is an SVG. SVG files can carry scripts, so pages don't show them as images: export it as PNG, or attach it as a file with /file.",
        "IMG_2041.heic isn't a PNG, JPEG, GIF or WebP image. Export it as one of those, or attach it as a file with /file.",
      ],
    );
    assert.equal(server.posts().length, 1, "only the image at exactly 2 MiB was sent");
    assert.equal(server.posts()[0]!.body!.filename, "exact.png");
    assert.equal(seen[0]!.options?.tone, "error");
    // The refusal offers the other way in: as a file card, not compressed.
    assert.equal(seen[0]!.options?.action?.label, "Attach as file");
    await act(async () => seen[0]!.options!.action!.run());
    await settle(() => JSON.stringify(editor.getJSON()).includes('"kind":"file"'));
    const attached = server.posts()[1]!;
    assert.equal(attached.body!.filename, "poster.png");
    assert.equal(attached.body!.purpose, undefined);
  } finally {
    bindToast(null);
    await done(editor);
    server.restore();
  }
});

test("a damaged image and a refusal from the server are told plainly and leave nothing behind", async () => {
  const server = serve({ upload: () => json({ error: "shot.png is named .png but holds a JPEG image. Rename it to .jpg and add it again." }, 415) });
  const seen = toasts();
  const editor = makeEditor("<p></p>", [new File(["not a png"], "broken.png", { type: "image/png" }), png("shot.png")]);
  try {
    editor.commands.chooseImage(1);
    await settle(() => server.posts().length === 1 && !editor.view.dom.querySelector(".image-upload-placeholder"));
    assert.deepEqual(seen.map((toast) => toast.text), [
      "broken.png looks damaged: its image data can't be read. Export or save it again, then add it.",
      "shot.png is named .png but holds a JPEG image. Rename it to .jpg and add it again.",
    ]);
    assert.deepEqual(images(editor), []);
  } finally {
    bindToast(null);
    await done(editor);
    server.restore();
  }
});

function pasteHtml(editor: Editor, html: string) {
  const event = new window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { files: [], types: ["text/html", "text/plain"], getData: (type: string) => (type === "text/html" ? html : "") } });
  editor.view.dom.dispatchEvent(event);
}

test("pasted HTML with data: images uploads them instead of saving their bytes in the page", async () => {
  Object.defineProperty(globalThis, "DOMParser", { configurable: true, writable: true, value: window.DOMParser });
  const server = serve();
  const seen = toasts();
  const editor = makeEditor("<p></p>");
  try {
    const small = Buffer.from(testPng(40, 30)).toString("base64");
    const big = Buffer.from(testPng(10, 10, 2_097_153)).toString("base64");
    editor.commands.setTextSelection(1);
    pasteHtml(editor, `<p>Before</p><img src="data:image/png;base64,${small}" alt="Chart"><p>Middle</p><img src="data:image/png;base64,${big}" alt="Poster"><p>After</p>`);
    assert.equal(JSON.stringify(editor.getJSON()).includes("data:"), false, "no image bytes in the page, even before the upload ends");
    await settle(() => images(editor).length > 0);
    const blocks = editor.getJSON().content!;
    assert.deepEqual(blocks.map((node) => node.type === "image" ? `image:${node.attrs!.alt}` : node.content?.[0]?.text ?? ""), ["Before", "image:Chart", "Middle", "After"]);
    assert.equal(images(editor)[0]!.fileId, "img-1");
    assert.equal(server.posts().length, 1);
    assert.equal(server.posts()[0]!.body!.purpose, "page-image");
    assert.equal(server.posts()[0]!.body!.filename, "pasted-image.png");
    assert.deepEqual(seen.map((toast) => toast.text), ["Poster is just over 2 MB. Images in pages can be up to 2 MB: make it smaller, or attach it as a file with /file."]);
  } finally {
    bindToast(null);
    await done(editor);
    server.restore();
  }
});

test("size, alignment and alt text are node attributes: they survive save, reload and copying as HTML", async () => {
  const server = serve();
  const doc = {
    type: "doc",
    content: [
      { type: "image", attrs: { fileId: "img-9", alt: "North field", width: 60, align: "left", naturalWidth: 1200, naturalHeight: 800 } },
      { type: "image", attrs: { src: "https://example.com/chart.png", alt: "Chart" } },
    ],
  };
  const editor = makeEditor(doc);
  let copy: Editor | null = null;
  try {
    const saved = editor.getJSON();
    assert.deepEqual({ ...saved.content![0]!.attrs }, { src: null, alt: "North field", fileId: "img-9", width: 60, align: "left", naturalWidth: 1200, naturalHeight: 800 });
    assert.deepEqual({ ...saved.content![1]!.attrs }, { src: "https://example.com/chart.png", alt: "Chart", fileId: null, width: null, align: "center", naturalWidth: null, naturalHeight: null }, "an old image keeps its address");
    const html = editor.getHTML();
    assert.match(html, /<img alt="North field" data-file-id="img-9" data-width="60" data-align="left" data-natural-width="1200" data-natural-height="800" class="page-image" loading="lazy">/);
    copy = makeEditor(html);
    assert.deepEqual(copy.getJSON(), saved);
    const frame = editor.view.dom.querySelector<HTMLElement>(".page-image-block")!;
    assert.equal(frame.dataset.align, "left");
    assert.equal(frame.querySelector<HTMLElement>(".page-image-box")!.style.width, "60%");
    assert.equal(frame.querySelector("img")!.getAttribute("width"), "1200", "the shape is kept while it loads");
  } finally {
    if (copy) await done(copy);
    await done(editor);
    server.restore();
  }
});

test("the image's controls: width handle by keyboard, alignment, width presets, alt text and remove; none when read-only", async () => {
  const server = serve();
  const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Above" }] }, { type: "image", attrs: { fileId: "img-9", alt: "" } }, { type: "paragraph" }] };
  const editor = makeEditor(doc);
  let readOnly: Editor | null = null;
  const press = (element: Element, key: string) => element.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  const click = (label: string) => editor.view.dom.querySelector<HTMLButtonElement>(`.page-image-toolbar button[aria-label='${label}']`)!.click();
  try {
    const slider = editor.view.dom.querySelector<HTMLElement>(".page-image-handle[role='slider']")!;
    assert.equal(slider.tabIndex, 0);
    assert.equal(slider.getAttribute("aria-label"), "Image width");
    assert.equal(slider.getAttribute("aria-valuemin"), "10");
    press(slider, "ArrowLeft");
    assert.equal(images(editor)[0]!.width, 95, "5% narrower than the full column");
    press(slider, "ArrowLeft");
    press(slider, "ArrowRight");
    assert.equal(images(editor)[0]!.width, 95);
    assert.equal(slider.getAttribute("aria-valuenow"), "95");
    press(slider, "Home");
    assert.equal(images(editor)[0]!.width, 10);
    editor.commands.undo();
    assert.equal(images(editor)[0]!.width, 95, "each resize undoes");

    click("Align left");
    assert.equal(images(editor)[0]!.align, "left");
    assert.equal(editor.view.dom.querySelector(".page-image-toolbar button[aria-label='Align left']")!.getAttribute("aria-pressed"), "true");
    click("Width 50% of the page");
    assert.equal(images(editor)[0]!.width, 50);
    click("Original size, up to the page width");
    assert.equal(images(editor)[0]!.width, null);

    click("Edit alt text");
    const input = editor.view.dom.querySelector<HTMLInputElement>(".page-image-alt input[aria-label='Alt text']")!;
    input.value = "  Soil   sample tray ";
    press(input, "Enter");
    assert.equal(images(editor)[0]!.alt, "Soil sample tray");
    assert.equal(editor.view.dom.querySelector(".page-image-alt"), null);
    assert.equal(slider.getAttribute("aria-label"), "Image width: Soil sample tray");

    click("Remove image");
    assert.deepEqual(images(editor), []);
    assert.equal(editor.getText().trim(), "Above");
    assert.ok(!server.calls.some((call) => call.method === "DELETE"), "the file stays in Files");

    readOnly = makeEditor(doc, [], false);
    assert.ok(readOnly.view.dom.querySelector(".page-image-block img"));
    assert.equal(readOnly.view.dom.querySelector(".page-image-toolbar, .page-image-handle"), null);
    // A page that turns editable gets the controls; one that turns read-only hides them.
    readOnly.setEditable(true);
    const toolbar = readOnly.view.dom.querySelector<HTMLElement>(".page-image-toolbar")!;
    assert.equal(toolbar.hidden, false);
    readOnly.setEditable(false);
    assert.equal(toolbar.hidden, true);
  } finally {
    if (readOnly) await done(readOnly);
    await done(editor);
    server.restore();
  }
});

test("a file-backed image is fetched with the share headers and shown from an object URL; a deleted file says so", async () => {
  const bytes = testPng(40, 30);
  const server = serve({ originals: { "img-1": bytes } });
  const made: Blob[] = [];
  const revoked: string[] = [];
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (blob: Blob) => {
    made.push(blob);
    return `blob:test-${made.length}`;
  };
  URL.revokeObjectURL = (url: string) => void revoked.push(url);
  setOpenShare("share-7");
  const doc = { type: "doc", content: [{ type: "image", attrs: { fileId: "img-1", alt: "Plot" } }, { type: "image", attrs: { fileId: "gone", alt: "Old photo" } }] };
  const editor = makeEditor(doc, [], false);
  let again: Editor | null = null;
  try {
    await settle(() => made.length > 0 && Boolean(editor.view.dom.querySelector(".page-image-broken")));
    const first = server.calls.find((call) => call.url.endsWith("/api/documents/img-1/original"))!;
    assert.equal(first.headers["x-ensemble-share"], "share-7");
    assert.equal(editor.view.dom.querySelector<HTMLImageElement>("img.page-image")!.getAttribute("src"), "blob:test-1");
    assert.equal(made[0]!.size, bytes.length);
    const note = editor.view.dom.querySelector(".page-image-broken")!;
    assert.match(note.textContent ?? "", /Image unavailable: Old photo/);
    assert.match(note.textContent ?? "", /Its file was deleted from Files\./);
    await done(editor);
    assert.deepEqual(revoked, ["blob:test-1"], "the object URL goes with the image");

    again = makeEditor({ type: "doc", content: [doc.content[0]!] }, [], false);
    await settle(() => made.length > 1);
    const second = server.calls.filter((call) => call.url.endsWith("/api/documents/img-1/original")).at(-1)!;
    assert.equal(second.headers["if-none-match"], '"sha-1"', "an unchanged file is not downloaded again");
    assert.equal(made[1], made[0]);
  } finally {
    setOpenShare(null);
    if (again) await done(again);
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
    server.restore();
  }
});
