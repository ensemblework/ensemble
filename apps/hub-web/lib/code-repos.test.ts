import assert from "node:assert/strict";
import test from "node:test";
import { guessRepo, repoName, repoViews, shortBranch, usedWithin } from "./code-repos.js";

const RUN = "/home/me/ensemble-workspace/runs/082db2b5-7f47-467a-ae2a-d3c265595b70";
const OLDER = "/home/me/ensemble-workspace/runs/27df78f3-adb6-44b2-ae80-2d2eca644d01";

test("without details a run checkout is never named by its folder id", () => {
  const views = repoViews({ repos: ["/Users/a/codes/rea", RUN, `${OLDER}/widgets`], roots: [] });
  assert.deepEqual(
    views.map((view) => [view.name, view.kind, view.note]),
    [
      ["rea", "folder", null],
      ["Run checkout", "run", "run checkout"],
      ["widgets", "run", "run checkout"],
    ],
  );
  assert.ok(views.every((view) => !/[0-9a-f]{8}-[0-9a-f]{4}/.test(`${view.name}${view.note}`)));
  assert.equal(guessRepo("/x/0123456789abcdef0123").name, "Run checkout");
});

test("details name a run by its task and origin, show an origin that differs from a folder's name, and fold repeated runs", () => {
  const views = repoViews({
    repos: ["/w/live/ensemble", "/w/live/custom-boards", RUN, OLDER],
    roots: [],
    details: [
      { path: "/w/live/ensemble", name: "ensemble", kind: "workspace", remote: "acme/ensemble", branch: "main", at: "2026-10-20T00:00:00Z" },
      { path: "/w/live/custom-boards", name: "custom-boards", kind: "workspace", remote: "acme/ensemble", branch: "boards", at: "2026-10-28T00:00:00Z" },
      { path: RUN, name: "acme/widgets", kind: "run", remote: "acme/widgets", branch: "ensemble/tidy", taskTitle: "Tidy the widgets", at: "2026-10-29T00:00:00Z" },
      { path: OLDER, name: "acme/widgets", kind: "run", remote: "acme/widgets", branch: "ensemble/tidy", taskTitle: "Tidy the widgets", at: "2026-10-27T00:00:00Z" },
    ],
  });
  assert.deepEqual(
    views.map((view) => [view.name, view.note, view.others.map((other) => other.path)]),
    [
      ["Tidy the widgets", "run checkout · acme/widgets", [OLDER]],
      ["custom-boards", "acme/ensemble", []],
      ["ensemble", null, []],
    ],
  );
  assert.equal(repoName(views[0]!), "acme/widgets");
  assert.equal(usedWithin(views[0]!, 14, Date.parse("2026-10-30T00:00:00Z")), true);
  assert.equal(usedWithin({ at: null }, 14), false);
});

test("a branch named after a job shows without the job id", () => {
  assert.equal(shortBranch("ensemble/57f5a368-0e38-464d-9d8b-320e2b02fe14/clone-a-repo"), "ensemble/…/clone-a-repo");
  assert.equal(shortBranch("main"), "main");
  assert.equal(shortBranch(null), null);
});
