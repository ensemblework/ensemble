import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { folderLine, folderRequest } from "./local-commands.js";

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
