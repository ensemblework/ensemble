import assert from "node:assert/strict";
import test from "node:test";
import { composerRanges, keptMentions, mentionAt, mentionRanges, plainMentions, replaceMention, splitAtRanges } from "./text";

test("the token at the caret: after a space or at the start, never inside an email", () => {
  assert.deepEqual(mentionAt("Ping @anu", 9), { at: 5, query: "anu", spaced: false });
  assert.deepEqual(mentionAt("@", 1), { at: 0, query: "", spaced: false });
  assert.deepEqual(mentionAt("(@people:mi", 11), { at: 1, query: "people:mi", spaced: false });
  assert.equal(mentionAt("mira@fieldnote", 14), null);
  assert.equal(mentionAt("@anu reet", 9), null);
  assert.equal(mentionAt("@anu\nreet", 9), null);
  assert.equal(mentionAt("no at here", 10), null);
  assert.deepEqual(mentionAt("@people:Anika Rao", 17), { at: 0, query: "people:Anika Rao", spaced: true });
  assert.equal(mentionAt("@nobody:Anika Rao", 17), null);
  assert.deepEqual(mentionAt("Ping @anu tomorrow", 9), { at: 5, query: "anu", spaced: false });
});

test("a pick replaces the token, the rest of its word, and never doubles a space", () => {
  assert.deepEqual(replaceMention("Ping @anu", mentionAt("Ping @anu", 9)!, 9, "@people:Anika Rao "), { value: "Ping @people:Anika Rao ", caret: 23 });
  assert.deepEqual(replaceMention("@anika ok", mentionAt("@anika ok", 4)!, 4, "@people:Anika Rao "), { value: "@people:Anika Rao ok", caret: 18 });
  assert.deepEqual(replaceMention("@peo", mentionAt("@peo", 4)!, 4, "@people:"), { value: "@people:", caret: 8 });
});

test("only the picked mentions still in the text come back, once each", () => {
  const picked = [
    { kind: "people" as const, id: "p1", label: "Anika Rao" },
    { kind: "diagram" as const, id: "d1", label: "Transformer" },
    { kind: "people" as const, id: "p1", label: "Anika Rao" },
  ];
  assert.deepEqual(keptMentions("Ask @people:Anika Rao twice @people:Anika Rao", picked), [picked[0]]);
  assert.deepEqual(keptMentions("nothing left", picked), []);
});

test("plain text keeps the names and drops the prefixes", () => {
  assert.equal(plainMentions("Remind @people:Priya Shah about @project:Atlas Friday"), "Remind Priya Shah about Atlas Friday");
  assert.equal(plainMentions("mail mira@people:x and @nobody:y"), "mail mira@people:x and @nobody:y");
});

const CLONE = { kind: "task" as const, id: "task-1", label: "Clone a repo" };
const MIRA = { kind: "people" as const, id: "p-mira", label: "Mira Chen" };
const pieces = (text: string, ranges: ReturnType<typeof mentionRanges>) =>
  splitAtRanges(text, ranges).map((piece) => (piece.range ? [piece.text, piece.range.kind, piece.range.mention?.id ?? null] : piece.text));

test("saved mentions mark exactly their label, ignoring case, and never guess the end of an unknown one", () => {
  const text = "@task:Clone a repo do this on my machine";
  assert.deepEqual(pieces(text, mentionRanges(text, [CLONE])), [["@task:Clone a repo", "task", "task-1"], " do this on my machine"]);
  assert.deepEqual(pieces(text, mentionRanges(text, [])), [text]);
  assert.deepEqual(mentionRanges("@todo:clone A REPO.", [CLONE]).map((range) => [range.from, range.to]), [[0, 18]]);
  assert.deepEqual(mentionRanges("@task:Clone a repository", [CLONE]), [], "a label that runs on into a longer word is not this mention");
  assert.deepEqual(mentionRanges("mira@task:Clone a repo", [CLONE]), [], "an @ inside a word is not a mention");
  assert.deepEqual(mentionRanges("@people:Clone a repo", [CLONE]), [], "the kind has to match");
});

test("the longest label wins, several mentions are marked in order, and a date also matches its day", () => {
  const short = { kind: "task" as const, id: "task-2", label: "Clone" };
  const date = { kind: "date" as const, id: "2026-10-20", label: "Oct 20, 2026" };
  const text = "Ask @person:Mira Chen to @task:Clone a repo by @date:2026-10-20, or (@date:Oct 20, 2026)";
  assert.deepEqual(pieces(text, mentionRanges(text, [short, CLONE, MIRA, date])), [
    "Ask ",
    ["@person:Mira Chen", "people", "p-mira"],
    " to ",
    ["@task:Clone a repo", "task", "task-1"],
    " by ",
    ["@date:2026-10-20", "date", "2026-10-20"],
    ", or (",
    ["@date:Oct 20, 2026", "date", "2026-10-20"],
    ")",
  ]);
});

test("a box being typed in also marks bare prefixes and the token at the caret", () => {
  const text = "Ping @people:Mira Chen and @task: then @dia";
  assert.deepEqual(pieces(text, composerRanges(text, [MIRA], null)), [
    "Ping ",
    ["@people:Mira Chen", "people", "p-mira"],
    " and ",
    ["@task:", "task", null],
    " then @dia",
  ]);
  const typing = "Ask @people:Mi";
  assert.deepEqual(pieces(typing, composerRanges(typing, [], { from: 4, to: typing.length })), ["Ask ", ["@people:Mi", "people", null]]);
  const loose = "Ask @anik";
  assert.deepEqual(pieces(loose, composerRanges(loose, [], { from: 4, to: loose.length })), ["Ask ", ["@anik", null, null]]);
  assert.deepEqual(pieces("@task", composerRanges("@task", [], { from: 0, to: 5 })), [["@task", "task", null]]);
});
