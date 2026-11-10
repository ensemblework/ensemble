import assert from "node:assert/strict";
import test from "node:test";
import { skillPreview } from "./skill-preview";

test("a skill preview drops YAML front matter and lists its fields", () => {
  const { meta, text } = skillPreview('---\nname: Morning brief\ndescription: "Short and useful"\nlist:\n  - nested\n---\n# Morning brief\n\nBody');
  assert.deepEqual(meta, [["name", "Morning brief"], ["description", "Short and useful"]]);
  assert.equal(text, "# Morning brief\n\nBody");
  assert.deepEqual(skillPreview("# Plain\n\n---\nnot front matter"), { meta: [], text: "# Plain\n\n---\nnot front matter" });
});
