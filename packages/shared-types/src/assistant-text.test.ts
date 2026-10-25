import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantRef } from "./assistant.js";
import { asksForIds, displayRefs, formatEntityText, linkedRefs, refsInText } from "./assistant-text.js";

const BRIEF = "3f2a9c1e-7b44-4d2a-9a51-0c8f5e6d7b10";
const CALL = "8d1b2c3e-4f50-4a61-8b72-9c83d4e5f601";
const LAUNCH_TASK = "11111111-2222-4333-8444-555555555555";
const LAUNCH_PROJECT = "66666666-7777-4888-9999-aaaaaaaaaaaa";
const UNKNOWN = "deadbeef-0000-4000-8000-000000000001";

const refs: AssistantRef[] = [
  { kind: "task", id: BRIEF, label: "Draft brief" },
  { kind: "task", id: CALL, label: "Call Mira" },
];

test("a known id becomes its linked title; an unknown id is left alone", () => {
  assert.equal(formatEntityText(`Created ${BRIEF} and ${UNKNOWN}.`, refs), `Created [Draft brief](/tasks/${BRIEF}) and ${UNKNOWN}.`);
});

test("an id annotating its own title goes, and the title links", () => {
  assert.equal(
    formatEntityText(`Added 2 tasks: “Draft brief” (${BRIEF}), “Call Mira” (id: ${CALL}).`, refs),
    `Added 2 tasks: “[Draft brief](/tasks/${BRIEF})”, “[Call Mira](/tasks/${CALL})”.`,
  );
  assert.equal(formatEntityText(`**Draft brief** [${BRIEF}]`, refs), `**[Draft brief](/tasks/${BRIEF})**`);
  assert.equal(formatEntityText(`the new task (task: ${BRIEF})`, refs), `the new task ([Draft brief](/tasks/${BRIEF}))`);
});

test("an old summary keeps its titles and loses the ids beside them", () => {
  const summary = `Added 2 task(s): “Draft brief” (${BRIEF}); “Call Mira” (${CALL}).`;
  assert.equal(formatEntityText(summary, [], { plain: true }), "Added 2 task(s): “Draft brief”; “Call Mira”.");
  assert.equal(formatEntityText(`Job started (${UNKNOWN})`, [], { plain: true }), `Job started (${UNKNOWN})`, "only beside a quoted title");
});

test("record links show their label, without the @", () => {
  assert.equal(formatEntityText(`See [@Draft brief](ensemble://task/${BRIEF}).`, []), `See [Draft brief](/tasks/${BRIEF}).`);
  assert.equal(formatEntityText(`See [${BRIEF}](ensemble://task/${BRIEF}).`, refs), `See [Draft brief](/tasks/${BRIEF}).`);
  assert.equal(formatEntityText(`Open [@Draft brief](ensemble://task/${BRIEF})`, [], { plain: true }), "Open Draft brief");
  assert.equal(formatEntityText(`Notes: [@Kickoff](ensemble://page/${BRIEF})`, []), `Notes: [Kickoff](/pages/${BRIEF})`);
});

test("code, quotes, URLs and link targets keep their ids", () => {
  const text = [
    `Inline \`${BRIEF}\` stays.`,
    "```",
    `id = "${BRIEF}"`,
    "```",
    `> quoted ${BRIEF}`,
    `https://app.example.com/tasks/${BRIEF} and [web](https://example.com/x/${BRIEF}) and /tasks/${BRIEF}`,
  ].join("\n");
  assert.equal(formatEntityText(text, refs), text);
});

test("ids stay when the person asked for them", () => {
  assert.equal(asksForIds("What is the ID of the brief?"), true);
  assert.equal(asksForIds("Give me the uuids"), true);
  assert.equal(asksForIds("I'd like a summary"), false);
  const text = `Draft brief is ${BRIEF}; see [@Call Mira](ensemble://task/${CALL}).`;
  assert.equal(formatEntityText(text, refs, { showIds: true }), `Draft brief is ${BRIEF}; see [Call Mira](/tasks/${CALL}).`);
});

test("while streaming, a half-written known id or record link is held back", () => {
  assert.equal(formatEntityText(`Added “Draft brief” (${BRIEF.slice(0, 6)}`, refs, { streaming: true }), "Added “Draft brief”");
  assert.equal(formatEntityText(`Added ${BRIEF.slice(0, 13)}`, refs, { streaming: true }), "Added ");
  assert.equal(formatEntityText(`Added “Draft brief” (${BRIEF}`, refs, { streaming: true }), "Added “Draft brief”");
  assert.equal(formatEntityText(`See [@Draft brief](ensemble://task/${BRIEF.slice(0, 9)}`, refs, { streaming: true }), "See Draft brief");
  assert.equal(formatEntityText("Hex word cafe", refs, { streaming: true }), "Hex word cafe", "not a prefix of a known id");
  assert.equal(formatEntityText(`Unknown ${UNKNOWN.slice(0, 10)}`, refs, { streaming: true }), `Unknown ${UNKNOWN.slice(0, 10)}`);
});

test("records with one title stay distinguishable", () => {
  const same: AssistantRef[] = [
    { kind: "task", id: LAUNCH_TASK, label: "Launch" },
    { kind: "project", id: LAUNCH_PROJECT, label: "Launch" },
    { kind: "task", id: BRIEF, label: "Review", detail: "due 2026-10-30" },
    { kind: "task", id: CALL, label: "Review" },
  ];
  assert.equal(
    formatEntityText(`${LAUNCH_TASK} in ${LAUNCH_PROJECT}; ${BRIEF} and ${CALL}`, same, { plain: true }),
    "Launch (task) in Launch (project); Review (due 2026-10-30) and Review (2)",
  );
  assert.equal(formatEntityText(`${LAUNCH_TASK} only`, same, { plain: true }), "Launch only", "only titles named in the text are told apart");
  assert.equal(displayRefs(same).size, 4);
});

test("records named in text, and records already written as links", () => {
  assert.deepEqual(refsInText(`Done: ${CALL.toUpperCase()}`, refs).map((ref) => ref.id), [CALL]);
  assert.deepEqual(linkedRefs(`(You did: Added. Records: [Draft brief](ensemble://task/${BRIEF}), “Call Mira” → ensemble://task/${CALL})`), [
    { kind: "task", id: BRIEF, label: "Draft brief" },
    { kind: "task", id: CALL, label: "Call Mira" },
  ]);
});
