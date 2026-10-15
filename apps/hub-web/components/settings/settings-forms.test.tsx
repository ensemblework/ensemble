import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { Settings } from "@ensemble/shared-types";
import { APPEARANCE_KEY, DEFAULT_APPEARANCE } from "@/lib/prefs";
import { ToastProvider } from "../toast.js";
import { Segmented } from "../ui.js";
import { AppearanceSection } from "./appearance.js";
import { NumberField } from "./number-field.js";
import { IdentitySection, QuickCaptureSection, RemindersSection } from "./sections.js";
import { SettingsTabs } from "./settings-tabs.js";
import type { SettingsTab } from "./url-state.js";

(globalThis as { React?: typeof React }).React = React;
Object.defineProperty(globalThis, "self", { configurable: true, value: window });
// Appearance changes announce themselves with a CustomEvent on window; it has to be the DOM's own.
Object.defineProperty(globalThis, "CustomEvent", { configurable: true, writable: true, value: window.CustomEvent });
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: (media: string) => ({ matches: false, media, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }),
});

function typeInput(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function choose(select: HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

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

test("a number setting shows its range, and a value outside it stays with an error instead of snapping back", async () => {
  const saved: number[] = [];
  const view = await render(<NumberField label="Undo depth" value={5} min={3} max={20} unit="actions" onChange={(value) => saved.push(value)} />);
  try {
    const input = view.host.querySelector<HTMLInputElement>('input[aria-label="Undo depth"]')!;
    assert.match(view.host.textContent ?? "", /3–20/);
    await act(async () => typeInput(input, "25"));
    assert.equal(input.value, "25");
    assert.equal(input.getAttribute("aria-invalid"), "true");
    assert.match(view.host.querySelector('[role="alert"]')?.textContent ?? "", /from 3 to 20/);
    assert.deepEqual(saved, []);
    await act(async () => typeInput(input, "2.5"));
    assert.match(view.host.querySelector('[role="alert"]')?.textContent ?? "", /whole number/);
    await act(async () => typeInput(input, "12"));
    assert.deepEqual(saved, [12]);
    assert.equal(view.host.querySelector('[role="alert"]'), null);
    assert.equal(input.hasAttribute("aria-invalid"), false);
  } finally {
    await view.done();
  }
});

test("the email is saved only when it is an address, and the time zone is picked from the IANA list", async () => {
  const patches: Array<Record<string, unknown>> = [];
  function Harness() {
    const [settings, setSettings] = useState(() => Settings.parse({ email: "mira@fieldnote.example", timezone: "Mars/Olympus_1" }));
    return (
      <IdentitySection
        settings={settings}
        patch={(value) => {
          patches.push(value);
          setSettings((current) => ({ ...current, ...value }) as typeof current);
        }}
      />
    );
  }
  const view = await render(<Harness />);
  try {
    const email = view.host.querySelector<HTMLInputElement>("#settings-email")!;
    await act(async () => typeInput(email, "mira@"));
    assert.equal(patches.length, 0);
    await act(async () => {
      email.focus();
      email.blur();
    });
    assert.equal(email.getAttribute("aria-invalid"), "true");
    assert.match(view.host.querySelector("#settings-email-error")?.textContent ?? "", /name@example.com/);
    await act(async () => typeInput(email, "mira@fieldnote.example "));
    assert.deepEqual(patches, [{ email: "mira@fieldnote.example" }]);
    assert.equal(view.host.querySelector("#settings-email-error"), null);

    const zone = view.host.querySelector<HTMLSelectElement>("#settings-timezone")!;
    assert.equal(zone.value, "Mars/Olympus_1");
    assert.match(zone.options[0]!.textContent ?? "", /not a time zone/);
    assert.match(view.host.querySelector("#settings-timezone-error")?.textContent ?? "", /Pick your time zone/);
    assert.ok(Array.from(zone.options).some((option) => option.value === "Europe/London"));
    await act(async () => choose(zone, "Europe/London"));
    assert.deepEqual(patches.at(-1), { timezone: "Europe/London" });
    assert.equal(view.host.querySelector("#settings-timezone-error"), null);
    assert.ok(!Array.from(zone.options).some((option) => /not a time zone/.test(option.textContent ?? "")));
  } finally {
    await view.done();
  }
});

test("desktop reminders only turn on when the browser allows notifications, and say how to allow them", async () => {
  const original = (globalThis as { Notification?: unknown }).Notification;
  const shown: string[] = [];
  let permission: NotificationPermission = "denied";
  let answer: NotificationPermission = "denied";
  class FakeNotification {
    static get permission() {
      return permission;
    }
    static async requestPermission() {
      permission = answer;
      return answer;
    }
    constructor(title: string) {
      shown.push(title);
    }
  }
  (globalThis as { Notification?: unknown }).Notification = FakeNotification;
  try {
    const patches: Array<Record<string, unknown>> = [];
    const blocked = await render(<RemindersSection settings={Settings.parse({ desktopReminders: true })} patch={(value) => patches.push(value)} />);
    try {
      const toggle = blocked.host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Desktop reminders"]')!;
      assert.equal(toggle.getAttribute("aria-checked"), "false", "on for the account, but this browser blocks it");
      assert.match(blocked.host.textContent ?? "", /blocking notifications/);
      assert.match(blocked.host.textContent ?? "", /Notifications to Allow/);
      assert.match(blocked.host.querySelector('[role="alert"]')?.textContent ?? "", /can't show them/);
      assert.equal(toggle.disabled, true);
      const off = Array.from(blocked.host.querySelectorAll("button")).find((button) => button.textContent === "Switch them off")!;
      await act(async () => off.click());
      assert.equal(JSON.stringify(patches), JSON.stringify([{ desktopReminders: false }]));
      patches.length = 0;
    } finally {
      await blocked.done();
    }

    permission = "default";
    answer = "denied";
    const asking = await render(<RemindersSection settings={Settings.parse({ desktopReminders: false })} patch={(value) => patches.push(value)} />);
    try {
      const toggle = asking.host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Desktop reminders"]')!;
      await act(async () => toggle.click());
      assert.equal(patches.length, 0, "refused in the browser, so the setting stays off");
      assert.match(asking.host.textContent ?? "", /blocking notifications/);
    } finally {
      await asking.done();
    }

    permission = "default";
    answer = "granted";
    const allowed = await render(<RemindersSection settings={Settings.parse({ desktopReminders: false })} patch={(value) => patches.push(value)} />);
    try {
      const toggle = allowed.host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Desktop reminders"]')!;
      await act(async () => toggle.click());
      assert.deepEqual(patches, [{ desktopReminders: true }]);
      assert.deepEqual(shown, ["Ensemble"], "a test notification shows it works");
    } finally {
      await allowed.done();
    }
  } finally {
    (globalThis as { Notification?: unknown }).Notification = original;
  }
});

test("Quick capture talks to people, not about repository files", async () => {
  const view = await render(<QuickCaptureSection />);
  try {
    assert.doesNotMatch(view.host.textContent ?? "", /docs\/|\.md\b/);
  } finally {
    await view.done();
  }
});

test("segmented choices are one tab stop and arrow keys move the choice", async () => {
  function Harness() {
    const [value, setValue] = useState<"left" | "right">("left");
    return <Segmented label="Pages panel position" value={value} onChange={setValue} options={[{ id: "left", label: "Left" }, { id: "right", label: "Right" }]} />;
  }
  const view = await render(<Harness />);
  try {
    const radios = () => Array.from(view.host.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    assert.deepEqual(radios().map((radio) => radio.tabIndex), [0, -1]);
    radios()[0]!.focus();
    await act(async () => radios()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    assert.deepEqual(radios().map((radio) => radio.getAttribute("aria-checked")), ["false", "true"]);
    assert.equal(document.activeElement, radios()[1]);
    await act(async () => radios()[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    assert.equal(radios()[0]!.getAttribute("aria-checked"), "true", "wraps around");
  } finally {
    await view.done();
  }
});

test("the app font list is a radio group with the saved font checked, and Reset appearance can be undone", async () => {
  window.localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ ...DEFAULT_APPEARANCE, font: "georgia", textScale: 120 }));
  const patches: Array<{ appearance?: { font?: string; textScale?: number } }> = [];
  const view = await render(
    <ToastProvider>
      <AppearanceSection patch={(value) => patches.push(value as (typeof patches)[number])} />
    </ToastProvider>,
  );
  try {
    const group = view.host.querySelector<HTMLElement>('[role="radiogroup"][aria-labelledby="app-font-label"]')!;
    assert.ok(group);
    const fonts = () => Array.from(group.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    const checked = () => fonts().find((radio) => radio.getAttribute("aria-checked") === "true");
    assert.match(checked()?.textContent ?? "", /^Georgia/);
    assert.equal(checked()!.tabIndex, 0);
    await act(async () => checked()!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    assert.equal(patches.at(-1)?.appearance?.font, "mono");
    assert.match(checked()?.textContent ?? "", /^Monospace/);

    const reset = Array.from(view.host.querySelectorAll("button")).find((button) => /Reset appearance/.test(button.textContent ?? ""))!;
    await act(async () => reset.click());
    assert.equal(patches.at(-1)?.appearance?.font, DEFAULT_APPEARANCE.font);
    assert.match(document.body.textContent ?? "", /Appearance reset/);
    const undo = Array.from(document.body.querySelectorAll("button")).find((button) => button.textContent === "Undo")!;
    await act(async () => undo.click());
    assert.equal(patches.at(-1)?.appearance?.font, "mono");
    assert.equal(patches.at(-1)?.appearance?.textScale, 120);
  } finally {
    await view.done();
    window.localStorage.removeItem(APPEARANCE_KEY);
  }
});

test("on a narrow screen the open settings tab is scrolled into the tab row", async () => {
  const rect = Element.prototype.getBoundingClientRect;
  const widths = { scroll: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth"), client: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth") };
  const scrolled = new WeakMap<Element, number>();
  const left = Object.getOwnPropertyDescriptor(Element.prototype, "scrollLeft");
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get() { return this.getAttribute("role") === "tablist" ? 900 : 0; } });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get() { return this.getAttribute("role") === "tablist" ? 375 : 0; } });
  Object.defineProperty(Element.prototype, "scrollLeft", { configurable: true, get() { return scrolled.get(this) ?? 0; }, set(value: number) { scrolled.set(this, value); } });
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const box = (x: number, width: number) => ({ left: x, right: x + width, top: 0, bottom: 30, width, height: 30, x, y: 0, toJSON() {} }) as DOMRect;
    if (this.getAttribute("role") === "tablist") return box(0, 375);
    if (this.id === "settings-tab-data") return box(820, 60);
    return box(0, 60);
  };
  try {
    const view = await render(<SettingsTabs value={"data" as SettingsTab} onChange={() => undefined} />);
    try {
      const list = view.host.querySelector('[role="tablist"]')!;
      assert.equal(list.scrollLeft, 820 + 60 - 375 + 12);
    } finally {
      await view.done();
    }
  } finally {
    Element.prototype.getBoundingClientRect = rect;
    if (widths.scroll) Object.defineProperty(HTMLElement.prototype, "scrollWidth", widths.scroll);
    if (widths.client) Object.defineProperty(HTMLElement.prototype, "clientWidth", widths.client);
    if (left) Object.defineProperty(Element.prototype, "scrollLeft", left);
  }
});
