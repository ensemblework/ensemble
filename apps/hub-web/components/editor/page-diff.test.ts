import "../ui-test-dom.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { Editor } from "@tiptap/core";
import type { Node as ProseNode } from "@tiptap/pm/model";
import { changesOnto, diffSteps, rebaseSteps } from "./page-diff";
import { editorExtensions } from "./extensions";

Object.defineProperty(globalThis, "self", { configurable: true, value: window });

test("hub-api's page-diff.ts is this file with prosemirror imports", () => {
  const body = (path: string) => readFileSync(path, "utf8").split("// ---\n")[1];
  assert.equal(body(resolve(__dirname, "../../../hub-api/src/pages/page-diff.ts")), body(resolve(__dirname, "page-diff.ts")), "Copy the change to apps/hub-api/src/pages/page-diff.ts (below the `// ---` line).");
});

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const START = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Launch plan" }] },
    { type: "paragraph", content: [{ type: "text", text: "Ship the beta to " }, { type: "text", marks: [{ type: "bold" }], text: "twenty" }, { type: "text", text: " teams by Friday." }] },
    { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Docs" }] }] }, { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Pricing page" }] }] }] },
    { type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "Email Mira" }] }] }] },
    { type: "paragraph", content: [{ type: "text", text: "Notes " }, { type: "mention", attrs: { id: "p1", label: "Ben", kind: "people" } }] },
  ],
};

/** Some random edits through the editor, as people make them. */
function edit(editor: Editor, rand: () => number, count: number): void {
  for (let at = 0; at < count; at += 1) {
    const size = editor.state.doc.content.size;
    const pos = 1 + Math.floor(rand() * Math.max(1, size - 2));
    const chain = editor.chain().setTextSelection(Math.min(pos, size - 1));
    const roll = rand();
    try {
      if (roll < 0.35) chain.insertContent(["word ", "x", " and more", "Ж", "😀"][Math.floor(rand() * 5)]!).run();
      else if (roll < 0.5) chain.splitBlock().run();
      else if (roll < 0.62) editor.commands.deleteRange({ from: pos, to: Math.min(size - 1, pos + 1 + Math.floor(rand() * 8)) });
      else if (roll < 0.7) chain.joinBackward().run();
      else if (roll < 0.78) chain.setTextSelection({ from: pos, to: Math.min(size - 1, pos + 4) }).toggleBold().run();
      else if (roll < 0.84) chain.toggleHeading({ level: 2 }).run();
      else if (roll < 0.9) chain.toggleBulletList().run();
      else if (roll < 0.95) chain.toggleTaskList().run();
      else chain.insertContent({ type: "mention", attrs: { id: `m${at}`, label: "Someone", kind: "people" } }).run();
    } catch {
      // Not every command fits every place; the next one will.
    }
  }
}

function applyAll(doc: ProseNode, steps: ReturnType<typeof diffSteps>): ProseNode {
  let out = doc;
  for (const step of steps) {
    const result = step.apply(out);
    assert.ok(result.doc, result.failed ?? "step failed");
    out = result.doc;
  }
  return out;
}

test("diffSteps turns any edited page back into the edit, with small steps", () => {
  const editor = new Editor({ extensions: editorExtensions(() => [], ""), content: START });
  try {
    let small = 0;
    for (let seed = 1; seed <= 150; seed += 1) {
      const rand = random(seed);
      editor.commands.setContent(START);
      edit(editor, rand, 3);
      const from = editor.state.doc;
      edit(editor, rand, 1 + Math.floor(rand() * 5));
      const to = editor.state.doc;
      const steps = diffSteps(from, to);
      assert.ok(applyAll(from, steps).eq(to), `seed ${seed}`);
      if (steps.every((step) => (step.toJSON() as { from?: number; to?: number }).to !== from.content.size)) small += 1;
    }
    assert.ok(small > 120, `most diffs avoid replacing the whole page (${small}/150)`);
  } finally {
    editor.destroy();
  }
});

test("someone's changes move onto a version that changed elsewhere, word by word", () => {
  const editor = new Editor({ extensions: editorExtensions(() => [], ""), content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "b2 Agenda" }] }] } });
  try {
    const schema = editor.schema;
    const base = editor.state.doc;
    const mine = schema.nodeFromJSON({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "b20 b2 Agenda" }] }] });
    const theirs = schema.nodeFromJSON({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "c9 b2 Agenda" }] }, { type: "paragraph", content: [{ type: "text", text: "New" }] }] });
    const steps = changesOnto(base, mine, theirs)!;
    const words = applyAll(theirs, steps).textBetween(0, applyAll(theirs, steps).content.size, " ").split(/\s+/);
    assert.deepEqual(words.filter((word) => word === "b2"), ["b2"], "b20 is a new word; b2 is not typed twice");
    assert.ok(words.includes("b20") && words.includes("c9") && words.includes("New"));
    // A change whose place was deleted cannot be moved.
    const gone = schema.nodeFromJSON({ type: "doc", content: [{ type: "paragraph" }] });
    const edited = schema.nodeFromJSON({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "b2 Agenda!" }] }] });
    assert.equal(rebaseSteps(base, diffSteps(base, edited), diffSteps(base, gone))?.length ?? 0, 1);
  } finally {
    editor.destroy();
  }
});

test("a changed emoji is replaced whole: no step carries half of one", () => {
  const editor = new Editor({ extensions: editorExtensions(() => [], ""), content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Mood 😀 ok 𝒜b" }] }] } });
  try {
    const from = editor.state.doc;
    const to = editor.schema.nodeFromJSON({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Mood 😃 ok 𝒜c" }] }] });
    const steps = diffSteps(from, to);
    assert.ok(applyAll(from, steps).eq(to));
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (const step of steps) {
      const texts = ((step.toJSON() as { slice?: { content?: Array<{ text?: string }> } }).slice?.content ?? []).map((node) => node.text ?? "");
      assert.ok(texts.every((text) => !lone.test(text)), JSON.stringify(step.toJSON()));
    }
  } finally {
    editor.destroy();
  }
});
