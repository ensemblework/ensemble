import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import { assignBlocker } from "./assign-dialog.js";

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
  needsTrust: false,
  mode: "ask" as const,
  unattendedNoSandbox: false,
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
  assert.match(assignBlocker({ ...here, needsTrust: true, mode: "review" })!.text, /Review only needs a folder you trust/);
  assert.equal(assignBlocker({ ...here, unattendedNoSandbox: true })!.field, "mode");
});
