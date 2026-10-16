import assert from "node:assert/strict";
import test from "node:test";
import { artifactLine, artifactTypeLabel } from "./artifact-label";

const file = (title: string, more: { format?: string | null; fileType?: string | null } = {}) => ({ kind: "file", title, ...more });

test("a file shows its real type, from the extension first", () => {
  assert.equal(artifactTypeLabel(file("Site survey.PDF")), "PDF");
  assert.equal(artifactTypeLabel(file("Budget 2026.xlsx")), "Excel workbook");
  assert.equal(artifactTypeLabel(file("Kickoff.pptx")), "PowerPoint presentation");
  assert.equal(artifactTypeLabel(file("notes.md")), "Markdown");
  assert.equal(artifactTypeLabel(file("photo.jpeg")), "JPEG image");
  // An uploaded file's stored format wins over a renamed title.
  assert.equal(artifactTypeLabel(file("Contract", { format: "docx" })), "Word document");
});

test("without an extension, the media type or type name the app gave", () => {
  assert.equal(artifactTypeLabel(file("Q3 plan", { fileType: "application/vnd.google-apps.document" })), "Google Doc");
  assert.equal(artifactTypeLabel(file("Roster", { fileType: "application/vnd.google-apps.spreadsheet" })), "Google Sheet");
  assert.equal(artifactTypeLabel(file("Scan", { fileType: "application/pdf" })), "PDF");
  assert.equal(artifactTypeLabel(file("Whiteboard", { fileType: "image/heif; q=1" })), "Image");
  assert.equal(artifactTypeLabel(file("Q4 plan", { fileType: "Google Doc" })), "Google Doc");
});

test("an unknown file falls back to its extension, then to File", () => {
  assert.equal(artifactTypeLabel(file("export.zip")), "ZIP");
  assert.equal(artifactTypeLabel(file("Untitled")), "File");
  assert.equal(artifactTypeLabel(file("Untitled", { fileType: "application/x-unknown" })), "File");
});

test("other items show their kind", () => {
  assert.equal(artifactTypeLabel({ kind: "email", title: "Re: site visit" }), "Email");
  assert.equal(artifactTypeLabel({ kind: "pr", title: "Fix the export" }), "Pull request");
  assert.equal(artifactTypeLabel({ kind: "custom_kind", title: "x" }), "custom kind");
});

test("the card line never reads File · file", () => {
  assert.equal(artifactLine({ ...file("Site survey.pdf"), source: "Your files" }), "PDF · Your files");
  assert.equal(artifactLine({ ...file("Q3 plan", { fileType: "Google Doc" }), source: "Google Drive" }), "Google Doc · Google Drive");
  assert.equal(artifactLine({ ...file("Untitled"), source: "file" }), "File");
  assert.equal(artifactLine({ kind: "email", title: "Re: site visit", source: "email" }), "Email");
  assert.equal(artifactLine({ kind: "email", title: "Re: site visit", source: "Gmail" }), "Email · Gmail");
});
