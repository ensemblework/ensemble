import assert from "node:assert/strict";
import test from "node:test";
import { blocksFromMarkdown, blocksFromPage, linkRuns, toHtml, toMarkdown, toText, type Block } from "./document";

const page = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Plan" }] },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Ship " },
        { type: "text", text: "Friday", marks: [{ type: "bold" }] },
        { type: "text", text: " with " },
        { type: "mention", attrs: { kind: "person", id: "p1", label: "Ben" } },
      ],
    },
    { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] }] },
    { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "done" }] }] }] },
    { type: "codeBlock", content: [{ type: "text", text: "let x = 1" }] },
    { type: "agentBlock", attrs: { id: "x" } },
  ],
};

test("a page becomes Markdown with marks, mentions, lists and to-dos", () => {
  const markdown = toMarkdown({ title: "Launch", meta: [["Status", "Doing"]], blocks: blocksFromPage(page) });
  assert.match(markdown, /^# Launch\n/);
  assert.match(markdown, /- \*\*Status:\*\* Doing/);
  assert.match(markdown, /## Plan/);
  assert.match(markdown, /Ship \*\*Friday\*\* with @Ben/);
  assert.match(markdown, /^- one$/m);
  assert.match(markdown, /^- \[x\] done$/m);
  assert.match(markdown, /```\nlet x = 1\n```/);
});

test("HTML escapes text and plain text drops the Markdown", () => {
  const doc = { title: "<b>x</b>", blocks: blocksFromMarkdown("a **b** `c`") };
  assert.ok(toHtml(doc).includes("&lt;b&gt;x&lt;/b&gt;"));
  assert.ok(toHtml(doc).includes("<strong>b</strong>"));
  assert.equal(toText(doc).trim(), "<b>x</b>\n\na b c");
});

test("Markdown notes keep headings, numbered lists and checkboxes", () => {
  const blocks = blocksFromMarkdown("## Agenda\n1. intro\n2. demo\n- [ ] follow up\n\ntext");
  assert.deepEqual(
    blocks.map((block) => block.type),
    ["heading", "list", "todo", "paragraph"],
  );
});

const tableOf = (blocks: Block[]) => blocks.find((block): block is Extract<Block, { type: "table" }> => block.type === "table")!;

test("Markdown tables are tables, with or without pipes at the ends, and cells keep their formatting", () => {
  const blocks = blocksFromMarkdown(["Papers:", "Name | Assign | Status", "--- | --- | :-:", "**Survey** | | *Promising*", "a \\| b | x", "", "after"].join("\n"));
  assert.deepEqual(blocks.map((block) => block.type), ["paragraph", "table", "paragraph"]);
  assert.deepEqual(tableOf(blocks).rows, [
    [[{ text: "Name" }], [{ text: "Assign" }], [{ text: "Status" }]],
    [[{ text: "Survey", bold: true }], [], [{ text: "Promising", italic: true }]],
    [[{ text: "a | b" }], [{ text: "x" }], []],
  ]);
  assert.equal(tableOf(blocksFromMarkdown("| A | B |\n|---|---|\n| [doc](https://example.com) | `x` |")).rows[1]![0]![0]!.href, "https://example.com");
});

test("emphasis needs text right inside its markers; snake_case and URLs stay text", () => {
  const [paragraph] = blocksFromMarkdown("2 * 3 * 4, my_var_name, https://example.com/a_b_c and __init__ _it_ ***both*** ~~gone~~ **[docs](https://example.com)**");
  assert.deepEqual(paragraph, {
    type: "paragraph",
    runs: [
      { text: "2 * 3 * 4, my_var_name, " },
      { text: "https://example.com/a_b_c" },
      { text: " and " },
      { text: "init", bold: true },
      { text: " " },
      { text: "it", italic: true },
      { text: " " },
      { text: "both", bold: true, italic: true },
      { text: " " },
      { text: "gone", strike: true },
      { text: " " },
      { text: "docs", href: "https://example.com", bold: true },
    ],
  });
});

test("bare web addresses become link runs without the punctuation around them", () => {
  assert.deepEqual(linkRuns([{ text: "See https://example.com/a_(b), or (https://example.com/c).", bold: true }, { text: "https://example.com/code", code: true }]), [
    { text: "See ", bold: true },
    { text: "https://example.com/a_(b)", bold: true, href: "https://example.com/a_(b)" },
    { text: ", or (", bold: true },
    { text: "https://example.com/c", bold: true, href: "https://example.com/c" },
    { text: ").", bold: true },
    { text: "https://example.com/code", code: true },
  ]);
  assert.deepEqual(linkRuns([{ text: "https:// alone" }]), [{ text: "https:// alone" }]);
});

test("page table cells keep their marks, one line per paragraph", () => {
  const cell = (type: string, ...paragraphs: unknown[][]) => ({ type, content: paragraphs.map((content) => ({ type: "paragraph", content })) });
  const blocks = blocksFromPage({
    type: "doc",
    content: [
      {
        type: "table",
        content: [
          { type: "tableRow", content: [cell("tableHeader", [{ type: "text", text: "Who" }]), cell("tableHeader", [{ type: "text", text: "Notes" }])] },
          {
            type: "tableRow",
            content: [
              cell("tableCell", [{ type: "text", text: "Mira", marks: [{ type: "bold" }] }]),
              cell("tableCell", [{ type: "text", text: "docs", marks: [{ type: "link", attrs: { href: "https://example.com" } }] }], [{ type: "text", text: "later", marks: [{ type: "italic" }] }]),
            ],
          },
        ],
      },
    ],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(tableOf(blocks).rows[1])), [[{ text: "Mira", bold: true }], [{ text: "docs", href: "https://example.com" }, { text: "\n" }, { text: "later", italic: true }]]);
});

test("tables write as Markdown, HTML and text tables", () => {
  const doc = {
    title: "Reading",
    blocks: [
      {
        type: "table",
        rows: [
          [[{ text: "Name" }], [{ text: "Status" }]],
          [[{ text: "a | b", bold: true }], [{ text: "one" }, { text: "\n" }, { text: "two" }]],
          [[{ text: "https://example.com/x" }], [{ text: "bad", href: "javascript:alert(1)" }]],
        ],
      },
    ] as Block[],
  };
  const markdown = toMarkdown(doc);
  assert.match(markdown, /^\| Name \| Status \|\n\| --- \| --- \|\n\| \*\*a \\\| b\*\* \| one<br>two \|$/m);
  assert.deepEqual(tableOf(blocksFromMarkdown(markdown)).rows[1], [[{ text: "a | b", bold: true }], [{ text: "one\ntwo" }]]);
  const html = toHtml(doc);
  assert.match(html, /<table class="grid"><thead><tr><th scope="col">Name<\/th><th scope="col">Status<\/th><\/tr><\/thead><tbody><tr><td><strong>a \| b<\/strong><\/td><td>one<br>two<\/td><\/tr>/);
  assert.ok(html.includes('<a href="https://example.com/x" target="_blank" rel="noopener">https://example.com/x</a>'));
  assert.ok(!html.includes("javascript:"));
  assert.match(html, /@media print\{.*table\.grid thead\{display:table-header-group\}/);
  assert.equal(
    toText(doc),
    `${["Reading", "", "Name                  | Status", "--------------------- | ---------", "a | b                 | one / two", "https://example.com/x | bad"].join("\n")}\n`,
  );
});
