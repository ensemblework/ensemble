import assert from "node:assert/strict";
import test from "node:test";
import { keptMentions, mentionAt, plainMentions, replaceMention } from "./text";

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
