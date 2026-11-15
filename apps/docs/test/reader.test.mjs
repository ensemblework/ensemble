import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { publicDocuments } from "../src/publication.mjs";
import { renderDocs, pageHtml } from "../src/render.mjs";

const files = execFileSync("git", ["ls-files", "-z", "--", "docs"], { cwd: new URL("../../..", import.meta.url), encoding: "utf8" }).split("\0").filter((file) => file.endsWith(".md"));
const documents = await Promise.all(files.map(async (file) => ({ file: file.slice(5), markdown: await readFile(new URL(`../../../${file}`, import.meta.url), "utf8") })));
const topics = publicDocuments(documents);
const published = renderDocs(topics).map((page, i) => ({ ...page, parent: topics[i].parent, aliases: topics[i].aliases }));

test("public guides split into focused topics and retain their original guide URLs", () => {
  assert.ok(published.length > 100);
  assert.ok(published.some((page) => page.path === "/40_public_documentation/"));
  const spaces = published.find((page) => page.path === "/28_ensemble_spaces/");
  assert.ok(spaces.aliases.some((alias) => alias.id === "6-the-hub"));
  assert.ok(published.some((page) => page.path === "/28_ensemble_spaces/create-a-space/"));
  for (const page of published) {
    assert.ok(page.toc.length <= 1, `${page.path} mixes topics`);
    assert.ok(page.sections.map((section) => section.text).join(" ").split(/\s+/).length <= 1200, `${page.path} needs smaller topics`);
    assert.doesNotMatch(page.html, /github\.com\/ensemblework\/ensemble|apps\/hub-api|apps\/hub-web|\b[\w-]+\.(?:tsx?|jsx?|mjs|cjs|py|rs)\b|—/);
    assert.doesNotMatch(page.html, /In the code|Edit this page|View source/);
  }
});

test("internal references are excluded, and deep links resolve to their own topic pages", () => {
  const fixture = publicDocuments([{ file: "TEST.md", markdown: "# Test\n\n[Open steps](#steps)\n\n## Steps\n\nChoose Open.\n\n### Detail\n\nThen choose Save.\n\n## In the code\n\nPrivate implementation.\n\n## Hidden reference\n\nDo not publish.\n" }]);
  assert.equal(fixture.length, 3);
  assert.match(fixture[0].markdown, /\[Open steps\]\(\/test\/steps\/\)/);
  assert.equal(fixture[2].parent, fixture[1].file);
  assert.doesNotMatch(fixture.map((page) => page.markdown).join("\n"), /Private implementation|Do not publish/);
});

test("every page has a docs-only helper shell and the exact disclaimer", () => {
  for (const page of published) {
    const html = pageHtml(page, published, "testing");
    assert.match(html, /id="docs-launcher"/);
    assert.match(html, /data-brand-tone="auto"/);
    assert.match(html, /AI can make mistakes, please verify/);
    assert.match(html, /aria-controls="docs-helper"/);
    assert.doesNotMatch(html, /github\.com\/ensemblework\/ensemble/);
  }
});
test("the site ships shared Hub tokens, hashed icons, local fonts and no client credential", async () => {
  const css = await readFile(new URL("../out/hub-tokens.css", import.meta.url), "utf8");
  for (const value of ["#10282b", "#f4f1ea", "#d7b56f", "#876324"]) assert.ok(css.includes(value));
  for (const font of ["figtree", "fraunces", "jetbrains-mono"]) assert.ok((await readFile(new URL(`../out/fonts/${font}.woff2`, import.meta.url))).length > 1000);
  const html = await readFile(new URL("../out/index.html", import.meta.url), "utf8");
  assert.match(html, /\/brand\/favicon-[a-f\d]+\.png/);
  const bundle = await readFile(new URL("../out/helper.js", import.meta.url), "utf8");
  assert.match(bundle, /"include":"omit"/);
  assert.doesNotMatch(bundle, /api-key|AZURE_FOUNDRY_API_KEY|gpt-5-mini|reasoning.effort/);
});

test("section references keep cross-guide links and code intact, including lettered sections", () => {
  const topics = publicDocuments([
    { file: "FIRST.md", markdown: "# First\n\n## 3.10 Files\n\nFiles.\n\n## 3.10a Routines\n\nRoutines.\n\n## Use it\n\nRead §3.10a, [05 §4–§6](SECOND.md#4-queue) and `§3.10a`.\n" },
    { file: "SECOND.md", markdown: "# Second\n\n## 4. Queue\n\nQueue work.\n" },
  ]);
  const page = renderDocs(topics).find((page) => page.path === "/first/use-it/");
  assert.match(page.html, /href="\/first\/routines\/">Routines<\/a>/);
  assert.match(page.html, /href="\/second\/queue\/">Queue<\/a>/);
  assert.match(page.html, /<code>§3\.10a<\/code>/);
  assert.doesNotMatch(page.html, /Filesa|\[05|\]\(/);
});
