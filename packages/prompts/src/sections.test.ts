import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SECTIONS } from "./sections.generated.js";

test("the generated module matches the section files (run build:sections after editing one)", () => {
  const script = fileURLToPath(new URL("../scripts/generate.mjs", import.meta.url));
  assert.doesNotThrow(() => execFileSync(process.execPath, [script, "--check"], { stdio: "pipe" }), "packages/prompts/src/sections.generated.ts is out of date: run `pnpm --filter @ensemble/prompts build:sections`");
});

test("sections are rules and data, never headings, and never use a dash people should not read", () => {
  for (const [name, section] of Object.entries(SECTIONS)) {
    assert.doesNotMatch(section.text, /^#/m, `${name} has a Markdown heading, which a model may copy into its reply`);
    assert.doesNotMatch(section.text, /\u2014|\u2013|--/, `${name} has an em dash, en dash or double hyphen`);
    assert.doesNotMatch(section.text, /<!--/, `${name} kept a note for people`);
  }
});
