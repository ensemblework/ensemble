import assert from "node:assert/strict";
import test from "node:test";
import type { PageDocument, PageNode } from "./domain.js";
import { markdownParagraphsDocument } from "./page-repair.js";

/** How the editor saved Markdown notes before it read Markdown: one plain paragraph per line, empty ones for blank lines. */
const asParagraphs = (text: string): PageDocument => ({
  type: "doc",
  content: text.split("\n").map((line) => (line ? { type: "paragraph", content: [{ type: "text", text: line }] } : { type: "paragraph" })),
});
const types = (doc: PageDocument | null) => (doc?.content ?? []).map((node) => node.type);
const cells = (table: PageNode) => (table.content ?? []).map((row) => (row.content ?? []).map((cell) => JSON.stringify(cell.content)));

const AKASH = [
  "## What it is",
  "Ensemble is a workspace for tasks, pages, files and connected context.",
  "## Repositories",
  "- **ensemblework/ensemble**: the monorepo. Hub, API, CLI. Read its `AGENTS.md` first.",
  "- **ensemblework/ensemble-integrations**: MCP client plugins.",
  "## Layout of ensemblework/ensemble",
  "| Path | What |",
  "",
  "| --- | --- |",
  "",
  "| `apps/hub-web` | The Hub (Next.js): Today, Board, pages, Context, Files, Code tab, Runs, Settings |",
  "",
  "| `apps/hub-api` | The API |",
  "## Environments",
  "| | Production | Testing |",
  "| --- | --- | --- |",
  "| Branch and deploy pointer | `main`, `production` (`deploy.yml`) | `testing`, `testing-live` (`test-web.yml`) |",
].join("\n");

test("Markdown saved as plain paragraphs becomes headings, lists with bold and code, and real tables", () => {
  const repaired = markdownParagraphsDocument(asParagraphs(AKASH))!;
  assert.deepEqual(types(repaired), ["heading", "paragraph", "heading", "bulletList", "heading", "table", "heading", "table"]);
  const list = repaired.content[3]!;
  assert.deepEqual(list.content![0]!.content![0]!.content!.slice(0, 2), [{ type: "text", text: "ensemblework/ensemble", marks: [{ type: "bold" }] }, { type: "text", text: ": the monorepo. Hub, API, CLI. Read its " }]);
  assert.ok(JSON.stringify(list).includes('"text":"AGENTS.md","marks":[{"type":"code"}]'));
  const layout = repaired.content[5]!;
  assert.equal(layout.content!.length, 3, "the empty paragraphs between rows are skipped: header and two rows");
  assert.match(cells(layout)[1]![0]!, /apps\/hub-web.*code/);
  assert.equal(repaired.content[7]!.content!.length, 2);
});

test("repairing is idempotent and leaves anything that does not qualify exactly as it is", () => {
  const repaired = markdownParagraphsDocument(asParagraphs(AKASH))!;
  assert.equal(markdownParagraphsDocument(repaired), null, "a repaired page does not qualify again");
  for (const doc of [
    asParagraphs("- typed with a dash\nand an ordinary line"),
    asParagraphs("- typed with a dash at the start\n# a heading-looking line typed as text\nA plain paragraph."),
    asParagraphs("- one\n- two\n- three"),
    asParagraphs("# one heading line\nthen prose\nmore prose"),
    asParagraphs("Plain notes\nwith two lines"),
    { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "## Bold", marks: [{ type: "bold" }] }] }, { type: "paragraph", content: [{ type: "text", text: "- item" }] }, { type: "paragraph", content: [{ type: "text", text: "- item" }] }] },
    { type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Real" }] }, { type: "paragraph", content: [{ type: "text", text: "- a" }] }, { type: "paragraph", content: [{ type: "text", text: "- b" }] }] },
    { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "- a" }, { type: "hardBreak" }, { type: "text", text: "- b" }] }] },
    { type: "doc", content: [] },
  ] as PageDocument[]) assert.equal(markdownParagraphsDocument(doc), null, JSON.stringify(doc).slice(0, 80));
  assert.equal(markdownParagraphsDocument(null), null);
});

test("fences keep their lines, blank ones included, and list items stay one list", () => {
  const repaired = markdownParagraphsDocument(asParagraphs("## Run it\n```bash\npnpm install\n\npnpm dev\n```\n- one\n\n- two"))!;
  assert.deepEqual(types(repaired), ["heading", "codeBlock", "bulletList"]);
  assert.equal(repaired.content[1]!.content![0]!.text, "pnpm install\n\npnpm dev");
  assert.equal(repaired.content[2]!.content!.length, 2);
});

test("only Markdown, never LaTeX, and large or odd documents are left alone", () => {
  assert.equal(markdownParagraphsDocument(asParagraphs("\\section{A}\n\\subsection{B}\ntext")), null);
  assert.equal(markdownParagraphsDocument(asParagraphs(`## a\n## b\n${"x\n".repeat(30_000)}`)), null, "past the size bound");
  const start = performance.now();
  markdownParagraphsDocument(asParagraphs(`## a\n- b\n${"| x | y |\n".repeat(5_000)}`));
  assert.ok(performance.now() - start < 1000);
});

test("notes with blank lines between table rows (paragraphs written back as Markdown) still open as tables", async () => {
  const { notesDocument } = await import("./page-notes.js");
  const notes = "## Layout\n\n| Path | What |\n\n| --- | --- |\n\n| `apps/hub-web` | The Hub |\n\n| `apps/hub-api` | The API |\n\n```\n| keep |\n\n| as code |\n```";
  const doc = notesDocument(notes);
  assert.deepEqual(types(doc), ["heading", "table", "codeBlock"]);
  assert.equal(doc.content[1]!.content!.length, 3);
  assert.equal(doc.content[2]!.content![0]!.text, "| keep |\n\n| as code |", "lines inside a fence are left alone");
});

test("a table with its header rule, a closed fence, or three Markdown lines of two kinds qualify", () => {
  assert.deepEqual(types(markdownParagraphsDocument(asParagraphs("| a | b |\n| --- | --- |\n| 1 | 2 |"))), ["table"]);
  assert.deepEqual(types(markdownParagraphsDocument(asParagraphs("Run:\n```\npnpm dev\n```"))), ["paragraph", "codeBlock"]);
  assert.deepEqual(types(markdownParagraphsDocument(asParagraphs("## Plan\n- one\n- two"))), ["heading", "bulletList"]);
});
