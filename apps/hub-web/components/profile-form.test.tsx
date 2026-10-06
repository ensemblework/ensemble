import "./ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ProfileForm } from "./profile-form.js";

(globalThis as { React?: typeof React }).React = React;
Object.defineProperty(globalThis, "self", { configurable: true, value: window });

function typeInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  assert.ok(setter);
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function choose(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set;
  assert.ok(setter);
  setter.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

test("profile form submits required name and optional about-you fields", async () => {
  const submissions: unknown[] = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(
      <ProfileForm
        initial={{ name: "Mira Chen", profile: { gender: null, profession: null, organization: null, heardFrom: null } }}
        submitLabel="Continue"
        onSubmit={(profile) => submissions.push(profile)}
      />,
    ));
    assert.match(host.textContent ?? "", /Gender \(optional\)/);
    const inputs = host.querySelectorAll<HTMLInputElement>("input");
    const [name, profession, organization, heardFrom] = inputs;
    assert.ok(name);
    assert.ok(profession);
    assert.ok(organization);
    assert.ok(heardFrom);
    const select = host.querySelector<HTMLSelectElement>("select")!;
    await act(async () => {
      choose(select, "self");
    });
    const self = host.querySelector<HTMLInputElement>('input[aria-label="Self-described gender"]')!;
    await act(async () => {
      typeInput(name, "  Mira Chen  ");
      typeInput(self, "Agender");
      typeInput(profession, "Software engineer");
      typeInput(organization, "Fieldnote");
      typeInput(heardFrom, "Mira Chen at Fieldnote");
    });
    await act(async () => {
      host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    assert.deepEqual(submissions, [{
      name: "Mira Chen",
      gender: "Agender",
      profession: "Software engineer",
      organization: "Fieldnote",
      heardFrom: "Mira Chen at Fieldnote",
    }]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
