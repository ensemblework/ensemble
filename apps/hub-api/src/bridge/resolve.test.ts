import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bridgeAuthRejected,
  bridgeMethodRejected,
  BROWSER_SESSION_REQUIRED,
  deviceTokenRejected,
  knownTokenScope,
  readOnlyTokenRejected,
  requireBrowserSession,
  DEFAULT_INTERNAL_TOKEN,
} from "./auth.js";
import { resolveBriefAnchor, type TaskRef } from "./resolve.js";
import { normalizeRepoName, zonedDayRange } from "./text.js";

const task = (id: string, status = "in_progress", updatedAt = "2026-09-20T00:00:00.000Z"): TaskRef => ({
  id,
  title: `Task ${id}`,
  status,
  updatedAt,
  repoId: "repo-1",
  projectId: "project-1",
});

describe("normalizeRepoName", () => {
  it("accepts owner/name and GitHub remotes", () => {
    assert.equal(normalizeRepoName("gim-home/mosaic"), "gim-home/mosaic");
    assert.equal(normalizeRepoName("https://github.com/gim-home/mosaic.git"), "gim-home/mosaic");
    assert.equal(normalizeRepoName("git@github.com:gim-home/mosaic.git"), "gim-home/mosaic");
    assert.equal(normalizeRepoName("ssh://git@github.com/gim-home/mosaic"), "gim-home/mosaic");
  });

  it("rejects values that are not a repository name", () => {
    assert.equal(normalizeRepoName(""), null);
    assert.equal(normalizeRepoName("mosaic"), null);
    assert.equal(normalizeRepoName(undefined), null);
  });
});

describe("resolveBriefAnchor", () => {
  it("does not invent a task for an untracked repository", () => {
    const result = resolveBriefAnchor({
      repoRequested: "other/repo",
      repoFound: false,
      branch: "main",
      branchTasks: [task("a")],
      openTasksOnRepo: [],
    });
    assert.equal(result.kind, "untracked_repo");
  });

  it("lists candidates when a branch matches more than one task", () => {
    const result = resolveBriefAnchor({
      repoRequested: "acme/app",
      repoFound: true,
      branch: "feature",
      branchTasks: [task("a"), task("b")],
      openTasksOnRepo: [task("a"), task("b")],
    });
    assert.equal(result.kind, "ambiguous");
    if (result.kind === "ambiguous") assert.equal(result.candidates.length, 2);
  });

  it("does not guess a task when the branch matches nothing", () => {
    const result = resolveBriefAnchor({
      repoRequested: "acme/app",
      repoFound: true,
      branch: "feature",
      branchTasks: [],
      openTasksOnRepo: [task("recent")],
    });
    assert.equal(result.kind, "branch_unmatched");
  });

  it("does not treat a done branch match as the current task", () => {
    const result = resolveBriefAnchor({
      repoRequested: "acme/app",
      repoFound: true,
      branch: "feature",
      branchTasks: [task("done-one", "done")],
      openTasksOnRepo: [],
    });
    assert.equal(result.kind, "branch_unmatched");
  });

  it("uses the newest open task on the repo when no branch is given", () => {
    const result = resolveBriefAnchor({
      repoRequested: "acme/app",
      repoFound: true,
      branch: null,
      branchTasks: [],
      openTasksOnRepo: [task("new", "todo", "2026-09-29T00:00:00.000Z"), task("old", "todo", "2026-09-01T00:00:00.000Z")],
    });
    assert.equal(result.kind, "task");
    if (result.kind === "task") {
      assert.equal(result.task.id, "new");
      assert.equal(result.via, "recent");
      assert.equal(result.otherOpen.length, 1);
    }
  });

  it("returns repo context when the repo has no open task", () => {
    const result = resolveBriefAnchor({
      repoRequested: "acme/app",
      repoFound: true,
      branch: null,
      branchTasks: [],
      openTasksOnRepo: [],
    });
    assert.equal(result.kind, "repo_only");
  });

  it("says so when nothing identifies the work", () => {
    const result = resolveBriefAnchor({
      repoRequested: null,
      repoFound: false,
      branch: null,
      branchTasks: [],
      openTasksOnRepo: [],
    });
    assert.equal(result.kind, "no_anchor");
  });
});

describe("bridge auth and methods", () => {
  it("refuses the dev bypass and the default internal token", () => {
    assert.match(bridgeAuthRejected("bypass", "private") ?? "", /ENSEMBLE_DEV_AUTH_BYPASS/);
    assert.match(bridgeAuthRejected("internal", DEFAULT_INTERNAL_TOKEN, false) ?? "", /dev-internal-token/);
    assert.equal(bridgeAuthRejected("internal", DEFAULT_INTERNAL_TOKEN, true), null);
    assert.equal(bridgeAuthRejected("internal", "a-private-token", false), null);
    assert.equal(bridgeAuthRejected("token", DEFAULT_INTERNAL_TOKEN, false), null);
    assert.equal(bridgeAuthRejected("session", DEFAULT_INTERNAL_TOKEN, false), null);
  });

  it("lets a read-only key read the bridge and nothing else", () => {
    assert.equal(readOnlyTokenRejected("full", "POST", "/api/tasks"), null);
    assert.equal(readOnlyTokenRejected(undefined, "DELETE", "/api/tokens/x"), null);
    assert.equal(readOnlyTokenRejected("bridge", "GET", "/api/bridge/gaps"), null);
    assert.equal(readOnlyTokenRejected("bridge", "HEAD", "/api/bridge/today"), null);
    assert.equal(readOnlyTokenRejected("bridge", "GET", "/api/bridge/tasks?limit=1"), null);
    assert.match(readOnlyTokenRejected("bridge", "POST", "/api/bridge/tasks") ?? "", /read-only/);
    assert.match(readOnlyTokenRejected("bridge", "GET", "/api/tasks") ?? "", /read-only/);
    assert.match(readOnlyTokenRejected("bridge", "POST", "/api/connect/token") ?? "", /read-only/);
    assert.match(readOnlyTokenRejected("bridge", "DELETE", "/api/tokens/x") ?? "", /read-only/);
  });

  it("mints a key only from a signed-in page", () => {
    assert.equal(BROWSER_SESSION_REQUIRED, "Create this key from the Ensemble page you are signed in to.");
    for (const via of ["session", "bypass", "desktop"] as const) {
      assert.doesNotThrow(() => requireBrowserSession({ authVia: via }));
    }
    for (const via of ["token", "internal", undefined] as const) {
      assert.throws(
        () => requireBrowserSession({ authVia: via }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message, BROWSER_SESSION_REQUIRED);
          assert.equal((error as { statusCode?: number }).statusCode, 403);
          return true;
        },
      );
    }
  });

  it("accepts full, bridge, and device scopes and rejects anything else", () => {
    assert.equal(knownTokenScope("full"), "full");
    assert.equal(knownTokenScope("bridge"), "bridge");
    assert.equal(knownTokenScope("device"), "device");
    assert.equal(knownTokenScope("admin"), null);
    assert.equal(knownTokenScope(""), null);
    assert.equal(knownTokenScope("FULL"), null);
  });

  it("lets a device key call only its own computer's routes", () => {
    assert.equal(deviceTokenRejected("full", "POST", "/api/tokens"), null);
    assert.equal(deviceTokenRejected("device", "POST", "/api/devices/self/heartbeat"), null);
    assert.equal(deviceTokenRejected("device", "POST", "/api/devices/self/claim"), null);
    assert.equal(deviceTokenRejected("device", "GET", "/api/devices/self/events"), null);
    assert.equal(deviceTokenRejected("device", "POST", "/api/devices/self/jobs/abc/progress"), null);
    assert.equal(deviceTokenRejected("device", "GET", "/api/devices/self/decisions/abc"), null);
    assert.match(deviceTokenRejected("device", "POST", "/api/tokens") ?? "", /your computer/);
    assert.match(deviceTokenRejected("device", "POST", "/api/agent/assign") ?? "", /your computer/);
    assert.match(deviceTokenRejected("device", "GET", "/api/devices") ?? "", /your computer/);
    assert.match(deviceTokenRejected("device", "POST", "/api/devices/pair") ?? "", /your computer/);
    assert.match(deviceTokenRejected("device", "DELETE", "/api/devices/abc") ?? "", /your computer/);
  });

  it("rejects every write method on /api/bridge", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.equal(bridgeMethodRejected(method, "/api/bridge/brief"), true);
      assert.equal(bridgeMethodRejected(method, "/api/tasks"), false);
    }
    assert.equal(bridgeMethodRejected("GET", "/api/bridge/tasks"), false);
  });
});

describe("zonedDayRange", () => {
  it("returns a 24h window labelled with the local date", () => {
    const range = zonedDayRange("Asia/Kolkata", new Date("2026-09-29T20:30:00.000Z"));
    assert.equal(range.date, "2026-09-30");
    assert.equal(range.to.getTime() - range.from.getTime(), 86_400_000);
    assert.ok(range.from.toISOString() < "2026-09-29T20:30:00.000Z");
    assert.ok(range.to.toISOString() > "2026-09-29T20:30:00.000Z");
  });
});
