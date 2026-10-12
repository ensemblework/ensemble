/** @jsxRuntime automatic */
/** @jsxImportSource react */
import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PageDocument } from "@ensemble/shared-types";
import type { PageSourceFile } from "@/lib/api";
import { ExportMenu } from "../export-menu";
import { SourceFileBanner, exportBackItems } from "./source-file-banner";

(globalThis as { React?: typeof React }).React = React;

const doc: PageDocument = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Edited" }] }] };
const page = () => ({ title: "Q3 report", doc });
type Exported = { title: string; doc: PageDocument; fileId: string; format: "pdf" | "docx" };

async function render(node: React.ReactNode): Promise<{ root: Root; host: HTMLDivElement; stop: () => Promise<void> }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return {
    root,
    host,
    stop: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const buttons = (host: ParentNode) => [...host.querySelectorAll("button")].map((button) => button.textContent?.trim());

test("a page made from a styled PDF links the original and exports back as PDF with the current page", async () => {
  const calls: Exported[] = [];
  const source: PageSourceFile = { id: "file-1", filename: "Q3 report.pdf", format: "pdf", hasStyle: true };
  const view = await render(<SourceFileBanner source={source} page={page} run={async (input) => void calls.push(input)} />);
  try {
    assert.match(view.host.textContent ?? "", /Made from Q3 report\.pdf/);
    assert.equal([...view.host.querySelectorAll("a")].find((link) => link.textContent === "Open the original")?.getAttribute("href"), "/files/file-1");
    assert.deepEqual(buttons(view.host), ["Export back as PDF"]);
    assert.match(view.host.textContent ?? "", /PDF keeps page size, margins, sizes and colours \(fonts matched to the nearest standard font\)\./);
    assert.doesNotMatch(view.host.textContent ?? "", /Word keeps/);
    await act(async () => view.host.querySelector("button")!.click());
    assert.deepEqual(calls, [{ title: "Q3 report", doc, fileId: "file-1", format: "pdf" }]);
  } finally {
    await view.stop();
  }
});

test("a page made from Word exports back as Word; text files and unstyled PDFs only link the original", async () => {
  const word = await render(<SourceFileBanner source={{ id: "file-2", filename: "brief.docx", format: "docx", hasStyle: true }} page={page} run={async () => undefined} />);
  try {
    assert.deepEqual(buttons(word.host), ["Export back as Word"]);
    assert.match(word.host.textContent ?? "", /Word keeps the original's styles, fonts, page setup, headers and footers\./);
  } finally {
    await word.stop();
  }
  for (const source of [
    { id: "file-3", filename: "scan.pdf", format: "pdf", hasStyle: false },
    { id: "file-4", filename: "notes.md", format: "md", hasStyle: false },
  ]) {
    const plain = await render(<SourceFileBanner source={source} page={page} run={async () => undefined} />);
    try {
      assert.match(plain.host.textContent ?? "", new RegExp(`Made from ${source.filename.replace(".", "\\.")}`));
      assert.match(plain.host.textContent ?? "", /Open the original/);
      assert.deepEqual(buttons(plain.host), []);
      assert.doesNotMatch(plain.host.textContent ?? "", /keeps/);
    } finally {
      await plain.stop();
    }
  }
});

test("the Download menu keeps its formats and adds the original's format", async () => {
  const calls: Exported[] = [];
  const extra = exportBackItems({ id: "file-2", filename: "brief.docx", format: "docx", hasStyle: true }, page, async (input) => void calls.push(input));
  assert.deepEqual(exportBackItems(null, page), []);
  const view = await render(<ExportMenu load={() => ({ title: "Q3 report", blocks: [] })} extra={extra} />);
  try {
    await act(async () => view.host.querySelector<HTMLButtonElement>("button[aria-label='Download']")!.click());
    const menu = document.querySelector("[role='menu']")!;
    const items = [...menu.querySelectorAll("[role='menuitem']")].map((item) => item.textContent);
    assert.deepEqual(items, ["PDF.pdf", "Word.docx", "Apple Pagesopens the .docx", "Markdown.md", "Web page.html", "Plain text.txt", "Word.docx"]);
    assert.match(menu.textContent ?? "", /With the original's formatting/);
    await act(async () => (menu.querySelectorAll<HTMLButtonElement>("[role='menuitem']")[6]!).click());
    assert.deepEqual(calls, [{ title: "Q3 report", doc, fileId: "file-2", format: "docx" }]);
  } finally {
    await view.stop();
  }
});
