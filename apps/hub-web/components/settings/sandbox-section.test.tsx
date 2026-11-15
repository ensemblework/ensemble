import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Settings } from "@ensemble/shared-types";
import { SandboxSection } from "./sections.js";

// sections.tsx and ui.tsx are compiled with the classic JSX runtime under tsx, so they need React in scope here.
(globalThis as { React?: typeof React }).React = React;

async function mount(settings: Settings, patches: Array<Record<string, unknown>> = []) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<SandboxSection settings={settings} patch={(value) => void patches.push(value)} />));
  return {
    host,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test("Sandbox by default is a Beta setting, off for settings that never chose it, with what that means in its ⓘ", async () => {
  const patches: Array<Record<string, unknown>> = [];
  const view = await mount(Settings.parse({}), patches);
  try {
    const row = view.host.querySelector<HTMLElement>('div[data-setting-label="Sandbox by default"]');
    assert.ok(row, "the row keeps its label, so Settings search still jumps to it");
    assert.equal(row.querySelector(".tag")?.textContent, "Beta");
    const toggle = row.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Sandbox by default"]')!;
    assert.equal(toggle.getAttribute("aria-checked"), "false");

    await act(async () => row.querySelector<HTMLButtonElement>('button[aria-label="More information"]')!.click());
    assert.match(document.body.querySelector('[role="tooltip"]')?.textContent ?? "", /being rebuilt and may stop some agents from running/);

    // Turning the beta on saves it, and it shows as on.
    await act(async () => toggle.click());
    assert.deepEqual(patches, [{ orchestration: { defaultExecution: "sandbox" } }]);
  } finally {
    await view.done();
  }
  const on = await mount(Settings.parse({ orchestration: { defaultExecution: "sandbox" } }));
  try {
    assert.equal(on.host.querySelector('[role="switch"][aria-label="Sandbox by default"]')?.getAttribute("aria-checked"), "true");
  } finally {
    await on.done();
  }
});
