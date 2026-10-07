import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { CONNECTOR_CATALOG } from "@ensemble/shared-types";
import { BrandLogo, brandKind, initials } from "./brand-logo.js";

async function render(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return {
    host,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test("simple-icons brands render their real mark with an accessible name", async () => {
  const view = await render(<BrandLogo id="notion" />);
  try {
    const mark = view.host.querySelector('[role="img"]');
    assert.ok(mark);
    assert.equal(mark.getAttribute("aria-label"), "Notion");
    assert.equal(mark.getAttribute("data-brand-kind"), "icon");
    assert.ok(mark.querySelector("svg path")?.getAttribute("d"));
  } finally {
    await view.done();
  }
});

test("brands removed from simple-icons get a plain monogram, never a drawn imitation", async () => {
  for (const [id, text, name] of [
    ["microsoft", "M", "Microsoft 365"],
    ["slack", "S", "Slack"],
    ["aws", "AWS", "Amazon Web Services"],
    ["azure", "Az", "Microsoft Azure"],
  ] as const) {
    const view = await render(<BrandLogo id={id} />);
    try {
      const mark = view.host.querySelector('[role="img"]')!;
      assert.equal(mark.getAttribute("data-brand-kind"), "monogram", id);
      assert.equal(mark.textContent, text, id);
      assert.equal(mark.getAttribute("aria-label"), name, id);
      assert.equal(mark.querySelector("svg"), null, `${id} must not draw a logo`);
    } finally {
      await view.done();
    }
  }
});

test("unknown keys fall back to initials from the name, and decorative marks are hidden", async () => {
  const view = await render(
    <>
      <BrandLogo id="fieldnote-internal" name="Fieldnote Tools" />
      <BrandLogo id="linear" decorative />
      <BrandLogo id="csv" />
    </>,
  );
  try {
    const [fallback, decorative, file] = Array.from(view.host.children) as HTMLElement[];
    assert.equal(fallback!.getAttribute("data-brand-kind"), "fallback");
    assert.equal(fallback!.textContent, "FT");
    assert.equal(fallback!.getAttribute("aria-label"), "Fieldnote Tools");
    assert.equal(decorative!.getAttribute("aria-hidden"), "true");
    assert.equal(decorative!.getAttribute("role"), null);
    assert.equal(file!.getAttribute("data-brand-kind"), "generic");
  } finally {
    await view.done();
  }
  assert.equal(initials("monday.com"), "MC");
  assert.equal(initials("365"), "3");
});

test("every catalog logo key has a mark (icon, monogram or generic)", () => {
  for (const entry of CONNECTOR_CATALOG) {
    assert.notEqual(brandKind(entry.logo), "fallback", `${entry.id} uses logo "${entry.logo}"`);
  }
});
