import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { DeskAddForm } from "./add-form";
import type { DeskField } from "./form-check";

(globalThis as { React?: typeof React }).React = React;

const CLASS: DeskField[] = [
  { key: "title", label: "Class" },
  { key: "start", label: "Start", placeholder: "09:00" },
  { key: "end", label: "End", placeholder: "10:15" },
];

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function Harness({ onSubmit }: { onSubmit: (values: Record<string, string>) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>+ Add class</button>
      {open ? <DeskAddForm kind="slot" title="Add class" fields={CLASS} onSubmit={async (values) => { await onSubmit(values); setOpen(false); }} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

async function mount(onSubmit: (values: Record<string, string>) => Promise<void>) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<Harness onSubmit={onSubmit} />));
  const opener = host.querySelector("button")!;
  opener.focus();
  await act(async () => opener.click());
  const field = (name: string) => host.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  const submit = async () => act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await Promise.resolve(); });
  return { host, opener, field, submit, done: async () => { await act(async () => root.unmount()); host.remove(); } };
}

test("the add form takes focus, checks times inline, keeps input, and Esc gives focus back", async () => {
  const sent: Array<Record<string, string>> = [];
  const view = await mount(async (values) => { sent.push(values); });
  try {
    assert.equal(document.activeElement, view.field("title"), "focus moves into the form");
    assert.equal(view.host.querySelector("form")!.getAttribute("role"), "dialog");
    await type(view.field("title"), "Maths");
    await type(view.field("start"), "11:00");
    await type(view.field("end"), "10:00");
    await view.submit();
    assert.equal(sent.length, 0);
    assert.equal(view.field("end").getAttribute("aria-invalid"), "true");
    assert.match(view.host.textContent ?? "", /End has to be after Start/);
    assert.equal(document.activeElement, view.field("end"));
    assert.equal(view.field("title").value, "Maths", "what was typed stays");
    await type(view.field("start"), "25:99");
    await view.submit();
    assert.equal(view.field("start").getAttribute("aria-invalid"), "true");
    assert.match(view.host.textContent ?? "", /Use a time like 09:00/);
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await Promise.resolve(); });
    assert.equal(view.host.querySelector("form"), null);
    assert.equal(document.activeElement, view.opener, "focus returns to + Add class");
  } finally { await view.done(); }
});

test("a double Save sends one entry, and a failed save stays open with its message", async () => {
  let calls = 0;
  let release!: () => void;
  let fail = true;
  const view = await mount(() => {
    calls++;
    if (fail) return Promise.reject(new Error("The class has to end after it starts."));
    return new Promise<void>((resolve) => { release = resolve; });
  });
  try {
    await type(view.field("title"), "Maths");
    await type(view.field("start"), "9:00");
    await type(view.field("end"), "10:00");
    await view.submit();
    assert.equal(calls, 1);
    assert.match(view.host.querySelector('[role="alert"]')?.textContent ?? "", /end after it starts/);
    assert.equal(view.field("title").value, "Maths");
    fail = false;
    await view.submit();
    await view.submit();
    assert.equal(calls, 2, "the second click while saving is ignored");
    assert.equal(view.host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, true);
    await act(async () => { release(); await Promise.resolve(); });
    assert.equal(view.host.querySelector("form"), null);
  } finally { await view.done(); }
});
