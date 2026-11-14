import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { renderDocs, pageHtml } from "../src/render.mjs";
import { readers } from "../src/readers.mjs";

const files = execFileSync("git", ["ls-files", "-z", "--", "docs"], { cwd: new URL("../../..", import.meta.url), encoding: "utf8" }).split("\0").filter((file) => file.endsWith(".md"));
const documents = await Promise.all(files.map(async (file) => ({ file: file.slice(5), markdown: await readFile(new URL(`../../../${file}`, import.meta.url), "utf8") })));
const source = renderDocs(documents);
const published = renderDocs(documents, "testing", { reader: true });

test("every tracked guide has a reader introduction, retains reference sections and code paths", () => {
  assert.equal(published.length, documents.length);
  for (const [i, page] of published.entries()) {
    assert.ok(readers[page.file], page.file);
    assert.equal(page.path, source[i].path);
    for (const section of source[i].toc) assert.ok(page.toc.some((item) => item.id === section.id), `${page.file}: ${section.id}`);
    for (const match of documents[i].markdown.matchAll(/`((?:apps|packages|scripts|infra|src|components|lib|routes|workspace|assistant|node|jobs|included|runtime|remote|connectors|files|imports|prisma|\.github)\/[^`\s]+)`/g)) {
      assert.ok(page.sections.some((section) => section.text.includes(match[1])), `${page.file}: lost ${match[1]}`);
    }
    assert.doesNotMatch(page.html, /(?<!&[a-z]+)—/);
  }
});
test("every page has a credential-free helper shell, scoped artwork and the exact disclaimer", () => {
  for (const page of published) {
    const html = pageHtml(page, published, "testing");
    assert.match(html, /id="docs-launcher"/);
    assert.match(html, /data-brand-tone="auto"/);
    assert.match(html, /AI can make mistakes, please verify/);
    assert.match(html, /aria-controls="docs-helper"/);
    assert.doesNotMatch(html, /data-endpoint="[^" ]*(?:key|token)=/);
  }
});
test("published site ships Hub tokens, local fonts and no credential in its helper bundle", async () => {
  const css = await readFile(new URL("../out/hub-tokens.css", import.meta.url), "utf8");
  for (const value of ["#10282b", "#f4f1ea", "#d7b56f", "#876324"]) assert.ok(css.includes(value));
  for (const font of ["figtree", "fraunces", "jetbrains-mono"]) assert.ok((await readFile(new URL(`../out/fonts/${font}.woff2`, import.meta.url))).length > 1000);
  const bundle = await readFile(new URL("../out/helper.js", import.meta.url), "utf8");
  assert.match(bundle, /credentials:"omit"/);
  assert.doesNotMatch(bundle, /api-key|AZURE_FOUNDRY_API_KEY|gpt-5-mini|reasoning.effort/);
});
