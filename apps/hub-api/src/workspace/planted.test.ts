import assert from "node:assert/strict";
import test from "node:test";
import { flagPlanted } from "./planted.js";

test("persistence files in a diff are flagged, and ordinary files are not", () => {
  const hits = flagPlanted([
    { path: ".vscode/tasks.json", text: '{ "tasks": [{ "runOptions": { "runOn": "folderOpen" } }] }' },
    { path: "src/.vscode/tasks.json", text: '{ "tasks": [{ "label": "build" }] }' },
    { path: ".envrc" },
    { path: ".husky/pre-commit" },
    { path: "package.json", text: '{ "scripts": { "postinstall": "node setup.js", "test": "vitest" } }' },
    { path: "apps/web/package.json", text: '{ "scripts": { "dev": "next dev" } }' },
    { path: "Makefile", text: "all:\n\techo hi\n" },
    { path: "src/main.ts", text: "export const n = 1;\n" },
  ]);
  const kinds = hits.map((hit) => `${hit.kind}:${hit.path}`);
  assert.deepEqual(kinds, [
    "vscode-task:.vscode/tasks.json",
    "envrc:.envrc",
    "husky:.husky/pre-commit",
    "lifecycle:package.json",
    "makefile:Makefile",
  ]);
  assert.match(hits[0]!.reason, /folder is opened/);
  assert.match(hits[3]!.reason, /postinstall/);
});

test("a tasks.json or package.json change with no text is still called out", () => {
  const hits = flagPlanted([{ path: ".vscode/tasks.json" }, { path: "package.json" }]);
  assert.equal(hits.length, 2);
  assert.match(hits[0]!.reason, /folderOpen/);
  assert.match(hits[1]!.reason, /lifecycle/);
});
