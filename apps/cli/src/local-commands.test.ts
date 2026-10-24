import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { basesChange, basesSummary, folderLine, folderRequest, gitBases, parseGitBasesArgs } from "./local-commands.js";

test("`git bases` takes list (the default), add <branch> or remove <branch>", () => {
  assert.deepEqual(parseGitBasesArgs([]), { action: "list" });
  assert.deepEqual(parseGitBasesArgs(["list"]), { action: "list" });
  assert.deepEqual(parseGitBasesArgs(["add", "develop"]), { action: "add", branch: "develop" });
  assert.deepEqual(parseGitBasesArgs(["remove", "testing"]), { action: "remove", branch: "testing" });
  for (const wrong of [["add"], ["remove"], ["add", "a", "b"], ["list", "x"], ["drop", "testing"]]) assert.throws(() => parseGitBasesArgs(wrong), /Usage: ensemble git bases/);
});

test("a base must be a branch name git accepts, and never main, master, production or testing-live", () => {
  assert.deepEqual(basesChange(["testing"], "add", "release/2026"), ["testing", "release/2026"]);
  assert.deepEqual(basesChange(["testing"], "add", "testing"), ["testing"]);
  for (const never of ["main", "master", "production", "testing-live"]) {
    assert.throws(() => basesChange(["testing"], "add", never), { message: `A run never opens a pull request into ${never}: it is production or a deploy pointer.` });
  }
  for (const bad of ["-x", "a..b", "with space", "ends/"]) assert.throws(() => basesChange([], "add", bad), /is not a branch name git accepts/);
  assert.deepEqual(basesChange(["testing", "develop"], "remove", "testing"), ["develop"]);
  assert.deepEqual(basesChange(["testing"], "remove", "testing"), [], "removing the last one leaves none: no pull requests");
  assert.equal(basesSummary(["testing"]), "into testing");
  assert.equal(basesSummary([]), "off");
});

test("`git bases add` and `remove` save the new list on this computer's runtime; a refused branch saves nothing", async () => {
  let bases = ["testing"];
  const puts: unknown[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      if (request.url === "/api/remote" && request.method === "PUT") {
        const parsed = JSON.parse(body) as { pullRequestBases: string[] };
        puts.push(parsed);
        bases = parsed.pullRequestBases;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ enabled: true, pullRequestBases: bases }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const discovery = { port: (server.address() as AddressInfo).port, token: "t" };
  try {
    assert.equal(await gitBases(discovery, { action: "list" }), "Runs on this computer may open pull requests into: testing.");
    assert.equal(await gitBases(discovery, { action: "add", branch: "develop" }), "Added develop. Runs on this computer may open pull requests into: testing, develop.");
    await assert.rejects(gitBases(discovery, { action: "add", branch: "main" }), /never opens a pull request into main/);
    assert.match(await gitBases(discovery, { action: "remove", branch: "staging" }), /^staging was not allowed\./);
    await gitBases(discovery, { action: "remove", branch: "develop" });
    assert.equal(await gitBases(discovery, { action: "remove", branch: "testing" }), "Removed testing. Runs on this computer open no pull requests. Allow a branch with `ensemble git bases add <branch>`.");
    assert.deepEqual(puts, [{ pullRequestBases: ["testing", "develop"] }, { pullRequestBases: ["testing"] }, { pullRequestBases: [] }]);
  } finally {
    server.close();
  }
});

test("`folders add --repo` shares a git repository; without .git it says so", () => {
  const isRepo = (path: string) => path === "/work/app";
  assert.deepEqual(folderRequest("/work/app", { repo: true }, isRepo), { label: "app", path: "/work/app", kind: "repo", access: "read-write" });
  assert.deepEqual(folderRequest("/work/notes", { label: "Notes", readOnly: true }, isRepo), { label: "Notes", path: "/work/notes", kind: "folder", access: "review" });
  assert.throws(() => folderRequest("/work/notes", { repo: true }, isRepo), /\/work\/notes is not a git repository \(it has no \.git\)/);
  assert.throws(() => folderRequest("/work/app", { repo: true, readOnly: true }, isRepo), /--read-only and --repo do not go together/);
  // The real check: this package's folder has no .git of its own.
  assert.throws(() => folderRequest(fileURLToPath(new URL(".", import.meta.url)), { repo: true }), /is not a git repository/);
  assert.equal(folderLine({ label: "app", path: "/work/app", kind: "repo", access: "read-write" }), "app\t/work/app\tread-write\t(repository)");
  assert.equal(folderLine({ label: "notes", path: "/work/notes", kind: "folder", access: "review" }), "notes\t/work/notes\treview");
});
