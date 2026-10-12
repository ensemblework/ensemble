import assert from "node:assert/strict";
import test from "node:test";
import type { PageDocument } from "@ensemble/shared-types";
import { appendFileMention, attachFileToPage } from "./attach.js";

const FILE = { id: "file-1", filename: "Lease.pdf" };
const mention = { type: "mention", attrs: { kind: "file", id: "file-1", label: "Lease.pdf" } };

test("the file is added as a mention at the end of the page, replacing a trailing empty line", () => {
  const doc: PageDocument = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Notes" }] }, { type: "paragraph" }] };
  assert.deepEqual(appendFileMention(doc, FILE), { type: "doc", content: [doc.content[0]!, { type: "paragraph", content: [mention] }] });
  assert.deepEqual(appendFileMention(null, FILE), { type: "doc", content: [{ type: "paragraph", content: [mention] }] });
});

test("a page that already has the file is left alone", () => {
  const doc: PageDocument = { type: "doc", content: [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [mention] }] }] }] };
  assert.equal(appendFileMention(doc, FILE), null);
});

test("a save that loses a revision race reloads the page and tries again", async () => {
  const realFetch = globalThis.fetch;
  const saves: Array<{ revision: number; content: PageDocument }> = [];
  let revision = 4;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/pages/page-1" && (init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify({ id: "page-1", title: "Plan", taskId: null, revision, content: { type: "doc", content: [] }, notes: "", updatedAt: null }), { status: 200 });
    }
    if (url.pathname === "/api/pages/page-1" && init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { revision: number; content: PageDocument };
      saves.push(body);
      if (saves.length === 1) {
        revision = 5;
        return new Response(JSON.stringify({ error: "This page changed elsewhere." }), { status: 409 });
      }
      return new Response(JSON.stringify({ id: "page-1", revision: 6 }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  try {
    assert.equal(await attachFileToPage({ kind: "page", id: "page-1", title: "Plan" }, FILE), "attached");
    assert.deepEqual(saves.map((save) => save.revision), [4, 5]);
    assert.deepEqual(saves[1]!.content, { type: "doc", content: [{ type: "paragraph", content: [mention] }] });
  } finally {
    globalThis.fetch = realFetch;
  }
});
