import assert from "node:assert/strict";
import test from "node:test";
import type { PageDocument, PageNode } from "./domain.js";
import { mergeDocs, sameDoc } from "./page-merge.js";

type Part = string | PageNode;
const inline = (parts: Part[]): PageNode[] => parts.filter((part) => part !== "").map((part) => (typeof part === "string" ? { type: "text", text: part } : part));
const p = (...parts: Part[]): PageNode => (parts.length ? { type: "paragraph", content: inline(parts) } : { type: "paragraph" });
const h = (level: number, ...parts: Part[]): PageNode => ({ type: "heading", attrs: { level }, content: inline(parts) });
const bold = (text: string): PageNode => ({ type: "text", marks: [{ type: "bold" }], text });
const mention = (label: string): PageNode => ({ type: "mention", attrs: { kind: "people", id: `id-${label}`, label } });
const li = (...blocks: PageNode[]): PageNode => ({ type: "listItem", content: blocks });
const ul = (...items: PageNode[]): PageNode => ({ type: "bulletList", content: items });
const doc = (...blocks: PageNode[]): PageDocument => ({ type: "doc", content: blocks });

function textOf(node: PageNode): string {
  if (typeof node.text === "string") return node.text;
  if (node.type === "mention") return `@${String(node.attrs?.label)}`;
  return (node.content ?? []).map(textOf).join(node.content?.some((child) => child.content) ? " | " : "");
}
const lines = (page: PageDocument) => page.content.map(textOf);

test("both typing at the end of the same paragraph keeps both texts, theirs first", () => {
  const base = doc(p("Plan the launch"), p("Budget"));
  const mine = doc(p("Plan the launch with Mira"), p("Budget"));
  const theirs = doc(p("Plan the launch next week"), p("Budget"));
  const merged = mergeDocs(base, mine, theirs);
  assert.deepEqual(lines(merged.doc), ["Plan the launch next week with Mira", "Budget"]);
  assert.equal(merged.kept, 0, "typing at the same spot is not a clash");
});

test("two people starting on an empty paragraph keep both words with a space", () => {
  const merged = mergeDocs(doc(p()), doc(p("Hello")), doc(p("World")));
  assert.deepEqual(lines(merged.doc), ["World Hello"]);
});

test("edits in different blocks both land", () => {
  const base = doc(h(1, "Launch"), p("Goals"), p("Risks"), p("Owners"));
  const mine = doc(h(1, "Launch"), p("Goals: ship in May"), p("Risks"), p("Owners"));
  const theirs = doc(h(1, "Launch"), p("Goals"), p("Risks"), p("Owners: Ben"));
  assert.deepEqual(lines(mergeDocs(base, mine, theirs).doc), ["Launch", "Goals: ship in May", "Risks", "Owners: Ben"]);
});

test("edits in neighbouring blocks both land", () => {
  const base = doc(p("One"), p("Two"));
  const mine = doc(p("One!"), p("Two"));
  const theirs = doc(p("One"), p("Two?"));
  assert.deepEqual(lines(mergeDocs(base, mine, theirs).doc), ["One!", "Two?"]);
});

test("a block one side deleted and the other edited stays, with the edit", () => {
  const base = doc(p("Keep"), p("Draft idea"), p("End"));
  const mine = doc(p("Keep"), p("End"));
  const theirs = doc(p("Keep"), p("Draft idea, with numbers"), p("End"));
  const merged = mergeDocs(base, mine, theirs);
  assert.deepEqual(lines(merged.doc), ["Keep", "Draft idea, with numbers", "End"]);
  assert.equal(merged.kept, 1);
  const flipped = mergeDocs(base, theirs, mine);
  assert.deepEqual(lines(flipped.doc), ["Keep", "Draft idea, with numbers", "End"], "the same when the editor is the one who edited");
});

test("a block deleted on one side and untouched on the other is deleted", () => {
  const base = doc(p("Keep"), p("Old"), p("End"));
  assert.deepEqual(lines(mergeDocs(base, doc(p("Keep"), p("End")), base).doc), ["Keep", "End"]);
  assert.deepEqual(lines(mergeDocs(base, base, doc(p("Keep"), p("End"))).doc), ["Keep", "End"]);
});

test("identical edits on both sides are not duplicated", () => {
  const base = doc(p("Plan"));
  const same = doc(p("Plan the launch"), p("New line"));
  const merged = mergeDocs(base, same, same);
  assert.deepEqual(lines(merged.doc), ["Plan the launch", "New line"]);
  assert.equal(merged.kept, 0);
});

test("both rewriting the same word keeps both versions and says so", () => {
  const merged = mergeDocs(doc(p("Meet on Monday at noon")), doc(p("Meet on Tuesday at noon")), doc(p("Meet on Friday at noon")));
  assert.deepEqual(lines(merged.doc), ["Meet on Friday Tuesday at noon"]);
  assert.equal(merged.kept, 1);
});

test("letter edits in different parts of one word both land", () => {
  const merged = mergeDocs(doc(p("recieve teh")), doc(p("receive teh")), doc(p("recieve the")));
  assert.deepEqual(lines(merged.doc), ["receive the"]);
});

test("continuing a word while the other adds a word after it keeps both", () => {
  assert.deepEqual(lines(mergeDocs(doc(p("foo")), doc(p("foobar")), doc(p("foo baz"))).doc), ["foobar baz"]);
});

test("one side's formatting and the other side's typing both survive", () => {
  const base = doc(p("hello world"));
  const mine = doc(p("hello ", bold("world")));
  const theirs = doc(p("hello world, again"));
  const merged = mergeDocs(base, mine, theirs).doc;
  assert.deepEqual(merged.content[0]!.content, [{ type: "text", text: "hello " }, bold("world"), { type: "text", text: ", again" }]);
});

test("inline mentions stay once and typing around them merges", () => {
  const base = doc(p("Ask ", mention("Mira"), " about it"));
  const mine = doc(p("Ask ", mention("Mira"), " about it today"));
  const theirs = doc(p("Please ask ", mention("Mira"), " about it"));
  assert.deepEqual(lines(mergeDocs(base, mine, theirs).doc), ["Please ask @Mira about it today"]);
});

test("new blocks both people added at the same place are all kept, theirs first", () => {
  const base = doc(p("Top"), p("Bottom"));
  const mine = doc(p("Top"), p("Mine A"), p("Mine B"), p("Bottom"));
  const theirs = doc(p("Top"), p("Theirs"), p("Bottom"));
  const merged = mergeDocs(base, mine, theirs);
  assert.deepEqual(lines(merged.doc), ["Top", "Theirs", "Mine A", "Mine B", "Bottom"]);
  assert.equal(merged.kept, 0);
});

test("pressing Enter mid-edit still merges the paragraph the other person typed in", () => {
  const base = doc(p("Intro"), p("Notes"), p("Outro"));
  const mine = doc(p("Intro"), p("Notes from Monday"), p("Second thought"), p("Outro"));
  const theirs = doc(p("Intro"), p("Notes (draft)"), p("Outro"));
  assert.deepEqual(lines(mergeDocs(base, mine, theirs).doc), ["Intro", "Notes (draft) from Monday", "Second thought", "Outro"]);
});

test("a heading level change and a text edit to the same heading merge", () => {
  const merged = mergeDocs(doc(h(1, "Plan")), doc(h(2, "Plan")), doc(h(1, "Plan for May"))).doc;
  assert.deepEqual(merged.content, [h(2, "Plan for May")]);
});

test("edits inside nested lists merge item by item", () => {
  const base = doc(ul(li(p("Eggs")), li(p("Milk")), li(p("Bread"))));
  const mine = doc(ul(li(p("Eggs x12")), li(p("Milk")), li(p("Bread"))));
  const theirs = doc(ul(li(p("Eggs")), li(p("Milk")), li(p("Bread")), li(p("Coffee"))));
  assert.deepEqual(lines(mergeDocs(base, mine, theirs).doc), ["Eggs x12 | Milk | Bread | Coffee"]);
  const sameItem = mergeDocs(base, doc(ul(li(p("Eggs, large")), li(p("Milk")), li(p("Bread")))), doc(ul(li(p("Eggs")), li(p("Oat milk")), li(p("Bread")))));
  assert.deepEqual(lines(sameItem.doc), ["Eggs, large | Oat milk | Bread"]);
});

test("without deep merging, a block both changed is kept twice instead of mixed", () => {
  const merged = mergeDocs(doc(p("A"), p("Plan")), doc(p("A"), p("Plan, mine")), doc(p("A"), p("Plan, theirs")), { deep: false });
  assert.deepEqual(lines(merged.doc), ["A", "Plan, theirs", "Plan, mine"]);
  assert.equal(merged.kept, 1);
});

test("key order and empty attrs from the database do not count as edits", () => {
  const stored: PageDocument = { type: "doc", content: [{ content: [{ text: "Hi", type: "text", marks: [] }], type: "paragraph", attrs: {} }, { type: "paragraph" }] };
  const editor = doc(p("Hi"), { type: "paragraph", content: [] });
  assert.ok(sameDoc(stored, editor));
  const theirs: PageDocument = { type: "doc", content: [{ content: [{ text: "Hi there", type: "text" }], type: "paragraph" }, { type: "paragraph" }] };
  const merged = mergeDocs(stored, doc(p("Hi"), p("Mine")), theirs);
  assert.deepEqual(lines(merged.doc), ["Hi there", "Mine"]);
});

test("one side unchanged gives the other side exactly", () => {
  const base = doc(p("Same"));
  const changedDoc = doc(p("Changed"), ul(li(p("x"))));
  assert.ok(sameDoc(mergeDocs(base, base, changedDoc).doc, changedDoc));
  assert.ok(sameDoc(mergeDocs(base, changedDoc, base).doc, changedDoc));
});

test("an emptied page stays a valid document", () => {
  const merged = mergeDocs(doc(p("Gone")), doc(), doc());
  assert.deepEqual(merged.doc, { type: "doc", content: [{ type: "paragraph" }] });
});

test("a long page with edits at both ends merges quickly", () => {
  const blocks = Array.from({ length: 3000 }, (_, index) => p(`Paragraph ${index} with some words in it`));
  const base = doc(...blocks);
  const mine = doc(p("New first line"), ...blocks.slice(0, 2999), p("Paragraph 2999 with some words in it, edited"));
  const theirs = doc(...blocks.slice(0, 1500), p("Inserted in the middle"), ...blocks.slice(1500));
  const started = performance.now();
  const merged = mergeDocs(base, mine, theirs);
  assert.ok(performance.now() - started < 1000, "under a second");
  const text = lines(merged.doc);
  assert.equal(text.length, 3002);
  assert.equal(text[0], "New first line");
  assert.equal(text[1501], "Inserted in the middle");
  assert.equal(text[3001], "Paragraph 2999 with some words in it, edited");
});

test("normalised attributes on every block do not hide the other person's edit", () => {
  const stored = doc(p("One"), p("Two"), p("Three"));
  const withAlign = (node: PageNode): PageNode => ({ ...node, attrs: { textAlign: null } });
  const mine = doc(withAlign(p("One")), withAlign(p("Two, mine")), withAlign(p("Three")));
  const theirs = doc(p("One"), p("Two"), p("Three"), p("Four"));
  assert.deepEqual(lines(mergeDocs(stored, mine, theirs).doc), ["One", "Two, mine", "Three", "Four"]);
});

/** A small seeded generator, so a failure can be replayed. */
function random(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

function edit(base: PageDocument, tag: string, next: () => number): { doc: PageDocument; added: string[] } {
  const added: string[] = [];
  const blocks = base.content.map((block) => ({ words: textOf(block).split(" ").filter(Boolean) }));
  const edits = 1 + Math.floor(next() * 4);
  for (let index = 0; index < edits; index += 1) {
    const roll = next();
    const word = `${tag}${index}x${Math.floor(next() * 1e6)}`;
    const plain = (text: string) => !/^[mt]\d+x/.test(text);
    if (roll < 0.15 && blocks.length > 1) {
      const at = Math.floor(next() * blocks.length);
      if (blocks[at]!.words.every(plain)) blocks.splice(at, 1);
    }
    else if (roll < 0.3) {
      blocks.splice(Math.floor(next() * (blocks.length + 1)), 0, { words: [word] });
      added.push(word);
    } else if (blocks.length) {
      const block = blocks[Math.floor(next() * blocks.length)]!;
      if (roll < 0.4 && block.words.length) {
        const at = Math.floor(next() * block.words.length);
        if (plain(block.words[at]!)) block.words.splice(at, 1);
      }
      else {
        block.words.splice(Math.floor(next() * (block.words.length + 1)), 0, word);
        added.push(word);
      }
    }
  }
  return { doc: doc(...blocks.map((block) => p(block.words.join(" ")))), added };
}

test("random concurrent edits never lose a word either person typed", () => {
  for (let seed = 1; seed <= 1500; seed += 1) {
    const next = random(seed);
    const base = doc(...Array.from({ length: 2 + Math.floor(next() * 5) }, (_, index) => p(`base${index} alpha beta gamma`)));
    const mine = edit(base, "m", next);
    const theirs = edit(base, "t", next);
    const merged = mergeDocs(base, mine.doc, theirs.doc);
    const text = ` ${lines(merged.doc).join(" ")} `;
    for (const word of [...mine.added, ...theirs.added]) {
      assert.equal(text.match(new RegExp(`(?<![\\w])${word}(?![\\w])`, "g"))?.length ?? 0, 1, `seed ${seed}: ${word} appears once in ${text}`);
    }
  }
});
