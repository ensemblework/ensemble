import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { CONNECTOR_CATALOG } from "@ensemble/shared-types";
import { BRAND_INDEX } from "./brand-index.generated.js";
import { BRAND_IMAGES } from "./brand-images.generated.js";
import { BrandLogo, brandKind, initials, loadBrandImages } from "./brand-logo.js";

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

test("connectors show the vendor's own logo with an accessible name", async () => {
  await loadBrandImages();
  for (const [id, name] of [
    ["notion", "Notion"],
    ["microsoft", "Microsoft 365"],
    ["slack", "Slack"],
    ["granola", "Granola"],
    ["aws", "Amazon Web Services"],
  ] as const) {
    const view = await render(<BrandLogo id={id} />);
    try {
      const mark = view.host.querySelector('[role="img"]')!;
      assert.equal(mark.getAttribute("aria-label"), name, id);
      assert.equal(mark.getAttribute("data-brand-kind"), "image", id);
      const image = mark.querySelector("img");
      assert.ok(image?.getAttribute("src")?.startsWith("data:image/"), `${id} draws its logo file`);
      assert.equal(image?.getAttribute("alt"), "");
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

test("every catalog logo key has the vendor's mark, and every mark has an image", () => {
  for (const entry of CONNECTOR_CATALOG) {
    if (entry.logo === "csv") continue;
    assert.equal(brandKind(entry.logo), "image", `${entry.id} uses logo "${entry.logo}"`);
  }
  for (const key of Object.keys(BRAND_INDEX)) assert.ok(BRAND_IMAGES[key], `${key} has an image`);
});

import { modelBrand } from "./provider-logo.js";

test("model ownership wins over the subscription or reseller harness", () => {
  assert.equal(modelBrand("mai-code-1.1-flash", "copilot-cli"), "microsoft");
  assert.equal(modelBrand("claude-sonnet-5-5", "cursor-agent"), "claude");
  assert.equal(modelBrand("gpt-6-luna", "copilot-cli"), "openai");
  assert.equal(modelBrand("default", "codex"), "openai");
  assert.equal(modelBrand("unknown", "unknown"), null);
  assert.equal(modelBrand("gpt-6.1-sol", "ensemble"), "openai", "an included model shows its vendor");
  assert.equal(modelBrand(null, "ensemble"), "ensemble", "the included provider shows Ensemble's mark");
  assert.equal(modelBrand("deepseek-v4-flash", "ensemble"), "deepseek");
  assert.equal(modelBrand("grok-4.7", "ensemble"), "ensemble", "no xAI mark ships, so Grok shows the provider's");
});
