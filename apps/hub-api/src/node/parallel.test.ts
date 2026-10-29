import assert from "node:assert/strict";
import test from "node:test";
import { staleChecks, workplaceOf, worktreeBranch, worktreeName, type MissionShape } from "./parallel.js";
import { worktreeKeys } from "../workspace/assign.js";
import { queueConflict } from "../workspace/queue-policy.js";

const MISSION = "1a2b3c4d-0000-4000-8000-000000000000";
const steps = [
  { id: "s1-a", kind: "build", handle: "builder" },
  { id: "s2-b", kind: "build", handle: "builder" },
  { id: "s3-ca", kind: "verify", handle: "tester", verifies: "s1-a" },
  { id: "s4-in", kind: "build", handle: "builder", integrates: ["s1-a", "s2-b"] },
  { id: "s5-ci", kind: "verify", handle: "tester", verifies: "s4-in" },
  { id: "s6-doc", kind: "write", handle: "writer" },
];
const mission = (parallel?: "serial" | "worktrees" | "snapshots", over: Partial<MissionShape> = {}): MissionShape => ({ missionId: MISSION, constraints: { folder: "~/code/Live Test", branch: "live-testing", ...(parallel ? { parallel } : {}) }, steps, ...over });

test("a build's branch is named by its mission and never sits under the mission's own branch", () => {
  assert.equal(worktreeBranch({ branch: "live-testing" }, MISSION, "s1-a"), "live-testing-1a2b3c4d/s1-a", "git cannot keep live-testing/… beside live-testing");
  assert.equal(worktreeBranch({}, MISSION, "s1-a"), "ensemble/1a2b3c4d/s1-a");
  assert.equal(worktreeBranch({ branch: " feature/x..y.lock " }, MISSION, "s1-a"), "feature/x.y-1a2b3c4d/s1-a");
  assert.equal(worktreeName("~/code/Live Test/", MISSION, "s1-a"), "live-test-1a2b3c4d-s1-a");
});

test("where each step works: serial work in the checkout; apart, each build in its worktree, its check in the same one, the rest in the checkout", () => {
  for (const step of steps) assert.deepEqual(workplaceOf(mission(), step.id), { kind: "checkout" });
  const apart = mission("worktrees");
  assert.deepEqual(workplaceOf(apart, "s1-a"), { kind: "worktree", reuse: false, name: "live-test-1a2b3c4d-s1-a", branch: "live-testing-1a2b3c4d/s1-a", detached: false, of: "s1-a" });
  assert.deepEqual(workplaceOf(apart, "s3-ca"), { ...workplaceOf(apart, "s1-a"), reuse: true });
  for (const id of ["s4-in", "s5-ci", "s6-doc"]) assert.deepEqual(workplaceOf(apart, id), { kind: "checkout" }, id);
  assert.deepEqual(workplaceOf(mission("snapshots"), "s2-b"), { kind: "worktree", reuse: false, name: "live-test-1a2b3c4d-s2-b", branch: null, detached: true, of: "s2-b" });
});

test("a pass goes stale only for another candidate left later in the same place", () => {
  const at = (minute: number) => `2026-11-14T10:${String(minute).padStart(2, "0")}:00.000Z`;
  const attempt = (outcome: string, commit: string, minute: number) => ({ n: 1, outcome, candidate: { commit }, endedAt: at(minute) });
  const run = (parallel: "serial" | "worktrees", later: Array<{ id: string; commit: string; minute: number }>) =>
    staleChecks(
      mission(parallel, {
        steps: steps.map((step) => {
          const own = later.filter((row) => row.id === step.id).map((row) => attempt("done", row.commit, row.minute));
          if (step.id === "s1-a") return { ...step, outcome: "done", attempts: [attempt("done", "aaa1111", 1), ...own] };
          if (step.id === "s3-ca") return { ...step, outcome: "pass", attempts: [attempt("pass", "aaa1111", 2)] };
          return { ...step, outcome: own.length ? "done" : "unknown", attempts: own };
        }),
      }),
    );
  assert.deepEqual(run("serial", [{ id: "s6-doc", commit: "ddd4444", minute: 3 }]).get("s3-ca"), { step: "s6-doc", handle: "writer", candidate: "ddd4444", at: at(3) });
  assert.equal(run("serial", [{ id: "s6-doc", commit: "ddd4444", minute: 1 }]).size, 0, "a change before the pass was there when it was checked");
  assert.equal(run("serial", [{ id: "s6-doc", commit: "aaa1111ffffffff", minute: 3 }]).size, 0, "the same commit, written out in full");
  assert.equal(run("worktrees", [{ id: "s4-in", commit: "ccc3333", minute: 3 }]).size, 0, "an integration in the checkout leaves a worktree's check standing");
  assert.equal(run("worktrees", [{ id: "s1-a", commit: "eee5555", minute: 3 }]).get("s3-ca")?.candidate, "eee5555", "its own build moving on in that worktree does");
});

test("on the computer's queue a build in its own worktree waits only for runs in that worktree", () => {
  const job = (id: string, keys: string[]) => ({ id, deviceId: "laptop", repoUrl: null, resourceKeys: keys, continueFromJobId: null, task: { projectId: null, repoId: null } });
  const tree = (name: string) => worktreeKeys(["label:live-test"], { mission: { id: MISSION, step: "s", worktree: { name } } });
  assert.deepEqual(tree("wt-a"), ["worktree:wt-a"]);
  assert.deepEqual(worktreeKeys(["label:live-test"], { mission: { id: MISSION, step: "s" } }), ["label:live-test"], "serial work keeps the folder's key");
  assert.equal(queueConflict(job("b", tree("wt-b")), [job("a", tree("wt-a"))]), null, "two builds at once");
  assert.equal(queueConflict(job("b", tree("wt-b")), [job("main", ["label:live-test"])]), null, "beside a run in the folder itself");
  assert.deepEqual(queueConflict(job("check", tree("wt-a")), [job("repair", tree("wt-a"))]), { jobId: "repair", reason: "folder" });
  assert.deepEqual(queueConflict(job("int", ["label:live-test"]), [job("main", ["label:live-test"])]), { jobId: "main", reason: "folder" });
});
