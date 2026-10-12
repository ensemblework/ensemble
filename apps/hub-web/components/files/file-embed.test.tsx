/** @jsxRuntime automatic */
/** @jsxImportSource react */
import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { QueryClient } from "@tanstack/react-query";
import type { FileRecord } from "@ensemble/shared-types";
import { SHARE_HEADER, setOpenShare } from "@/lib/api";
import { mountFileCard } from "./file-embed";

Object.defineProperty(globalThis, "self", { configurable: true, value: window });

// gcTime Infinity: no garbage-collection timers left behind to keep the test process alive.
const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
test.afterEach(() => client.clear());

const sheet: FileRecord = {
  id: "file-1",
  filename: "budget.xlsx",
  mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  byteSize: 3 * 1024 * 1024,
  format: "xlsx",
  kind: "sheet",
  sha256: "0".repeat(64),
  textStatus: "ready",
  textCharacters: 100,
  pageCount: 2,
  warnings: [],
  summary: null,
  source: null,
  hasStyle: false,
  createdAt: "2026-10-12T09:00:00.000Z",
  updatedAt: "2026-10-12T09:00:00.000Z",
};

function serve(status = 200) {
  const headers: Array<Record<string, string>> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    headers.push({ ...(init?.headers as Record<string, string>) });
    const path = new URL(String(input), "http://localhost").pathname;
    const body = path === "/api/documents/file-1" && status === 200 ? { file: sheet } : { error: "Not found" };
    return new Response(JSON.stringify(body), { status: path === "/api/documents/file-1" ? status : 404, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { headers, restore: () => (globalThis.fetch = original) };
}

async function mount(options: Parameters<typeof mountFileCard>[3] = {}) {
  const host = document.createElement("span");
  document.body.append(host);
  let card: ReturnType<typeof mountFileCard> | null = null;
  await act(async () => {
    card = mountFileCard(host, "file-1", "budget.xlsx", { client, ...options });
  });
  for (let index = 0; index < 20 && !host.textContent?.match(/MB|removed/); index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
    });
  }
  return {
    host,
    card: card!,
    stop: async () => {
      await act(async () => card?.destroy());
      host.remove();
    },
  };
}

test("an editable card shows the file and resizes its height, which the page stores", async () => {
  const server = serve();
  const committed: number[] = [];
  const { host, card, stop } = await mount({ height: 240, onResize: (height) => committed.push(height) });
  try {
    assert.match(host.textContent ?? "", /budget\.xlsx/);
    assert.match(host.textContent ?? "", /Excel workbook · 3\.0 MB/);
    assert.equal(host.querySelector("a")?.getAttribute("href"), "/files/file-1");
    assert.ok(host.querySelector(".file-embed-body"));
    const handle = host.querySelector<HTMLElement>("[role='separator']")!;
    assert.equal(handle.getAttribute("aria-valuenow"), "240");
    await act(async () => {
      handle.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    assert.deepEqual(committed, [264]);
    await act(async () => card.setHeight(400));
    const next = host.querySelector<HTMLElement>("[role='separator']")!;
    next.dispatchEvent(new window.FocusEvent("focus"));
    assert.equal(next.getAttribute("aria-valuenow"), "400");
  } finally {
    await stop();
    server.restore();
  }
});

test("a read-only card still previews, without a resize handle", async () => {
  const server = serve();
  const { host, stop } = await mount({ height: 240 });
  try {
    assert.ok(host.querySelector(".file-embed-body"));
    assert.equal(host.querySelector("[role='separator']"), null);
  } finally {
    await stop();
    server.restore();
  }
});

test("on a shared page the card reads the file under the share and offers a download instead of /files", async () => {
  const server = serve();
  setOpenShare("share-1");
  const { host, stop } = await mount();
  try {
    assert.equal(server.headers[0]?.[SHARE_HEADER], "share-1");
    assert.equal(host.querySelector("a[href^='/files']"), null);
    assert.match([...host.querySelectorAll("button")].map((button) => button.textContent).join(" "), /Download/);
  } finally {
    setOpenShare(null);
    await stop();
    server.restore();
  }
});

test("a deleted file says so and keeps the rest of the page", async () => {
  const server = serve(404);
  const { host, stop } = await mount({ onResize: () => undefined });
  try {
    assert.match(host.textContent ?? "", /budget\.xlsx/);
    assert.match(host.textContent ?? "", /This file was removed\./);
    assert.equal(host.querySelector(".file-embed-body"), null);
    assert.equal(host.querySelector("[role='separator']"), null);
  } finally {
    await stop();
    server.restore();
  }
});
