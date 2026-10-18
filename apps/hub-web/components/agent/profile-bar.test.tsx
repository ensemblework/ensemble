import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { RunProfile } from "@ensemble/shared-types";
import { ProfileBar } from "./assign-dialog.js";

(globalThis as { React?: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One key as a browser types it: it replaces whatever is selected. */
function press(input: HTMLInputElement, key: string) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, input.value.slice(0, start) + key + input.value.slice(end));
  input.setSelectionRange(start + 1, start + 1);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const careful = RunProfile.parse({ id: "careful", name: "Careful" });
const away = RunProfile.parse({ id: "away", name: "Away", mode: "unattended" });

function render(onSave: (value: { id?: string; name: string }) => void, onDefault: (id: string) => void = () => {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <ProfileBar profiles={[careful, away]} saved={[careful, away]} activeId="careful" defaultId="careful" modified={false} onPick={() => {}} onSave={onSave} onRemove={() => {}} onDefault={onDefault} busy={false} />,
    ),
  );
  return { host, root };
}

test("a new profile name keeps every letter typed, not only the last one", async () => {
  const saved: Array<{ id?: string; name: string }> = [];
  const { host, root } = render((value) => saved.push(value));
  const add = [...host.querySelectorAll("button")].find((button) => button.textContent === "Save as profile")!;
  await act(async () => {
    add.click();
    await wait(40);
  });
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Profile name"]')!;
  for (const key of "XYZ team") {
    await act(async () => {
      press(input, key);
      await wait(40);
    });
  }
  assert.equal(input.value, "XYZ team");
  await act(async () => input.form!.requestSubmit());
  assert.deepEqual(saved, [{ id: undefined, name: "XYZ team" }]);
  act(() => root.unmount());
  host.remove();
});

test("renaming selects the old name once, then typing replaces it and continues", async () => {
  const saved: Array<{ id?: string; name: string }> = [];
  const { host, root } = render((value) => saved.push(value));
  await act(async () => {
    host.querySelector<HTMLButtonElement>('button[aria-label="Rename profile"]')!.click();
    await wait(40);
  });
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Profile name"]')!;
  assert.equal(input.selectionStart, 0);
  assert.equal(input.selectionEnd, "Careful".length);
  for (const key of "Gentle") {
    await act(async () => {
      press(input, key);
      await wait(40);
    });
  }
  assert.equal(input.value, "Gentle");
  act(() => root.unmount());
  host.remove();
});

test("every saved profile has a star; the default's is pressed and another's makes it the default", () => {
  const picked: string[] = [];
  const { host, root } = render(() => {}, (id) => picked.push(id));
  const stars = [...host.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")];
  assert.deepEqual(stars.map((star) => star.getAttribute("aria-pressed")), ["true", "false"]);
  assert.equal(stars[0]!.disabled, true);
  act(() => stars[1]!.click());
  assert.deepEqual(picked, ["away"]);
  act(() => root.unmount());
  host.remove();
});
