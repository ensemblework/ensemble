import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { standalonePageHref } from "./page-href";

const root = join(import.meta.dirname, "../..");

test("new pages open at /pages/:id with the title focused", () => {
  assert.equal(standalonePageHref("abc"), "/pages/abc");
  assert.equal(standalonePageHref("abc", true), "/pages/abc?focus=title");
  assert.equal(standalonePageHref("abc").includes("/api/"), false);
});

test("the pages route matches the tasks placeholder and navigates with Link", () => {
  const layout = readFileSync(join(root, "app/(hub)/pages/[id]/layout.tsx"), "utf8");
  const page = readFileSync(join(root, "app/(hub)/pages/[id]/page.tsx"), "utf8");
  const nav = readFileSync(join(root, "components/pages/pages-nav.tsx"), "utf8");
  const tasks = readFileSync(join(root, "app/(hub)/tasks/[id]/page.tsx"), "utf8");
  assert.match(layout, /desktopPlaceholder\(\{ id: "_" \}\)/);
  assert.match(page, /useDesktopParam/);
  assert.match(page, /isBakedParam/);
  assert.match(tasks, /useDesktopParam/);
  assert.match(nav, /<Link /);
  assert.match(nav, /router\.push\(standalonePageHref/);
  assert.doesNotMatch(nav, /location\.(assign|href)/);
  assert.doesNotMatch(page, /location\.(assign|href)/);
});
