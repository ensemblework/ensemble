import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PageTitleField } from "./title-field.js";

async function render(node: React.ReactNode): Promise<{ root: Root; host: HTMLDivElement }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
  });
  return { root, host };
}

test("a new page focuses an empty title with Untitled as its placeholder, so typing replaces it", async () => {
  const saves: string[] = [];
  const mounted = await render(<PageTitleField value="Untitled" autoFocus onSave={(value) => saves.push(value)} />);
  try {
    const input = document.querySelector("[aria-label='Page title']");
    assert.ok(input instanceof HTMLTextAreaElement);
    assert.equal(document.activeElement, input);
    assert.equal(input.value, "");
    assert.equal(input.placeholder, "Untitled");
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => { setter.call(input, "Plan"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => input.blur());
    assert.deepEqual(saves, ["Plan"]);
  } finally {
    await act(async () => {
      mounted.root.unmount();
    });
    mounted.host.remove();
  }
});

test("leaving a new page's title empty keeps it untitled without an error or a save", async () => {
  const saves: string[] = [];
  const mounted = await render(<PageTitleField value="Untitled" onSave={(value) => saves.push(value)} />);
  try {
    const input = mounted.host.querySelector("textarea")!;
    input.focus();
    await act(async () => input.blur());
    assert.equal(input.value, "");
    assert.deepEqual(saves, []);
    assert.equal(mounted.host.querySelector('[role="status"]'), null);
  } finally {
    await act(async () => mounted.root.unmount());
    mounted.host.remove();
  }
});

test("blank titles visibly restore the persisted title without saving an empty name", async () => {
  const saves: string[] = [];
  const mounted = await render(<PageTitleField value="Research notes" onSave={(value) => saves.push(value)} />);
  try {
    const input = mounted.host.querySelector("textarea")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    input.focus();
    await act(async () => { setter.call(input, "   "); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => input.blur());
    assert.equal(input.value, "Research notes");
    assert.deepEqual(saves, []);
    assert.match(mounted.host.querySelector('[role="status"]')?.textContent ?? "", /title is required.*restored/);
    assert.ok(document.getElementById(input.getAttribute("aria-describedby")!));
  } finally {
    await act(async () => mounted.root.unmount());
    mounted.host.remove();
  }
});
