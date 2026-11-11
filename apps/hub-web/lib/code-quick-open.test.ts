import assert from "node:assert/strict";
import test from "node:test";
import { fuzzyMatch, keyLabel, parseQuickInput, rankByLabel, rankFiles } from "./code-quick-open.js";

test("the typed text picks the mode: files, > commands, : a line, and name:line opens a file at a line", () => {
  assert.deepEqual(parseQuickInput("ext"), { mode: "files", query: "ext", line: null });
  assert.deepEqual(parseQuickInput(">  toggle term"), { mode: "commands", query: "toggle term" });
  assert.deepEqual(parseQuickInput(":42"), { mode: "line", line: 42 });
  assert.deepEqual(parseQuickInput(":"), { mode: "line", line: null });
  assert.deepEqual(parseQuickInput("help.tsx:12"), { mode: "files", query: "help.tsx", line: 12 });
  assert.deepEqual(parseQuickInput("help.tsx:12:4"), { mode: "files", query: "help.tsx", line: 12 });
});

test("fuzzy matching finds the characters in order, case aside, and prefers runs and word starts", () => {
  assert.equal(fuzzyMatch("xyz", "src/lib/extensions.ts"), null);
  assert.deepEqual(fuzzyMatch("EXT", "ext.ts")?.hits, [0, 1, 2]);
  const run = fuzzyMatch("sho", "scroll-handoff.ts")!;
  const word = fuzzyMatch("sh", "scroll-handoff.ts")!;
  assert.deepEqual(word.hits, [0, 7], "the h of handoff, a word start, over the h nearer by");
  assert.ok(run.score > 0);
});

test("files rank by their name before their folder; an exact name comes first", () => {
  const files = ["src/components/help.tsx", "src/lib/extensions.ts", "src/lib/scroll-handoff.ts", "docs/help/extensions.md", "README.md"];
  const ext = rankFiles("ext", files).map((row) => row.path);
  assert.deepEqual(ext.slice(0, 2).sort(), ["docs/help/extensions.md", "src/lib/extensions.ts"]);
  const help = rankFiles("help", files);
  assert.equal(help[0]!.path, "src/components/help.tsx");
  assert.deepEqual(help[0]!.nameHits, [0, 1, 2, 3], "the name's own letters are marked");
  assert.deepEqual(rankFiles("readme.md", files)[0], { path: "README.md", score: rankFiles("readme.md", files)[0]!.score, nameHits: [0, 1, 2, 3, 4, 5, 6, 7, 8], folderHits: [] });
  assert.equal(rankFiles("libscroll", files)[0]!.path, "src/lib/scroll-handoff.ts", "a match across the folder and the name");
  assert.deepEqual(rankFiles("", files), [], "nothing typed, nothing ranked");
  assert.equal(rankFiles("e", files, 2).length, 2);
});

test("commands rank by label, keeping their own order when nothing is typed", () => {
  const commands = [{ label: "Toggle terminal" }, { label: "Find in files" }, { label: "Go to file" }];
  assert.deepEqual(rankByLabel("", commands).map((row) => row.label), ["Toggle terminal", "Find in files", "Go to file"]);
  assert.equal(rankByLabel("term", commands)[0]!.label, "Toggle terminal");
  assert.equal(rankByLabel("gtf", commands)[0]!.label, "Go to file");
  assert.equal(rankByLabel("zzz", commands).length, 0);
});

test("shortcuts read as the platform writes them", () => {
  assert.equal(keyLabel("mod+shift+p", true), "⇧⌘P");
  assert.equal(keyLabel("mod+shift+p", false), "Ctrl+Shift+P");
  assert.equal(keyLabel("ctrl+`", true), "⌃`");
  assert.equal(keyLabel("alt+arrowright / alt+arrowleft", false), "Alt+→ / Alt+←");
  assert.equal(keyLabel("f7 / shift+f7", true), "F7 / ⇧F7");
  assert.equal(keyLabel("mod+shift++", false), "Ctrl+Shift++");
  assert.equal(keyLabel("escape", false), "Esc");
});
