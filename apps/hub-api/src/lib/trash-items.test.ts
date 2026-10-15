import assert from "node:assert/strict";
import test from "node:test";
import { commentTrashDetail, commentTrashText, trashHref } from "./trash-items.js";

test("trashed comments read as their own words, with the page they were on", () => {
  const body = { content: [{ type: "paragraph", content: [{ type: "text", text: "Can we   move this" }, { type: "text", text: "to Friday?" }] }] };
  const label = commentTrashText(body, "Comment target");
  assert.equal(label, "Can we move this to Friday?");
  assert.equal(commentTrashDetail("Roadmap", "Comment target", label), "On “Roadmap” · about “Comment target”");
  assert.equal(commentTrashText({ text: "" }, "Comment target"), "Comment target");
  assert.equal(commentTrashDetail(null, "Comment target", "Comment target"), "");
  assert.equal(commentTrashText({}, ""), "Comment");
  assert.ok(commentTrashText({ text: "x".repeat(300) }, "").endsWith("…"));
});

test("restored items link to where they open", () => {
  assert.equal(trashHref("page", "p1"), "/pages/p1");
  assert.equal(trashHref("meeting", "m 1"), "/meetings?session=m%201");
  assert.equal(trashHref("person", "x", "Mira Chen"), "/context?tab=people&search=Mira%20Chen");
  assert.equal(trashHref("reminder", "r1"), null);
});
