/** @jsxRuntime automatic */
/** @jsxImportSource react */
import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { strToU8, zipSync } from "fflate";
import type { FileRecord } from "@ensemble/shared-types";
import { bindToast } from "@/lib/toast-bus";
import { FileScreen } from "./file-screen.js";

Object.defineProperty(globalThis, "self", { configurable: true, value: window });
Object.defineProperty(globalThis, "DOMParser", { configurable: true, value: window.DOMParser });
// Some components on the screen use the classic JSX runtime.
(globalThis as { React?: typeof React }).React = React;
class Observer {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: Observer });
Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: Observer });

const router = { push() {}, replace() {}, prefetch() {}, back() {}, forward() {}, refresh() {} };

function record(id: string, filename: string, more: Partial<FileRecord> = {}): FileRecord {
  return {
    id,
    filename,
    mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    byteSize: 4000,
    format: filename.split(".").pop() ?? "",
    kind: "slides",
    sha256: `sha-${id}`,
    textStatus: "ready",
    textCharacters: 40,
    pageCount: 4,
    warnings: [],
    summary: null,
    source: null,
    hasStyle: false,
    createdAt: "2026-10-12T09:00:00.000Z",
    updatedAt: "2026-10-12T09:00:00.000Z",
    ...more,
  };
}

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const rels = (items: Array<[string, string, string]>) =>
  `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join("")}</Relationships>`;
const slide = (text: string, hidden = false) =>
  `<?xml version="1.0"?><p:sld ${NS}${hidden ? ' show="0"' : ""}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Text"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="6000000" cy="1000000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;

/** Four slides; the third is hidden in the slideshow. */
function deck(): Uint8Array {
  const titles = ["Harvest plan", "Seed budget", "Old numbers", "Next steps"];
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    "_rels/.rels": strToU8(rels([["rId1", "officeDocument", "ppt/presentation.xml"]])),
    "ppt/presentation.xml": strToU8(
      `<?xml version="1.0"?><p:presentation ${NS}><p:sldIdLst>${titles.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`).join("")}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
    ),
    "ppt/_rels/presentation.xml.rels": strToU8(rels([["rId1", "slideMaster", "slideMasters/slideMaster1.xml"], ...titles.map((_, index) => [`rId${index + 2}`, "slide", `slides/slide${index + 1}.xml`] as [string, string, string])])),
    "ppt/slideMasters/slideMaster1.xml": strToU8(`<?xml version="1.0"?><p:sldMaster ${NS}><p:cSld><p:spTree/></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2"/></p:sldMaster>`),
    "ppt/slideLayouts/slideLayout1.xml": strToU8(`<?xml version="1.0"?><p:sldLayout ${NS}><p:cSld><p:spTree/></p:cSld></p:sldLayout>`),
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels": strToU8(rels([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]])),
  };
  titles.forEach((title, index) => {
    files[`ppt/slides/slide${index + 1}.xml`] = strToU8(slide(title, index === 2));
    files[`ppt/slides/_rels/slide${index + 1}.xml.rels`] = strToU8(rels([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"]]));
  });
  return zipSync(files);
}

async function mount(id: string, files: Record<string, { file: FileRecord; bytes: Uint8Array }>) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const match = /^\/api\/documents\/([^/]+)(\/original)?$/.exec(path);
    const entry = match ? files[match[1]!] : undefined;
    if (entry) return match![2] ? new Response(entry.bytes.slice().buffer as ArrayBuffer, { status: 200 }) : new Response(JSON.stringify({ file: entry.file }), { status: 200 });
    return new Response(JSON.stringify({ error: `not mocked: ${path}` }), { status: 404 });
  }) as typeof fetch;
  bindToast(() => undefined);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  // Stands in for the sidebar and top bar: the rest of the app the layer covers.
  const chrome = document.createElement("nav");
  document.body.appendChild(chrome);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <AppRouterContext.Provider value={router as never}>
        <QueryClientProvider client={client}>
          <FileScreen id={id} />
        </QueryClientProvider>
      </AppRouterContext.Provider>,
    );
  });
  return {
    chrome,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
      chrome.remove();
      client.clear();
      globalThis.fetch = realFetch;
      bindToast(null);
    },
  };
}

const text = () => document.body.textContent ?? "";

async function waitFor(check: () => boolean, label: string, timeout = 4000) {
  const until = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${label}; page says: ${text().slice(0, 500)}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  }
}

function button(label: RegExp): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find((node) => label.test((node.textContent ?? "").trim()) || label.test(node.getAttribute("aria-label") ?? ""));
  assert.ok(found, `Missing button ${label}; page says: ${text().slice(0, 400)}`);
  return found as HTMLButtonElement;
}

async function fire(node: EventTarget, event: Event) {
  await act(async () => {
    node.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

const click = (node: Element, clientX = 0) => fire(node, new MouseEvent("click", { bubbles: true, cancelable: true, clientX }));
const press = (key: string, extra: KeyboardEventInit = {}) => fire(document.activeElement ?? document.body, new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra }));
const presenter = () => document.querySelector<HTMLElement>("[data-presenter]");
const counter = () => presenter()?.querySelector("[aria-live]")?.textContent?.replace(/\s+/g, " ").trim();
const onScreen = () => presenter()?.querySelector('[data-current="true"]')?.textContent ?? "";

/** A browser that grants fullscreen: the request and exit flip `document.fullscreenElement` and fire the event. */
function grantFullscreen() {
  let element: Element | null = null;
  const calls: string[] = [];
  const change = () => document.dispatchEvent(new Event("fullscreenchange"));
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => element });
  Object.defineProperty(document.documentElement, "requestFullscreen", {
    configurable: true,
    value: async function (this: Element) {
      calls.push(`request:${this.tagName.toLowerCase()}`);
      element = this;
      change();
    },
  });
  Object.defineProperty(document, "exitFullscreen", {
    configurable: true,
    value: async () => {
      calls.push("exit");
      element = null;
      change();
    },
  });
  return {
    calls,
    /** The person pressed Esc (or the browser's own control) and the browser left fullscreen. */
    leaveFromBrowser: () => {
      element = null;
      change();
    },
    restore: () => {
      delete (document as { fullscreenElement?: unknown }).fullscreenElement;
      delete (document.documentElement as { requestFullscreen?: unknown }).requestFullscreen;
      delete (document as { exitFullscreen?: unknown }).exitFullscreen;
    },
  };
}

test("Present shows one slide at a time over the page, the slideshow keys move, and Esc stops where it was", async () => {
  assert.equal(typeof document.documentElement.requestFullscreen, "undefined", "this browser has no Fullscreen API, so the overlay alone is the mode");
  const view = await mount("s1", { s1: { file: record("s1", "Harvest.pptx"), bytes: deck() } });
  try {
    await waitFor(() => Boolean(document.querySelector("[data-pptx-viewer]")) && !button(/^Present$/).disabled, "the slides");
    // Start from the second slide in the viewer.
    await click(button(/^Slide 2$/));
    const present = button(/^Present$/);
    await click(present);
    assert.ok(presenter(), "the presentation covers the screen");
    assert.equal(presenter()!.parentElement, document.body);
    assert.equal(view.chrome.inert, true, "the rest of the app is inert while presenting");
    assert.equal(document.body.style.overflow, "hidden");
    assert.equal(document.activeElement, presenter(), "focus moves into the presentation");
    // Three of the four slides show: the hidden one is skipped, as in PowerPoint.
    assert.equal(counter(), "2 / 3");
    assert.match(onScreen(), /Seed budget/);
    assert.ok(presenter()!.querySelector('[data-present-item="2"]'), "the next slide is drawn ahead");

    await press("ArrowRight");
    assert.equal(counter(), "3 / 3");
    assert.match(onScreen(), /Next steps/);
    await press(" ");
    assert.equal(counter(), "3 / 3", "the last slide stays");
    await press("ArrowLeft");
    assert.equal(counter(), "2 / 3");
    await press("Home");
    assert.equal(counter(), "1 / 3");
    await press("n");
    await press("PageDown");
    assert.equal(counter(), "3 / 3");
    await press("Backspace");
    assert.equal(counter(), "2 / 3");
    await press("p");
    assert.equal(counter(), "1 / 3");
    await press("End");
    assert.equal(counter(), "3 / 3");
    await press("ArrowUp");
    await press("Enter");
    assert.equal(counter(), "3 / 3");
    // Clicks: the left third goes back, the rest goes forward.
    await click(presenter()!, 40);
    assert.equal(counter(), "2 / 3");
    await click(presenter()!, window.innerWidth - 40);
    assert.equal(counter(), "3 / 3");
    await click(presenter()!.querySelector('[aria-label="Previous slide"]')!);
    assert.equal(counter(), "2 / 3");

    await press("Escape");
    assert.equal(presenter(), null, "Esc stops presenting");
    assert.equal(view.chrome.inert, false);
    assert.equal(document.body.style.overflow, "");
    assert.equal(document.activeElement, present, "focus is back on Present");
    const current = document.querySelector('[data-thumb][aria-current="true"]');
    assert.equal(current?.getAttribute("aria-label"), "Slide 2", "the viewer opens at the slide the presentation stopped on");
  } finally {
    await view.done();
  }
});

test("with the browser's fullscreen: asked for on the whole document, F steps out and back, and leaving it from the browser stops presenting", async () => {
  const browser = grantFullscreen();
  const view = await mount("s2", { s2: { file: record("s2", "Plan.pptx"), bytes: deck() } });
  try {
    await waitFor(() => Boolean(document.querySelector("[data-pptx-viewer]")) && !button(/^Present$/).disabled, "the slides");
    await click(button(/^Present$/));
    assert.deepEqual(browser.calls, ["request:html"]);
    assert.ok(presenter());
    assert.equal(counter(), "1 / 3");
    await press("f");
    assert.deepEqual(browser.calls, ["request:html", "exit"]);
    assert.ok(presenter(), "F leaves the browser's fullscreen but keeps presenting");
    await press("F");
    assert.deepEqual(browser.calls, ["request:html", "exit", "request:html"]);
    await press("ArrowRight");
    assert.equal(counter(), "2 / 3");
    await act(async () => browser.leaveFromBrowser());
    assert.equal(presenter(), null, "leaving the browser's fullscreen stops presenting too");

    await click(button(/^Present$/));
    await click(button(/^Stop presenting$/));
    assert.equal(presenter(), null);
    assert.equal(browser.calls.at(-1), "exit", "stopping leaves the browser's fullscreen");
  } finally {
    await view.done();
    browser.restore();
  }
});

test("Full screen shows the same preview over the whole screen, and Esc puts it back", async () => {
  const code = "def total(rows):\n    return sum(rows)\n";
  const view = await mount("t1", { t1: { file: record("t1", "harvest.py", { kind: "code", mediaType: "text/plain", pageCount: null }), bytes: new TextEncoder().encode(code) } });
  try {
    await waitFor(() => Boolean(document.querySelector("[data-file-text]")), "the code");
    assert.ok(!Array.from(document.querySelectorAll("button")).some((node) => node.textContent?.trim() === "Present"), "only PDFs and slides present");
    const viewer = document.querySelector("[data-file-text]");
    const open = button(/^Full screen$/);
    await click(open);
    const layer = document.querySelector<HTMLElement>('[data-file-full-screen="true"]');
    assert.ok(layer, "the preview fills the screen");
    assert.match(layer!.className, /fixed inset-0/);
    assert.match(layer!.textContent ?? "", /harvest\.py/);
    assert.equal(document.querySelector("[data-file-text]"), viewer, "the viewer is the same one, not a second copy");
    assert.equal(view.chrome.inert, true);
    assert.equal(document.querySelector("header")?.inert, true, "the file's own header is behind the layer");
    await press("Escape");
    assert.equal(document.querySelector('[data-file-full-screen="true"]'), null);
    assert.equal(document.querySelector("[data-file-text]"), viewer);
    assert.equal(document.activeElement, open, "focus is back on Full screen");
    assert.equal(view.chrome.inert, false);
  } finally {
    await view.done();
  }
});
