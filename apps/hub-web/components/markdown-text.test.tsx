import "./ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MarkdownText } from "./markdown-text.js";

async function render(text: string): Promise<{ root: Root; host: HTMLDivElement }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<MarkdownText text={text} />);
  });
  return { root, host };
}

async function unmount(mounted: { root: Root; host: HTMLDivElement }) {
  await act(async () => mounted.root.unmount());
  mounted.host.remove();
}

test("saved stop notes render as italics, and snake_case stays literal", async () => {
  const saved = await render("The model paused.\n\n_Stopped before finishing._");
  const em = saved.host.querySelector("em");
  assert.equal(em?.textContent, "Stopped before finishing.");
  assert.equal(saved.host.textContent?.includes("_Stopped"), false);
  await unmount(saved);

  const stars = await render("*Stopped before finishing.*");
  assert.equal(stars.host.querySelector("em")?.textContent, "Stopped before finishing.");
  await unmount(stars);

  const code = await render("Call `hub_create_tasks` then hub_create_project.");
  assert.equal(code.host.querySelector("code")?.textContent, "hub_create_tasks");
  assert.equal(code.host.querySelector("em"), null);
  assert.match(code.host.textContent ?? "", /hub_create_project/);
  await unmount(code);

  const math = await render("2 * 3 = 6 and **bold** stays bold.");
  assert.equal(math.host.querySelector("em"), null);
  assert.equal(math.host.querySelector("strong")?.textContent, "bold");
  assert.match(math.host.textContent ?? "", /2 \* 3 = 6/);
  await unmount(math);
});

test("cut-off notices and the apply prompt have no stray markdown markers", async () => {
  for (const text of [
    "Stopped before finishing.",
    "The reply was cut off before the model finished.",
    "The reply hit the length limit.",
    "Nothing has changed yet — press Apply.",
  ]) {
    const mounted = await render(text);
    assert.equal(mounted.host.textContent?.includes(text.replace(/[.*]/g, "")), true);
    assert.equal(mounted.host.textContent?.includes("*"), false);
    assert.equal(mounted.host.textContent?.includes("_"), false);
    await unmount(mounted);
  }
});
