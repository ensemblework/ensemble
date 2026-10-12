import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as XLSX from "xlsx";
import type { FileRecord, SheetPatch } from "@ensemble/shared-types";
import { bindToast } from "@/lib/toast-bus";
import { FilePreview } from "./file-preview.js";

Object.defineProperty(globalThis, "self", { configurable: true, value: window });
class Observer {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: Observer });
Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: Observer });

type Call = { method: string; url: URL; body: unknown };

function record(id: string, filename: string, more: Partial<FileRecord> = {}): FileRecord {
  return {
    id,
    filename,
    mediaType: "text/csv",
    byteSize: 400,
    format: filename.split(".").pop() ?? "",
    kind: "sheet",
    sha256: `sha-${id}`,
    textStatus: "ready",
    textCharacters: 400,
    pageCount: 1,
    warnings: [],
    summary: null,
    source: null,
    hasStyle: false,
    createdAt: "2026-10-10T09:00:00.000Z",
    updatedAt: "2026-10-10T09:00:00.000Z",
    ...more,
  };
}

async function mount(node: React.ReactNode, files: Record<string, { file: FileRecord; bytes: Uint8Array }>, onWrite?: (call: Call) => unknown) {
  const calls: Call[] = [];
  const toasts: string[] = [];
  bindToast((text) => void toasts.push(text));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { method: init?.method ?? "GET", url: new URL(String(input), "http://localhost"), body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    const match = /^\/api\/documents\/([^/]+)(\/original)?$/.exec(call.url.pathname);
    if (call.method === "GET" && match && files[match[1]!]) {
      const entry = files[match[1]!]!;
      return match[2] ? new Response(entry.bytes.slice().buffer as ArrayBuffer, { status: 200 }) : new Response(JSON.stringify({ file: entry.file }), { status: 200 });
    }
    const answer = onWrite?.(call);
    if (answer !== undefined) return new Response(JSON.stringify(answer), { status: 200 });
    return new Response(JSON.stringify({ error: `not mocked: ${call.method} ${call.url.pathname}` }), { status: 404 });
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return {
    calls,
    toasts,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
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
    if (Date.now() > until) throw new Error(`Timed out waiting for ${label}; page says: ${text().slice(0, 600)}`);
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

async function fire(node: Element, event: Event) {
  await act(async () => {
    node.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

const click = (node: Element) => fire(node, new MouseEvent("click", { bubbles: true, cancelable: true }));
const key = (node: Element, name: string) => fire(node, new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
const cell = (row: number, col: number) => document.querySelectorAll(`[data-row="${row}"] td`)[col]!;

async function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const CSV = ["Name,Hours", ...Array.from({ length: 20 }, (_, index) => `Person ${index + 1},${index + 1}`)].join("\n") + "\n";

test("a compact spreadsheet shows its first rows, read-only, with the sheet's size", async () => {
  const view = await mount(<FilePreview fileId="c1" compact height={240} />, { c1: { file: record("c1", "Hours.csv"), bytes: new TextEncoder().encode(CSV) } });
  try {
    await waitFor(() => Boolean(document.querySelector("[data-sheet-compact]")), "the compact sheet");
    assert.equal((document.querySelector("[data-file-preview]") as HTMLElement).style.height, "240px");
    assert.match(document.querySelector("[data-sheet-compact]")!.textContent ?? "", /Sheet1\s*·\s*21 rows/);
    assert.equal(cell(0, 0).textContent, "Name");
    assert.ok(!document.querySelector('[data-row="15"]'), "only the first 15 rows");
    assert.ok(!/Edit/.test(text()), "no editing inside a page");
  } finally {
    await view.done();
  }
});

test("editing a CSV and saving writes the text back in place", async () => {
  let saved: string | null = null;
  const view = await mount(<FilePreview fileId="c2" />, { c2: { file: record("c2", "Hours.csv"), bytes: new TextEncoder().encode("Name,Hours\nMira,12\nSam,8\n") } }, (call) => {
    if (call.method === "PUT" && call.url.pathname === "/api/documents/c2/content") {
      saved = Buffer.from((call.body as { dataBase64: string }).dataBase64, "base64").toString("utf8");
      return { file: record("c2", "Hours.csv", { sha256: "sha-c2-v2" }) };
    }
    return undefined;
  });
  try {
    await waitFor(() => Boolean(document.querySelector("[data-sheet-viewer]")), "the sheet");
    await click(button(/^Edit$/));
    const grid = document.querySelector("[data-sheet-grid]")!;
    await fire(cell(1, 1), new MouseEvent("mousedown", { bubbles: true }));
    await key(grid, "1");
    const input = document.querySelector<HTMLInputElement>("[data-sheet-grid] input")!;
    await typeInto(input, "14");
    await key(input, "Enter");
    assert.equal(cell(1, 1).textContent, "14");
    await click(button(/Add row/));
    await key(grid, "L");
    await typeInto(document.querySelector<HTMLInputElement>("[data-sheet-grid] input")!, "Lee");
    await key(document.querySelector<HTMLInputElement>("[data-sheet-grid] input")!, "Enter");
    assert.match(text(), /Unsaved changes/);
    await click(button(/^Save$/));
    await waitFor(() => saved !== null, "the save");
    assert.equal(saved, "Name,Hours\nMira,14\nSam,8\nLee\n");
    await waitFor(() => view.toasts.includes("Saved Hours.csv."), "the saved toast");
  } finally {
    await view.done();
  }
});

test("Excel edits are saved as a cell patch so the file keeps its formatting", async () => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["Item", "Cost"], ["Seeds", 12], ["Soil", 30]]), "Budget");
  const bytes = new Uint8Array(XLSX.write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
  let patch: SheetPatch | null = null;
  const view = await mount(
    <FilePreview fileId="x1" />,
    { x1: { file: record("x1", "Budget.xlsx", { mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), bytes } },
    (call) => {
      if (call.method === "POST" && call.url.pathname === "/api/documents/x1/cells") {
        patch = call.body as SheetPatch;
        return { file: record("x1", "Budget.xlsx", { sha256: "sha-x1-v2" }) };
      }
      return undefined;
    },
  );
  try {
    await waitFor(() => Boolean(document.querySelector("[data-sheet-viewer]")), "the workbook");
    assert.equal(cell(1, 1).textContent, "12");
    await click(button(/^Edit$/));
    const grid = document.querySelector("[data-sheet-grid]")!;
    await fire(cell(2, 0), new MouseEvent("mousedown", { bubbles: true }));
    await click(button(/Delete row/));
    await fire(cell(1, 1), new MouseEvent("mousedown", { bubbles: true }));
    await key(grid, "1");
    await typeInto(document.querySelector<HTMLInputElement>("[data-sheet-grid] input")!, "15");
    await key(document.querySelector<HTMLInputElement>("[data-sheet-grid] input")!, "Enter");
    await click(button(/^Save$/));
    await waitFor(() => patch !== null, "the patch");
    assert.deepEqual(patch, { sheets: [{ name: "Budget", set: [{ row: 2, col: 2, value: 15 }], deleteRows: [3] }] });
  } finally {
    await view.done();
  }
});

test("code shows with line numbers and its language; formats Ensemble cannot show get a details card", async () => {
  const view = await mount(
    <>
      <FilePreview fileId="t1" />
      <FilePreview fileId="d1" />
    </>,
    {
      t1: { file: record("t1", "harvest.py", { kind: "code", mediaType: "text/plain" }), bytes: new TextEncoder().encode("def total(rows):\n    return sum(rows)\n") },
      d1: { file: record("d1", "Old minutes.doc", { kind: "document", mediaType: "application/msword", byteSize: 52_000 }), bytes: new Uint8Array() },
    },
  );
  try {
    await waitFor(() => Boolean(document.querySelector("[data-file-text]")), "the code");
    const code = document.querySelector('[data-file-text="t1"]')!;
    assert.match(code.textContent ?? "", /Python · python · 2 lines/);
    assert.equal(code.querySelector("pre[aria-hidden]")?.textContent, "1\n2");
    assert.equal(code.querySelector("pre[data-language]")?.getAttribute("data-language"), "python");
    const details = document.querySelector('[data-file-details="d1"]')!;
    assert.match(details.textContent ?? "", /Word 97–2003 document · 51 KB/);
    assert.match(details.textContent ?? "", /save it as \.docx to preview it here/);
    assert.ok(!view.calls.some((call) => call.url.pathname === "/api/documents/d1/original"), "no bytes are fetched for a details card");
  } finally {
    await view.done();
  }
});
