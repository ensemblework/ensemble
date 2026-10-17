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
    assert.deepEqual(radios(view.host), ["Automatic", "Low", "Medium", "High", "Extra high", "Max"], "Copilot's own list: no Minimal, and Max is there");
    assert.doesNotMatch(view.host.textContent ?? "", /Levels from/);
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
  assert.deepEqual(radios(stale.host), ["Automatic (Medium)", "Low", "Medium", "High", "Extra high", "Max"]);
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
    assert.match(trigger.textContent ?? "", /gemini-3\.5-flash-lite.*Thinking: Minimal–High/);
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

const INCLUDED_IDS = ["gpt-6-luna", "deepseek-v4-flash", "gpt-6.1-sol", "grok-4.7"];

test("included models show their names with versions, vendor logos and relative cost, and search reads both name and id", async () => {
  const picked: string[] = [];
  const view = await render(
    <ModelPicker
      label="Low model model"
      value="gpt-6-luna"
      provider="ensemble"
      providerLabel="Included with Ensemble"
      models={INCLUDED_IDS}
      cheapest="gpt-6-luna"
      hasKey
      onPick={(model) => picked.push(model)}
    />,
  );
  try {
    const trigger = view.host.querySelector('[data-picker="model"]')!;
    assert.match(trigger.textContent ?? "", /^GPT-6 Luna \(2026-09-22\)Thinking: Low–High/);
    assert.equal(trigger.querySelector('[data-provider-logo="openai"]') !== null, true);
    await click(trigger);
    const panel = document.querySelector("[data-model-picker]")!;
    const options = [...panel.querySelectorAll('[role="option"]')];
    const names = () => [...panel.querySelectorAll('[role="option"]')].map((node) => node.querySelector("span.min-w-0")?.textContent);
    assert.deepEqual(names(), ["GPT-6 Luna (2026-09-22)", "DeepSeek V4 Flash", "GPT-6.1 Sol (2026-09-29)", "Grok 4.7"]);
    assert.doesNotMatch(panel.textContent ?? "", /gpt-6-luna|cheapest/, "no raw ids and no cheapest badge");
    assert.deepEqual(options.map((node) => node.querySelector("[data-cost]")?.textContent), ["1×", "2×", "20×", "20×"]);
    assert.match(options[3]!.querySelector("[data-cost]")!.getAttribute("title")!, /about 20× the credits of GPT-6 Luna/);
    assert.deepEqual(
      options.map((node) => node.querySelector("[data-provider-logo]")?.getAttribute("data-provider-logo")),
      ["openai", "deepseek", "openai", "ensemble"],
      "the vendor's mark where there is one, Ensemble's otherwise",
    );
    assert.doesNotMatch(options[1]!.textContent ?? "", /Low|High/, "DeepSeek has no thinking levels");
    assert.match(options[3]!.textContent ?? "", /Low–High/);
    const search = panel.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    const type = async (text: string) =>
      act(async () => {
        setter.call(search, text);
        search.dispatchEvent(new Event("input", { bubbles: true }));
      });
    await type("luna");
    assert.deepEqual(names(), ["GPT-6 Luna (2026-09-22)"], "by name, and no typed-name row");
    await type("gpt-6.1");
    assert.deepEqual(names(), ["GPT-6.1 Sol (2026-09-29)"], "by id");
    await type("claude-opus-5-5");
    assert.equal(panel.querySelectorAll('[role="option"]').length, 0, "an included tier cannot take a typed name");
    await type("grok");
    await act(async () => void search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    assert.deepEqual(picked, ["grok-4.7"]);
  } finally {
    await view.done();
  }
});

test("included models offer Auto with the model's default and Low, Medium and High where the model takes them", async () => {
  const luna = await render(<ThinkingPicker label="Low model thinking" provider="ensemble" providerLabel="Included with Ensemble" model="gpt-6-luna" value="default" onChange={() => undefined} />);
  assert.deepEqual(radios(luna.host), ["Auto (Medium)", "Low", "Medium", "High"]);
  await luna.done();
  const grok = await render(<ThinkingPicker label="High model thinking" provider="ensemble" providerLabel="Included with Ensemble" model="grok-4.7" value="xhigh" onChange={() => undefined} />);
  assert.deepEqual(radios(grok.host), ["Auto (High)", "Low", "Medium", "High"]);
  assert.match(grok.host.textContent ?? "", /Grok 4\.7 does not take “Extra high”/);
  await grok.done();
  const deepseek = await render(<ThinkingPicker label="Low model thinking" provider="ensemble" providerLabel="Included with Ensemble" model="deepseek-v4-flash" value="default" onChange={() => undefined} />);
  assert.deepEqual(radios(deepseek.host), ["Auto"], "DeepSeek decides for itself: Auto only");
  assert.equal(deepseek.host.querySelector('[role="radio"][aria-checked="true"]')?.textContent, "Auto");
  await deepseek.done();
  const stale = await render(<ThinkingPicker label="Low model thinking" provider="ensemble" providerLabel="Included with Ensemble" model="deepseek-v4-flash" value="high" onChange={() => undefined} />);
  assert.deepEqual(radios(stale.host), ["Auto"]);
  assert.match(stale.host.textContent ?? "", /DeepSeek V4 Flash decides how much to think, so “High” is not sent/);
  await stale.done();
  assert.equal(effortFor("ensemble", "deepseek-v4-flash", null, "high"), "default", "switching a tier to DeepSeek resets thinking to Auto");
  assert.equal(effortFor("ensemble", "gpt-6-luna", null, "xhigh"), "default");
  assert.equal(effortFor("ensemble", "grok-4.7", null, "high"), "high");
});
