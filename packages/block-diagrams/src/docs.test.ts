import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { errorCount, parseDiagram } from "./parse.js";
import { printDiagram } from "./print.js";
import type { DiagramModel } from "./model.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const files = [
  resolve(root, "docs/21_BLOCK_DIAGRAMS_DSL.md"),
  resolve(root, "docs/21_BLOCK_DIAGRAMS_CHEATSHEET.md"),
  resolve(root, "docs/22_BLOCK_DIAGRAMS_FOR_AGENTS.md"),
  resolve(root, ".github/skills/block-diagrams/SKILL.md"),
];

function fences(source: string, lang: string): string[] {
  const found: string[] = [];
  const re = new RegExp("```" + lang + "\\n([\\s\\S]*?)```", "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) found.push(match[1]!);
  return found;
}

function semantic(model: DiagramModel) {
  const sort = <T>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
  return {
    meta: model.meta,
    nodes: sort(model.nodes),
    groups: sort(model.groups),
    edges: sort(model.edges),
    texts: sort(model.texts),
    layout: sort(model.layout),
  };
}

test("every documented example parses, and clean examples round-trip", () => {
  let clean = 0;
  let loose = 0;
  let broken = 0;
  let mermaid = 0;
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const example of fences(source, "udl")) {
      clean += 1;
      const parsed = parseDiagram(example);
      assert.deepEqual(
        parsed.diagnostics,
        [],
        `${file} example ${clean} diagnostics:\n${parsed.diagnostics.map((item) => `${item.line}: ${item.message}`).join("\n")}\n${example}`,
      );
      const printed = printDiagram(parsed.model);
      const again = parseDiagram(printed);
      assert.deepEqual(again.diagnostics, []);
      assert.deepEqual(semantic(again.model), semantic(parsed.model));
    }
    for (const example of fences(source, "udl-loose")) {
      loose += 1;
      const parsed = parseDiagram(example);
      assert.equal(errorCount(parsed.diagnostics), 0, example);
      assert.ok(parsed.diagnostics.some((item) => item.severity === "warning"));
    }
    for (const example of fences(source, "udl-broken")) {
      broken += 1;
      const parsed = parseDiagram(example);
      assert.ok(errorCount(parsed.diagnostics) > 0);
      assert.ok(Object.keys(parsed.model.nodes).length >= 2);
      assert.ok(Object.keys(parsed.model.edges).length >= 1);
    }
    for (const example of fences(source, "mermaid")) {
      mermaid += 1;
      const parsed = parseDiagram(example);
      assert.equal(errorCount(parsed.diagnostics), 0, parsed.diagnostics.map((item) => item.message).join("\n"));
      assert.ok(Object.keys(parsed.model.nodes).length >= 2);
    }
  }
  assert.ok(clean >= 10);
  assert.ok(loose >= 1);
  assert.ok(broken >= 1);
  assert.ok(mermaid >= 1);
});
