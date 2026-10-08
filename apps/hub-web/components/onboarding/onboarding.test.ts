import assert from "node:assert/strict";
import test from "node:test";
import { TEMPLATE_CARDS } from "@ensemble/shared-types/manifest";
import { boardSpecs, specPool } from "@/components/desk/live-board";
import { contextTabs, tabKey } from "@/components/desk/context-tabs";
import { DESK_IDS, type DeskId } from "@/components/desk/desks";
import { arrange, readLayout } from "@/components/desk/layout";
import { roleFromProfession } from "./roles";
import { sampleBoard, sampleLive } from "./sample";

test("every template tile exists in the live tile pool and fills from sample rows", () => {
  const pool = specPool();
  for (const card of TEMPLATE_CARDS) {
    assert.ok((DESK_IDS as readonly string[]).includes(card.desk), card.id);
    const live = sampleLive(card.role, null, new Date("2026-10-08T09:00:00Z"));
    const layout = readLayout({ v: 1, exact: true, hidden: [], tiles: card.tiles.map(([key, c, r]) => ({ key, c, r })) });
    const shown = arrange(boardSpecs(card.desk as DeskId), pool, layout);
    assert.deepEqual(
      shown.map((spec) => spec.key),
      card.tiles.map(([key]) => key),
      `${card.id} draws exactly its tiles`,
    );
    for (const spec of shown) {
      const filled = spec.rows(live).length > 0 || Boolean(spec.stat?.(live)) || spec.kind === "attendance";
      assert.ok(filled, `${card.id}: ${spec.key} has no sample rows`);
    }
  }
});

test("sample board spreads tasks over lanes and never saves anything", () => {
  const live = sampleLive("manager", { preview: { project: "Launch", tasks: [{ title: "Beta to ten customers", people: [] }], people: [], deliverables: [{ title: "GA", dueInDays: 30 }] } });
  assert.equal(live.projects[0]?.name, "Launch");
  assert.equal(live.tasks[0]?.title, "Beta to ten customers");
  assert.equal(live.deliverables[0]?.title, "GA");
  const lanes = sampleBoard(live);
  assert.deepEqual(lanes.map((lane) => lane.id), ["todo", "doing", "stuck", "done"]);
  assert.ok(lanes.every((lane) => lane.cards.length > 0));
  assert.ok(!lanes.find((lane) => lane.id === "done")!.cards.some((card) => /^Mock /.test(card.title)));
});

test("a profession typed earlier picks the role", () => {
  assert.equal(roleFromProfession("Software engineer"), "engineer");
  assert.equal(roleFromProfession("PhD student"), "student");
  assert.equal(roleFromProfession("Associate attorney"), "lawyer");
  assert.equal(roleFromProfession("Head of Maths"), "manager");
  assert.equal(roleFromProfession("Secondary school teacher"), "teacher");
  assert.equal(roleFromProfession("Indie maker"), "vibe");
  assert.equal(roleFromProfession(""), null);
  assert.equal(roleFromProfession("Chef"), null);
});

test("every desk's Context has people, projects, graph, and files", () => {
  for (const id of DESK_IDS) {
    const tabs = contextTabs(id);
    assert.equal(tabs[0], "Overview", id);
    for (const shared of ["People", "Projects", "Graph", "Artifacts & sync"]) assert.ok(tabs.includes(shared), `${id} lacks ${shared}`);
    assert.equal(new Set(tabs).size, tabs.length, `${id} repeats a tab`);
  }
  assert.ok(contextTabs("semester", true).includes("Learning"));
  assert.deepEqual(contextTabs("branch").map(tabKey), ["overview", "people", "projects", "repos", "reviews", "deploys", "graph", "artifacts"]);
  assert.ok(!contextTabs("semester").map(tabKey).includes("repos"));
});
