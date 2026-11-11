import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { byDay, VersionHistoryDialog, type SavedVersion } from "./version-history.js";

const NOW = new Date("2026-11-11T18:00:00");
const at = (iso: string) => new Date(iso).toISOString();
const versions: SavedVersion[] = [
  { id: "v3", title: "Launch plan", createdAt: at("2026-11-11T17:42:00"), author: "Mira Chen" },
  { id: "v2", title: "Launch notes", createdAt: at("2026-11-11T15:34:00"), author: "Mira Chen" },
  { id: "v1", title: "Launch notes", createdAt: at("2026-11-10T15:54:00"), author: "Ben Ortiz" },
  { id: "v0", title: "Launch notes", createdAt: at("2025-12-30T09:00:00") },
];

test("versions group by the day they were saved", () => {
  assert.deepEqual(byDay(versions, NOW).map((group) => [group.day, group.versions.map((version) => version.id)]), [
    ["Today", ["v3", "v2"]],
    ["Yesterday", ["v1"]],
    ["Tue, 30 Dec, 2025", ["v0"]],
  ]);
});

function Harness({ list, onRestore, onClose }: { list: SavedVersion[]; onRestore: () => void; onClose: () => void }) {
  const [selected, setSelected] = useState<string | null>(list[0]?.id ?? null);
  return <VersionHistoryDialog open onClose={onClose} title="Page" versions={list} selected={selected} onSelect={setSelected} preview={<p>Preview of {selected}</p>} onRestore={onRestore} restoring={false} />;
}

test("arrow keys move through the list, and Restore asks once before it replaces the page", async () => {
  let restored = 0;
  let closed = 0;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const press = (target: Element, key: string) => act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
  const click = (target: Element) => act(async () => { target.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  const button = (name: string) => [...document.body.querySelectorAll("button")].find((node) => node.textContent?.trim() === name);
  try {
    await act(async () => root.render(<Harness list={versions} onRestore={() => restored++} onClose={() => closed++} />));
    const listbox = document.body.querySelector('[role="listbox"][aria-label="Saved versions"]')!;
    assert.ok(listbox);
    const selected = () => document.body.querySelector('[role="option"][aria-selected="true"]')?.getAttribute("data-version-id");
    assert.equal(selected(), "v3");
    assert.equal(document.activeElement?.getAttribute("data-version-id"), "v3", "the chosen version takes focus, so arrows work at once");
    assert.match(document.body.textContent ?? "", /Preview of v3/);
    await press(listbox, "ArrowDown");
    assert.equal(selected(), "v2");
    assert.equal(document.activeElement?.getAttribute("data-version-id"), "v2");
    await press(listbox, "End");
    assert.equal(selected(), "v0");
    await press(listbox, "Home");
    assert.equal(selected(), "v3");
    const groups = [...document.body.querySelectorAll('[role="listbox"] [role="group"]')].map((group) => group.getAttribute("aria-label"));
    assert.equal(groups[0], "Today");

    await click(button("Restore this version")!);
    assert.equal(restored, 0, "the first press only asks");
    const confirm = document.body.querySelector('[role="group"][aria-label="Restore this version?"]')!;
    assert.match(confirm.textContent ?? "", /Replace the page with this version\?/);
    await press(confirm, "Escape");
    assert.equal(closed, 0, "Escape leaves the question, not the dialog");
    assert.equal(document.body.querySelector('[aria-label="Restore this version?"]'), null);
    await click(button("Restore this version")!);
    await click(button("Restore")!);
    assert.equal(restored, 1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("with no versions the list says when they appear", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Harness list={[]} onRestore={() => undefined} onClose={() => undefined} />));
    assert.match(document.body.textContent ?? "", /No earlier versions yet/);
    assert.equal(document.body.querySelector('[role="listbox"]'), null);
    assert.equal([...document.body.querySelectorAll("button")].some((node) => node.textContent === "Restore this version"), false, "nothing to restore, so no Restore");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
