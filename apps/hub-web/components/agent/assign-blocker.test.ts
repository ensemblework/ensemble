import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import { assignBlocker, earlierRunLabel } from "./assign-dialog.js";

const base = {
  taskId: "task-1",
  kind: "code" as const,
  serverRunner: false,
  device: { name: "Studio Mac", folders: 0 },
  devices: 1,
  place: "fresh" as const,
  continueFrom: "",
  folder: "",
  folderCheck: null,
  folderLabel: "",
  branchMode: "as-is" as const,
  branch: "",
  mode: "ask" as const,
};

test("a code task for a paired computer can go with no repository: it gets an empty folder there", () => {
  assert.equal(assignBlocker(base), null);
  assert.equal(assignBlocker({ ...base, kind: "research" }), null);
});

test("every other stop says what is missing and which field to fix", () => {
  assert.deepEqual(assignBlocker({ ...base, taskId: "" }), { text: "Choose a task first.", field: "task" });
  assert.match(assignBlocker({ ...base, device: null, devices: 0 })!.text, /Pair one in Settings → Devices/);
  assert.equal(assignBlocker({ ...base, device: null, devices: 2 })!.field, "run-on");
  assert.match(assignBlocker({ ...base, place: "folder" })!.text, /Studio Mac has not shared a folder yet/);
  assert.match(assignBlocker({ ...base, place: "folder", device: { name: "Studio Mac", folders: 2 } })!.text, /Choose a folder Studio Mac has shared/);
  const here = { ...base, serverRunner: true, device: null };
  assert.equal(assignBlocker({ ...here, place: "folder", folder: "/work/app" })!.text, "Checking the folder…");
  assert.equal(assignBlocker({ ...here, place: "folder", folder: "/", folderCheck: { ok: false, text: "System folders are refused." } })!.text, "System folders are refused.");
  assert.equal(assignBlocker({ ...here, place: "folder", folder: "/work/app", folderCheck: { ok: true, text: "Git repository" } }), null);
  assert.equal(assignBlocker({ ...here, place: "continue" })!.field, "place");
  assert.equal(assignBlocker({ ...here, branchMode: "new" })!.text, "Name the new branch.");
});

test("no mode waits for a trusted folder or a sandbox; a coding agent needs one of the person's computers", () => {
  const here = { ...base, serverRunner: true, device: null, place: "folder" as const, folder: "/work/app", folderCheck: { ok: true, text: "Git repository" } };
  for (const mode of ["ask", "review", "unattended"] as const) assert.equal(assignBlocker({ ...here, mode }), null, mode);
  assert.match(assignBlocker({ ...base, device: null, devices: 0, engine: "claude-code" })!.text, /Claude Code runs on one of your computers with your own sign-in/);
  assert.equal(assignBlocker({ ...base, device: null, devices: 2, engine: "copilot-cli" })!.field, "run-on");
  assert.equal(assignBlocker({ ...here, engine: "claude-code", local: true }), null, "the desktop app runs it on its own computer");
  assert.equal(assignBlocker({ ...base, kind: "research", device: null, devices: 0 }), null, "Ensemble's agent researches and writes on the server");
});

test("the Continue list names the task (marking this one), how its run ended or that the new run waits, and where", () => {
  const row = { jobId: "j1", taskId: "task-1", title: "Use real connector logos", status: "interrupted", folder: "live-test", branch: "live-test/connector-logos", createdAt: "" };
  assert.equal(earlierRunLabel(row, "task-1"), "Use real connector logos (this task) · interrupted · live-test/connector-logos · live-test");
  assert.equal(earlierRunLabel({ ...row, status: "running", branch: "", folder: "" }, "task-2"), "Use real connector logos · not finished yet, waits for it");
  assert.equal(earlierRunLabel({ ...row, status: "succeeded", folder: "/home/me/ensemble-workspace/runs/abc" }, "task-2"), "Use real connector logos · done · live-test/connector-logos · abc");
});
