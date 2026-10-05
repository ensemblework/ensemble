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

test("a new page focuses the title and selects Untitled", async () => {
  const mounted = await render(<PageTitleField value="Untitled" autoFocus onSave={() => undefined} />);
  try {
    const input = document.querySelector("[aria-label='Page title']");
    assert.ok(input instanceof HTMLTextAreaElement);
    assert.equal(document.activeElement, input);
    assert.equal(input.selectionStart, 0);
    assert.equal(input.selectionEnd, "Untitled".length);
  } finally {
    await act(async () => {
      mounted.root.unmount();
    });
    mounted.host.remove();
  }
});
