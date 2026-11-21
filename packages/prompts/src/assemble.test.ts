import assert from "node:assert/strict";
import test from "node:test";
import { assemble, estimateTokens, renderSection, sectionText, type SectionRequest } from "./assemble.js";

const memories = (count: number) => Array.from({ length: count }, (_, index) => `- Memory ${index + 1}: ${"a fact worth keeping ".repeat(4).trim()}.`);

test("tiers come out in order, each in the order asked, with every section's size", () => {
  const result = assemble({
    surface: "node",
    sections: [
      { name: "node/80-packet-new", tier: "volatile", vars: { room: "Launch", messages: ["[#1 Mira (your owner)] hello"] } },
      { name: "node/50-context", tier: "context" },
      { name: "constitution/03-acting", tier: "stable" },
      { name: "node/00-role", tier: "stable" },
    ],
    vars: { name: "Scout", slug: "scout", owner: "Mira", role: "researcher" },
  });
  assert.equal(result.tiers.stable, `${sectionText("constitution/03-acting")}\n\nYou are Scout (@scout), an Ensemble Node: a persistent AI teammate that belongs to Mira. Role: researcher.`);
  assert.equal(result.tiers.context, sectionText("node/50-context"));
  assert.equal(result.tiers.volatile, "Room “Launch”. New messages since your last turn:\n[#1 Mira (your owner)] hello");
  assert.equal(result.text, [result.tiers.stable, result.tiers.context, result.tiers.volatile].join("\n\n"));
  assert.deepEqual(result.sections.map((row) => [row.name, row.tier]), [
    ["constitution/03-acting", "stable"],
    ["node/00-role", "stable"],
    ["node/50-context", "context"],
    ["node/80-packet-new", "volatile"],
  ]);
  for (const row of result.sections) assert.equal(row.tokens, estimateTokens("x".repeat(row.chars)));
  assert.deepEqual(result.dropped, []);
});

test("the version names the files used; the hash, the words sent", () => {
  const sections: SectionRequest[] = [{ name: "node/00-role", tier: "stable" }];
  const mira = assemble({ surface: "node", sections, vars: { name: "Scout", slug: "scout", owner: "Mira", role: "researcher" } });
  const ben = assemble({ surface: "node", sections, vars: { name: "Scout", slug: "scout", owner: "Ben", role: "researcher" } });
  assert.equal(mira.version, ben.version, "same files, same version");
  assert.notEqual(mira.hash, ben.hash);
  assert.equal(mira.hashes.stable, mira.hash, "one tier: its hash is the text's");
  const more = assemble({ surface: "node", sections: [...sections, { name: "node/33-speak", tier: "stable" }], vars: { name: "Scout", slug: "scout", owner: "Mira", role: "researcher" } });
  assert.notEqual(more.version, mira.version);
});

test("a tier's budget fills by priority; what does not fit is left out whole and listed", () => {
  const result = assemble({
    surface: "node",
    sections: [
      { name: "node/57-memories", tier: "context", priority: 4, vars: { memories: memories(3) } },
      { name: "node/55-rooms", tier: "context", priority: 3, vars: { rooms: "“Launch” [r1] (room); “Mira” [r2] (dm)" } },
      { name: "node/50-context", tier: "context", priority: 0 },
    ],
    budgets: { context: 40 },
  });
  assert.deepEqual(result.sections.map((row) => row.name), ["node/55-rooms", "node/50-context"], "kept in the order asked");
  assert.deepEqual(result.dropped.map((row) => [row.name, row.reason, row.items]), [["node/57-memories", "budget", undefined]]);
  assert.ok(result.dropped[0]!.tokens > 0);
  assert.ok(estimateTokens(result.tiers.context) <= 40);
});

test("a list that may be trimmed loses its last items, whole, never part of one", () => {
  const all = memories(30);
  const result = assemble({ surface: "node", sections: [{ name: "node/57-memories", tier: "context", vars: { memories: all }, trim: "memories" }], budgets: { context: 200 } });
  const kept = result.tiers.context.split("\n").slice(1);
  assert.ok(kept.length > 0 && kept.length < all.length);
  assert.deepEqual(kept, all.slice(0, kept.length), "the first items, each whole");
  assert.deepEqual(result.dropped.map((row) => [row.name, row.items]), [["node/57-memories", all.length - kept.length]]);
  assert.ok(estimateTokens(result.tiers.context) <= 200);
});

test("an empty list or an empty rendering leaves its section out without a note; a missing variable is an error", () => {
  const result = assemble({
    surface: "node",
    sections: [
      { name: "node/57-memories", tier: "context", vars: { memories: [] } },
      { name: "node/83-packet-step", tier: "volatile", vars: { note: "" } },
    ],
  });
  assert.equal(result.text, "");
  assert.deepEqual([result.sections, result.dropped], [[], []]);
  assert.throws(() => assemble({ surface: "node", sections: [{ name: "node/00-role", tier: "stable" }] }), /needs \{\{name\}\}/);
  assert.throws(() => renderSection("assistant/20-dates"), /needs \{\{timezone\}\}/);
});

test("a surface uses its own sections and the constitution's, never another surface's", () => {
  assert.doesNotThrow(() => assemble({ surface: "assistant", sections: [{ name: "constitution/03-acting", tier: "stable" }, { name: "assistant/30-one-space", tier: "stable" }] }));
  assert.throws(() => assemble({ surface: "assistant", sections: [{ name: "node/33-speak", tier: "stable" }] }), /not for the assistant surface/);
});

test("a variable's value is never read as a template", () => {
  const text = renderSection("node/81-packet-update", { note: "Reply with {{name}} -- as written" });
  assert.equal(text, "Update for you: Reply with {{name}} -- as written");
});
