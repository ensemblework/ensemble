import assert from "node:assert/strict";
import test from "node:test";
import { acceptanceOf, buildPacket, contextItems, type ContextItem, type PacketInput, type PacketSource } from "./turn-packet.js";

const TASK = "ensemble://task/6f1c2b9e-0d1e-4f62-9a55-1b2c3d4e5f60";
const PERSON = "ensemble://person/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

/** A Context DB packet as `workContext` writes one for a task. */
const packetText = (title: string, owner = "Mira Chen: Lead") =>
  [
    `# ${title} (task, ${TASK})\nStatus: in progress · Priority: p1\nProject: Fieldnote web`,
    `## People\n- ${owner} (${PERSON})\n- Ben Ito: reviewer`,
    `## Related open work\n- Move exports to the worker: todo\n- … more: rel "related"`,
    `## More\nCall ensemble_context with item ${TASK} for any list in full.`,
  ].join("\n\n");

const source = (items: ContextItem[], over: Partial<PacketSource> = {}): PacketSource => ({ items, project: null, skills: [], acceptance: [], timezone: "Europe/London", ...over });

const input = (over: Partial<PacketInput> = {}): PacketInput => ({
  owner: "Mira",
  root: "/work/fieldnote",
  rules: ["- You're in /work/fieldnote.", "- Commands ask first."],
  source: source(contextItems(packetText("Fix the CSV export"), TASK)),
  profile: null,
  skills: null,
  acceptance: [],
  timezone: "Europe/London",
  now: new Date("2026-10-29T09:00:00Z"),
  handoff: null,
  message: "Please make the export keep the column order.",
  previous: null,
  ...over,
});

test("a Context DB packet becomes facts keyed by record, list and handle; hints about the packet are left out", () => {
  const items = contextItems(packetText("Fix the CSV export"), TASK);
  assert.deepEqual(
    items.map((item) => item.key),
    [`${TASK}#head`, `${TASK}|People|${PERSON}`, `${TASK}|People|Ben Ito`, `${TASK}|Related open work|Move exports to the worker`],
  );
  assert.match(items[0]!.text, /^Fix the CSV export \(task, .*\) · Status: in progress/);
  assert.equal(items[1]!.section, "Fix the CSV export (task), People");
  // A renamed person keeps their key: the handle names them.
  assert.equal(contextItems(packetText("Fix the CSV export", "Mira Chen-Ito: Lead"), TASK)[1]!.key, items[1]!.key);
});

test("facts with the same label each keep a key of their own, so one that did not change is not sent again as changed", () => {
  const text = [`# Fix the CSV export (task, ${TASK})\nStatus: in progress`, `## Comments\n- Mira Chen: keep the header row\n- Mira Chen: semicolons in the EU`].join("\n\n");
  const items = contextItems(text, TASK);
  assert.equal(new Set(items.map((item) => item.key)).size, items.length);
  const first = buildPacket(input({ source: source(items) }));
  const again = buildPacket(input({ source: source(contextItems(text, TASK)), message: "Go on.", previous: first.record.delivered }));
  assert.deepEqual([again.record.mode, again.prompt], ["none", "Go on."]);

  // Facts a computer got from an older web, with keys that clash: each is still its own.
  const clashing: ContextItem[] = [{ key: "k", section: "Notes", text: "one" }, { key: "k", section: "Notes", text: "two" }];
  const one = buildPacket(input({ source: source(clashing) }));
  const two = buildPacket(input({ source: source(clashing), message: "Go on.", previous: one.record.delivered }));
  assert.deepEqual([two.record.mode, two.prompt], ["none", "Go on."]);
});

test("of two facts with the same label, the one removed is named and the other left out, wherever they stand", () => {
  const text = (lines: string[]) => [`# Fix the CSV export (task, ${TASK})\nStatus: in progress`, `## Comments\n${lines.map((line) => `- ${line}`).join("\n")}`].join("\n\n");
  const header = "Mira Chen: keep the header row";
  const eu = "Mira Chen: semicolons in the EU";
  const both = buildPacket(input({ source: source(contextItems(text([header, eu]), TASK)) }));
  const removed = buildPacket(input({ source: source(contextItems(text([eu]), TASK)), message: "Go on.", previous: both.record.delivered }));
  assert.equal(removed.record.mode, "delta");
  assert.match(removed.prompt, /- No longer listed: [^\n]*keep the header row/);
  assert.doesNotMatch(removed.prompt, /semicolons|Changed|New:/);
  assert.deepEqual(removed.record.items, { sent: 0, changed: 0, added: 0, removed: 1 });
  // Their order alone changes nothing; one put back before the other is the only one sent.
  const swapped = buildPacket(input({ source: source(contextItems(text([eu, header]), TASK)), message: "Go on.", previous: both.record.delivered }));
  assert.deepEqual([swapped.record.mode, swapped.prompt], ["none", "Go on."]);
  const back = buildPacket(input({ source: source(contextItems(text([header, eu]), TASK)), message: "Go on.", previous: removed.record.delivered }));
  assert.match(back.prompt, /- New: [^\n]*keep the header row/);
  assert.doesNotMatch(back.prompt, /semicolons|No longer listed/);
});

test("a turn that leaves the skill folder as it was (read-only) reports the skills unchanged", () => {
  const skills = { folder: ".claude/skills", list: [{ name: "ensemble-debugging", description: "Use when a test fails." }] };
  const first = buildPacket(input({ skills }));
  const kept = buildPacket(input({ skills: "unchanged", message: "Look again.", previous: first.record.delivered }));
  assert.deepEqual([kept.record.mode, kept.prompt], ["none", "Look again."]);
  assert.deepEqual(kept.record.delivered.skills, ["ensemble-debugging"]);
  // Skills Ensemble did take away are still said to be gone.
  const gone = buildPacket(input({ skills: null, message: "Go on.", previous: kept.record.delivered }));
  assert.match(gone.prompt, /The skills listed earlier are no longer in your skill folder/);
});

test("the first turn gets the whole packet; a later turn gets the message and only the facts that changed", () => {
  const first = buildPacket(input());
  assert.equal(first.record.mode, "full");
  assert.match(first.prompt, /You're the coding agent in Mira's Ensemble Code tab, working in \/work\/fieldnote/);
  assert.match(first.prompt, /How this run works[\s\S]*- Commands ask first\./);
  assert.match(first.prompt, /Fix the CSV export \(task/);
  assert.match(first.prompt, /Today is 2026-10-29 \(Europe\/London\)/);
  assert.ok(first.prompt.endsWith("The message from Mira:\n\nPlease make the export keep the column order."));
  assert.equal(first.record.items.sent, 4);
  assert.ok(first.record.sections.some((section) => section.name === "constitution/01-authority" && section.chars > 0));
  assert.match(first.record.version, /^[0-9a-f]{16}$/);
  assert.equal(first.record.base, first.record.version);

  // The task was renamed and nothing else changed: the next turn says only that.
  const renamed = source(contextItems(packetText("Fix the CSV and XLSX export"), TASK));
  const later = buildPacket(input({ source: renamed, message: "Now the XLSX one too.", previous: first.record.delivered }));
  assert.equal(later.record.mode, "delta");
  assert.match(later.prompt, /Since your last turn[\s\S]*- Changed: Fix the CSV and XLSX export \(task/);
  assert.doesNotMatch(later.prompt, /Ben Ito|Mira Chen|Move exports|How this run works|You're the coding agent|Today is/);
  assert.ok(later.prompt.endsWith("The message from Mira:\n\nNow the XLSX one too."));
  assert.deepEqual(later.record.items, { sent: 1, changed: 1, added: 0, removed: 0 });
  assert.equal(later.record.base, first.record.version, "a later turn keeps the version its session started with");
  assert.notEqual(later.record.version, first.record.version);

  // Nothing changed: the message goes as it was written.
  const same = buildPacket(input({ source: renamed, message: "Thanks.", previous: later.record.delivered }));
  assert.equal(same.record.mode, "none");
  assert.equal(same.prompt, "Thanks.");
});

test("a later turn repeats the run's rules, profile, skills and acceptance only when they changed", () => {
  const first = buildPacket(input({ profile: "Use tabs.", skills: { folder: ".claude/skills", list: [{ name: "ensemble-debugging", description: "Use when a test fails." }] } }));
  assert.match(first.prompt, /Standing instructions from Mira[\s\S]*Use tabs\./);
  assert.match(first.prompt, /Skills for this run are in \.claude\/skills[\s\S]*- ensemble-debugging: Use when a test fails\./);
  const rules = ["- You're in /work/fieldnote.", "- There is no internet in this run."];
  const later = buildPacket(input({ rules, profile: "Use spaces.", skills: { folder: ".claude/skills", list: [{ name: "ensemble-debugging", description: "Use when a test fails." }] }, acceptance: [{ id: "AC-1", text: "XLSX keeps the order." }], previous: first.record.delivered }));
  assert.match(later.prompt, /How this run works now[\s\S]*There is no internet/);
  assert.match(later.prompt, /changed\. They now read:\nUse spaces\./);
  assert.match(later.prompt, /- AC-1: XLSX keeps the order\./);
  assert.doesNotMatch(later.prompt, /Skills for this run|skills for this run changed/);
  const again = buildPacket(input({ rules, profile: "Use spaces.", skills: { folder: ".claude/skills", list: [{ name: "ensemble-debugging", description: "Use when a test fails." }] }, acceptance: [{ id: "AC-1", text: "XLSX keeps the order." }], previous: later.record.delivered }));
  assert.equal(again.record.mode, "none");
});

test("facts cut to fit the budget are not counted as delivered: the next turn sends them as new", () => {
  const many: ContextItem[] = Array.from({ length: 200 }, (_, index) => ({ key: `${TASK}|Related open work|item ${index}`, section: "Fix the CSV export (task), Related open work", text: `Item ${index}: ${"a long note about the work ".repeat(4)}` }));
  const first = buildPacket(input({ source: source(many) }));
  const trimmed = first.record.dropped.find((row) => row.name === "code/13-context");
  assert.ok(trimmed?.items && trimmed.items > 0, "the slice was cut to its budget");
  const delivered = Object.keys(first.record.delivered.items).length;
  assert.equal(delivered, 200 - trimmed.items);
  const later = buildPacket(input({ source: source(many), previous: first.record.delivered }));
  assert.equal(later.record.items.added, Math.min(40, trimmed.items));
  assert.match(later.prompt, /- New: Fix the CSV export \(task\), Related open work: Item \d+/);
});

test("acceptance criteria come from a heading's list, ids the text gives, or a Done when line", () => {
  assert.deepEqual(acceptanceOf("Fix it.\n\nAcceptance criteria:\n- CSV keeps the order\n- [ ] XLSX keeps it too\n\nThanks"), [
    { id: "AC-1", text: "CSV keeps the order" },
    { id: "AC-2", text: "XLSX keeps it too" },
  ]);
  assert.deepEqual(acceptanceOf("AC-3: the header row stays\nDone when: the tests pass"), [
    { id: "AC-3", text: "the header row stays" },
    { id: "AC-1", text: "the tests pass" },
  ]);
  assert.deepEqual(acceptanceOf("Just a message with a list:\n- one\n- two"), []);
});
