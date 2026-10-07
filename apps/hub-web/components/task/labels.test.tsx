import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { addLabels, LabelChips, LabelEditor, labelTone } from "./labels.js";

(globalThis as { React?: typeof React }).React = React;

function Harness({ initial, onChange }: { initial: string[]; onChange: (labels: string[]) => void }) {
  const [labels, setLabels] = useState(initial);
  return (
    <LabelEditor
      labels={labels}
      onChange={(next) => {
        setLabels(next);
        onChange(next);
      }}
    />
  );
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function key(input: HTMLInputElement, name: string) {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  });
}

test("addLabels trims, splits, de-duplicates and caps", () => {
  assert.deepEqual(addLabels(["Field"], " field, #Launch; Print "), ["Field", "Launch", "Print"]);
  assert.equal(addLabels([], "x".repeat(60))[0]!.length, 40);
  assert.equal(addLabels(Array.from({ length: 20 }, (_, index) => `l${index}`), "one more").length, 20);
  assert.equal(labelTone("Launch"), labelTone("launch"));
});

test("label editor adds with Enter or comma and removes with the button or Backspace", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const changes: string[][] = [];
  await act(async () => root.render(<Harness initial={["Field"]} onChange={(next) => changes.push(next)} />));
  try {
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Add a label"]')!;
    assert.ok(input);
    await type(input, "Launch");
    await key(input, "Enter");
    assert.deepEqual(changes.at(-1), ["Field", "Launch"]);
    await type(input, "Print,");
    assert.deepEqual(changes.at(-1), ["Field", "Launch", "Print"]);
    assert.equal(input.value, "");
    const remove = host.querySelector<HTMLButtonElement>('button[aria-label="Remove label Launch"]')!;
    await act(async () => remove.click());
    assert.deepEqual(changes.at(-1), ["Field", "Print"]);
    await key(input, "Backspace");
    assert.deepEqual(changes.at(-1), ["Field"]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("label chips show a few and count the rest", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<LabelChips labels={["a", "b", "c", "d", "e"]} />));
  try {
    assert.equal(host.querySelectorAll(".tag").length, 3);
    assert.match(host.textContent ?? "", /\+2/);
    assert.equal(host.firstElementChild?.getAttribute("aria-label"), "Labels: a, b, c, d, e");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
