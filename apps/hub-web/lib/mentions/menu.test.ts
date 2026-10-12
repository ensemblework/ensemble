import assert from "node:assert/strict";
import test from "node:test";
import type { Entity } from "../api";
import { looksAutomated, matchQuality, mentionInsertText, mentionItems, type MentionMenuItem } from "./menu";

const plotRows = (): Entity[] => [
  { kind: "plot", id: "space-a", label: "Training", detail: "Plot space · 1 tile", isSpace: true },
  { kind: "plot", id: "space-b", label: "Training", detail: "Plot space · 1 tile", isSpace: true },
  { kind: "plot", id: "space-a/accuracy", label: "Accuracy", detail: "", parentId: "space-a" },
  { kind: "plot", id: "space-b/loss", label: "Loss", detail: "", parentId: "space-b" },
  { kind: "plot", id: "saved-id", label: "Untitled plot", detail: "", parentId: "saved" },
  { kind: "dataset", id: "data-id", label: "epochs.csv", detail: "CSV", parentId: "data" },
];

const workRows = (): Entity[] => [
  { kind: "people", id: "p-alerts", label: "alerts", detail: "alerts@bank.example" },
  { kind: "people", id: "p-support", label: "support", detail: "support@shop.example" },
  { kind: "people", id: "p-nse", label: "nse_alerts", detail: "nse_alerts@exchange.example" },
  { kind: "people", id: "p-anu-bot", label: "anika.updates", detail: "updates@anika.example" },
  { kind: "people", id: "p-anika", label: "Anika Rao", detail: "anika@fieldnote.example" },
  { kind: "people", id: "p-mira", label: "Mira Chen", detail: "mira@fieldnote.example" },
  { kind: "people", id: "p-al", label: "Al Reyes", detail: "al@fieldnote.example" },
  { kind: "project", id: "proj-atlas", label: "Atlas launch", detail: "" },
  { kind: "project", id: "proj-alerting", label: "Alerting revamp", detail: "" },
  { kind: "task", id: "task-1", label: "Send the transformer notes to Anika", detail: "todo" },
  { kind: "diagram", id: "diagram-1", label: "Transformer", detail: "" },
  { kind: "diagram", id: "diagram-2", label: "Transformer block (old)", detail: "" },
  { kind: "file", id: "file-1", label: "report.pdf", detail: "2 MB" },
  { kind: "dataset", id: "data-id", label: "epochs.csv", detail: "CSV", parentId: "data" },
  { kind: "plot", id: "saved-id", label: "Transformer loss", detail: "", parentId: "saved" },
];

const on = () => true;
const off = () => false;
const ids = (items: MentionMenuItem[]) => items.map((item) => ("id" in item ? item.id : item.type === "group" ? `@${item.prefix}` : item.label));

test("@ offers Ask Ensemble and one Plots category, not every plot or blank plot creation", () => {
  const items = mentionItems("", plotRows, on, on, { editor: true });
  assert.equal(items[0]?.label, "Ask Ensemble");
  assert.equal(items.filter((item) => "kind" in item && item.kind === "plot").length, 1);
  assert.equal(items.some((item) => item.type === "create" && item.kind === "plot"), false);
  assert.equal(mentionItems("ensemble", plotRows, on, on, { editor: true })[0]?.label, "Ask Ensemble");
});

test("plot spaces drill down by stable id even when their names match", () => {
  const items = mentionItems("plots:", plotRows, on, on);
  const spaces = items.filter((item) => item.type === "group" && item.label === "Training");
  assert.equal(spaces.length, 2);
  assert.deepEqual(spaces.map((item) => item.type === "group" ? item.prefix : null), ["plots:space-a:", "plots:space-b:"]);
  assert.deepEqual(mentionItems("plots:space-a:", plotRows, on, on).map((item) => item.label), ["Accuracy"]);
  assert.deepEqual(mentionItems("plots:space-b:lo", plotRows, on, on).map((item) => item.label), ["Loss"]);
});

test("both plot aliases find uploaded files and saved charts are nested", () => {
  for (const prefix of ["plot", "plots"]) {
    const items = mentionItems(`${prefix}:epochs`, plotRows, on, on);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.type === "entity" && items[0].kind, "dataset");
    assert.equal("id" in items[0]! && items[0].id, "data-id");
  }
  assert.deepEqual(mentionItems("plots:saved:", plotRows, on, on).map((item) => item.label), ["Untitled plot"]);
  assert.equal(mentionItems("plots:unknown:", plotRows, on, on).length, 0);
});

test("disabled modules cannot be reached through a scoped prefix", () => {
  assert.deepEqual(mentionItems("plots:", plotRows, on, off), []);
  assert.deepEqual(mentionItems("dataset:", plotRows, on, off), []);
  assert.deepEqual(mentionItems("diagram:trans", workRows, off, on), []);
  assert.deepEqual(mentionItems("plots:", plotRows, on, () => null), []);
});

test("@ alone lists every group with its prefix; text boxes get no Ask Ensemble", () => {
  const items = mentionItems("", workRows, on, on);
  assert.equal(items.some((item) => item.type === "action"), false);
  const people = items[0];
  assert.equal(people?.type, "group");
  assert.equal(people?.type === "group" && people.shortcut, "@people:");
  assert.deepEqual(ids(items).slice(0, 3), ["@people:", "@project:", "@repo:"]);
  assert.equal(items.some((item) => item.type === "group" && item.kind === "diagram"), true);
  assert.equal(mentionItems("", workRows, off, off).some((item) => item.type === "group" && (item.kind === "diagram" || item.kind === "plot")), false);
});

test("a group typed in full scopes to it, with or without the colon, singular or plural", () => {
  for (const query of ["people", "person", "People", "people:", "person:"]) {
    const items = mentionItems(query, workRows, on, on);
    const entities = items.filter((item) => item.type === "entity");
    assert.ok(entities.length >= 7, query);
    assert.ok(entities.every((item) => item.kind === "people"), query);
  }
  const bare = mentionItems("people", workRows, on, on);
  assert.equal(bare[0]?.type, "group");
  assert.equal(bare[0]?.type === "group" && bare[0].prefix, "people:");
  assert.equal(mentionInsertText(bare[0]!), "@people:");
  assert.equal(mentionItems("people:", workRows, on, on)[0]?.type, "entity");
  for (const query of ["project", "projects", "projects:"]) {
    assert.ok(mentionItems(query, workRows, on, on).filter((item) => item.type === "entity").every((item) => item.kind === "project"), query);
  }
  assert.deepEqual(ids(mentionItems("todo", workRows, on, on)), ["@task:", "task-1"]);
  assert.deepEqual(ids(mentionItems("diagrams:transformer", workRows, on, on)), ["diagram-1", "diagram-2"]);
  assert.deepEqual(ids(mentionItems("diagram:transformer", workRows, on, on)), ["diagram-1", "diagram-2"]);
  assert.deepEqual(ids(mentionItems("file:report", workRows, on, on)), ["file-1"]);
});

test("scoped search ranks exact, then starts with, then a word, then contains, and matches email for people", () => {
  assert.deepEqual(ids(mentionItems("people:ani", workRows, on, on)), ["p-anika", "p-anu-bot"]);
  assert.deepEqual(ids(mentionItems("people:Anika Rao", workRows, on, on)), ["p-anika"]);
  assert.deepEqual(ids(mentionItems("people:chen", workRows, on, on)), ["p-mira"]);
  assert.deepEqual(ids(mentionItems("people:fieldnote", workRows, on, on)), ["p-anika", "p-mira", "p-al"]);
  assert.deepEqual(ids(mentionItems("people:", workRows, on, on)).slice(0, 3), ["p-anika", "p-mira", "p-al"]);
});

test("an unscoped search ranks every kind and puts the best match first", () => {
  const items = mentionItems("anik", workRows, on, on);
  assert.equal(items[0]?.type === "entity" && items[0].id, "p-anika");
  assert.equal(items[0]?.type === "entity" && items[0].kindLabel, "Person");
  assert.equal(mentionInsertText(items[0]!), "@people:Anika Rao ");
  assert.deepEqual(ids(items), ["p-anika", "p-anu-bot", "task-1"]);

  const transformer = mentionItems("transformer", workRows, on, on);
  assert.deepEqual(ids(transformer), ["diagram-1", "diagram-2", "saved-id", "task-1"]);
  assert.equal(transformer[0]?.type === "entity" && transformer[0].kindLabel, "Diagram");
  assert.equal(mentionInsertText(transformer[0]!), "@diagram:Transformer ");

  assert.deepEqual(ids(mentionItems("transformer", workRows, off, off)), ["task-1"]);
  assert.ok(mentionItems("a", workRows, on, on).length <= 10);
});

test("automated senders stay listed, after real names that match as well", () => {
  assert.deepEqual(ids(mentionItems("al", workRows, on, on)), ["p-al", "proj-alerting", "p-alerts", "p-nse"]);
  assert.ok(ids(mentionItems("people:", workRows, on, on)).includes("p-nse"));
  assert.equal(looksAutomated("alerts"), true);
  assert.equal(looksAutomated("support"), true);
  assert.equal(looksAutomated("Support"), true);
  assert.equal(looksAutomated("nse_alerts"), true);
  assert.equal(looksAutomated("billing@shop.example"), true);
  assert.equal(looksAutomated("Anika Rao"), false);
  assert.equal(looksAutomated("Anika"), false);
});

test("a partial group name finds the group, and Ask Ensemble only shows in pages", () => {
  const items = mentionItems("peo", workRows, on, on);
  assert.equal(items[0]?.type === "group" && items[0].prefix, "people:");
  assert.equal(mentionItems("ens", workRows, on, on, { editor: true })[0]?.type, "action");
  assert.equal(mentionItems("ens", workRows, on, on).some((item) => item.type === "action"), false);
  assert.equal(mentionItems("diagram x", workRows, on, on, { editor: true }).at(-1)?.type, "create");
  assert.equal(mentionItems("diagram x", workRows, on, on).some((item) => item.type === "create"), false);
});

test("dates scope like any group", () => {
  const items = mentionItems("date:2026-10-14", workRows, on, on);
  assert.equal(items[0]?.type === "entity" && items[0].id, "2026-10-14");
  assert.equal(mentionItems("date", workRows, on, on)[0]?.type, "group");
  assert.equal(mentionItems("date:zzz", workRows, on, on)[0]?.type, "hint");
  assert.equal(mentionInsertText(mentionItems("date:zzz", workRows, on, on)[0]!), null);
});

test("match quality", () => {
  assert.equal(matchQuality("Anika", "anika"), 0);
  assert.equal(matchQuality("Anika Rao", "ani"), 1);
  assert.equal(matchQuality("Notes for Anika", "ani"), 2);
  assert.equal(matchQuality("report-final.pdf", "final"), 2);
  assert.equal(matchQuality("Danika", "ani"), 3);
  assert.equal(matchQuality("Mira", "ani"), null);
});
