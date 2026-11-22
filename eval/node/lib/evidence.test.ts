import assert from "node:assert/strict";
import test from "node:test";
import { docText } from "./evidence.js";

test("docText keeps one line per block, list item and table row, with mentions by label", () => {
  const text = (value: string, marks?: unknown[]) => ({ type: "text", text: value, ...(marks ? { marks } : {}) });
  const paragraph = (...content: unknown[]) => ({ type: "paragraph", content });
  const doc = {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1 }, content: [text("Notes index")] },
      paragraph(text("Sorted by "), text("TODO", [{ type: "bold" }]), text(" count.")),
      { type: "bulletList", content: [{ type: "listItem", content: [paragraph({ type: "mention", attrs: { kind: "task", id: "t", label: "Book the venue" } }, text(" due 28 Nov"))] }, { type: "listItem", content: [paragraph(text("Send the invitations"))] }] },
      { type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", content: [paragraph(text("Title"))] }, { type: "tableHeader", content: [paragraph(text("TODOs"))] }] }, { type: "tableRow", content: [{ type: "tableCell", content: [paragraph(text("Amber ledger"))] }, { type: "tableCell", content: [paragraph(text("7"))] }] }] },
    ],
  };
  assert.equal(docText(doc), "Notes index\nSorted by TODO count.\nBook the venue due 28 Nov\nSend the invitations\nTitle | TODOs\nAmber ledger | 7");
});
