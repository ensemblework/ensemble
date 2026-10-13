import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { ModelPicker, ThinkingPicker, effortFor } from "./model-picker.js";

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

const click = (node: Element) => act(async () => void node.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const radios = (host: Element) => [...host.querySelectorAll('[role="radio"]')].map((node) => node.textContent);

test("thinking offers exactly the levels the model takes, and the choice is the value saved", async () => {
  let saved = "";
  function Harness() {
    const [value, setValue] = useState("default");
    return (
      <ThinkingPicker
        label="Max model thinking"
        provider="copilot"
        providerLabel="GitHub Copilot"
        model="claude-opus-5.5"
        meta={{ efforts: ["low", "medium", "high", "xhigh", "max"] }}
        value={value}
        onChange={(next) => {
          saved = next;
          setValue(next);
        }}
      />
    );
  }
  const view = await render(<Harness />);
  try {
    assert.deepEqual(radios(view.host), ["Model default", "Low", "Medium", "High", "Extra high", "Max"], "Copilot's own list: no Minimal, and Max is there");
    assert.match(view.host.textContent ?? "", /Levels from GitHub Copilot's own model list/);
    await click([...view.host.querySelectorAll('[role="radio"]')].find((node) => node.textContent === "Max")!);
    assert.equal(saved, "max");
    assert.equal(view.host.querySelector('[aria-checked="true"]')?.textContent, "Max");
  } finally {
    await view.done();
  }
});

test("a model without a thinking setting says so; a saved level it does not take is flagged", async () => {
  const none = await render(<ThinkingPicker label="Low model thinking" provider="mistral" providerLabel="Mistral" model="mistral-large-latest" value="default" onChange={() => undefined} />);
  assert.match(none.host.textContent ?? "", /mistral-large-latest has no thinking setting/);
  await none.done();
  const stale = await render(<ThinkingPicker label="Low model thinking" provider="anthropic" providerLabel="Claude" model="claude-opus-5-5" value="minimal" onChange={() => undefined} />);
  assert.deepEqual(radios(stale.host), ["Default · Medium", "Low", "Medium", "High", "Extra high", "Max"]);
  assert.match(stale.host.textContent ?? "", /does not take “Minimal”, so calls on this tier are refused/);
  await stale.done();
  assert.equal(effortFor("anthropic", "claude-opus-5-5", null, "minimal"), "default", "switching to a model that lacks the level resets it");
  assert.equal(effortFor("google", "gemini-3.5-flash-lite", null, "minimal"), "minimal");
});

test("the model picker searches the provider's list, picks with the keyboard, and takes a typed name", async () => {
  const picked: string[] = [];
  const view = await render(
    <ModelPicker
      label="Low model model"
      value="gemini-3.5-flash-lite"
      provider="google"
      providerLabel="Gemini"
      models={["gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro"]}
      cheapest="gemini-3.5-flash-lite"
      hasKey
      onPick={(model) => picked.push(model)}
    />,
  );
  try {
    const trigger = view.host.querySelector('[data-picker="model"]')!;
    assert.match(trigger.textContent ?? "", /gemini-3\.5-flash-lite.*thinks Minimal–High/);
    await click(trigger);
    const panel = document.querySelector("[data-model-picker]")!;
    const options = [...panel.querySelectorAll('[role="option"]')].map((node) => node.textContent ?? "");
    assert.match(options[0]!, /gemini-3\.5-flash-lite.*cheapest/, "cheapest first");
    assert.match(options.find((text) => text.includes("3.1-pro"))!, /Low–High/, "each model shows its own levels");
    const search = panel.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(search, "pro");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    assert.equal(panel.querySelectorAll('[role="option"]').length, 2, "the match, and the typed name");
    await act(async () => void search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    assert.deepEqual(picked, ["gemini-3.1-pro"]);
    await click(trigger);
    const again = document.querySelector("[data-model-picker]")!;
    const box = again.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!;
    await act(async () => {
      setter.call(box, "gemini-4-preview");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click([...again.querySelectorAll('[role="option"]')].find((node) => /Use/.test(node.textContent ?? ""))!);
    assert.deepEqual(picked, ["gemini-3.1-pro", "gemini-4-preview"]);
  } finally {
    await view.done();
  }
});
