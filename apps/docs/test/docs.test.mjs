import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { pageHtml, renderDocs } from "../src/render.mjs";
import { DOCS_HOME, searchDocs } from "../src/search.js";

const bridge = await readFile(new URL("../../../docs/CONTEXT_BRIDGE.md", import.meta.url), "utf8");
const pages = renderDocs([
  { file: "README.md", markdown: "# Ensemble documentation\n\n[Bridge](CONTEXT_BRIDGE.md#1-three-ways-to-reach-it)\n\n[Code](../apps/context-bridge/src/server.ts)" },
  { file: "CONTEXT_BRIDGE.md", markdown: bridge },
]);
const index = { version: 1, pages };

test("a real heading returns a passage that the published page renders, with its stable URL", () => {
  const answer = searchDocs(index, "Three ways to reach it", 1);
  assert.equal(answer.found, true);
  assert.equal(answer.results[0].heading, "1. Three ways to reach it");
  assert.equal(answer.results[0].url, `${DOCS_HOME}context_bridge/#1-three-ways-to-reach-it`);
  const page = pages.find(({ path }) => path === "/context_bridge/");
  assert.ok(page.sections.some(({ text }) => text.includes(answer.results[0].excerpt)));
  assert.match(page.html, /id="1-three-ways-to-reach-it"/);
  assert.match(page.html, /Three ways to reach it/);
});

test("unknown words explicitly miss without returning a procedure", () => {
  const answer = searchDocs(index, "zzzzquasar undocumented teleportation");
  assert.equal(answer.found, false);
  assert.deepEqual(answer.results, []);
  assert.equal(answer.home, DOCS_HOME);
  assert.match(answer.message, /No published documentation/);
  assert.throws(() => searchDocs(index, "..."), /search words/);
});

test("documentation links stay on the site and code links point to the repository", () => {
  assert.match(pages[0].html, /href="\/context_bridge\/#1-three-ways-to-reach-it"/);
  assert.match(pages[0].html, /href="https:\/\/github.com\/ensemblework\/ensemble\/blob\/testing\/apps\/context-bridge\/src\/server.ts"/);
  const html = pageHtml(pages[0], pages, "testing");
  assert.match(html, /aria-label="Documentation"/);
  assert.match(html, /aria-current="page"/);
  assert.match(html, /<label for="query">Search docs<\/label>/);
  assert.match(html, /href="#content"/);
});

test("heading IDs handle repeats and code fences do not become headings or executable HTML", () => {
  const [page] = renderDocs([{ file: "nested/GUIDE.md", markdown: "# Guide\n\n## Repeated\n\nFirst.\n\n## Repeated\n\nSecond.\n\n```html\n<script>alert(1)</script>\n## Not a heading\n```" }]);
  assert.equal(page.path, "/nested/guide/");
  assert.match(page.html, /id="repeated"/);
  assert.match(page.html, /id="repeated-1"/);
  assert.equal(page.toc.length, 2);
  assert.doesNotMatch(page.html, /<script>/);
  assert.match(page.html, /&lt;script&gt;/);
});
