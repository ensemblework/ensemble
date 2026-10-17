/**
 * Search bars draw no focus highlight of their own (app/globals.css). This keeps a new search box
 * from bringing one back: an accent focus edge on a wrapper that holds a search icon or a search
 * placeholder fails, and so does removing the global guard.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" || name.startsWith(".") ? [] : sources(path);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [path] : [];
  });
}

test("no search box asks for an accent focus edge", () => {
  const accent = /focus(-within|-visible)?:(border-accent|ring|outline-accent|shadow)/;
  const search = /<Search\b|placeholder=\{?[`"'][^`"']*(search|find|filter)/i;
  const found: string[] = [];
  for (const file of [...sources(join(root, "components")), ...sources(join(root, "app"))]) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (accent.test(line) && search.test(lines.slice(index, index + 10).join("\n"))) found.push(`${file.slice(root.length)}:${index + 1}`);
    });
  }
  assert.deepEqual(found, []);
});

test("the global guard and the shared search boxes stay without a highlight", () => {
  const css = readFileSync(join(root, "app/globals.css"), "utf8");
  assert.match(css, /Search bars draw no focus highlight of their own/);
  assert.match(css, /:has\(> svg\.lucide-search\) input:is\(:focus, :focus-visible\)/);
  assert.doesNotMatch(css.match(/\.picker-search \{[^}]*\}/)?.[0] ?? "", /accent/);
  const desk = readFileSync(join(root, "components/desk/desk.css"), "utf8");
  assert.doesNotMatch(desk.match(/\.tile-gallery-search:focus-within \{[^}]*\}/)?.[0] ?? "", /accent|outline/);
});
