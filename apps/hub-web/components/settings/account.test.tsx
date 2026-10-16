import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AccountSection } from "./account.js";
import { hasUnsaved } from "./unsaved.js";

(globalThis as { React?: typeof React }).React = React;
Object.defineProperty(globalThis, "self", { configurable: true, value: window });

const PROFILE = { gender: null, profession: null, organization: null, heardFrom: null };

function typeInput(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
}

async function mount(initialPassword = true) {
  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  let name = "Mira Chen";
  const realFetch = globalThis.fetch;
  let hasPassword = initialPassword;
  const me = () => ({ user: { id: "u1", email: "mira@fieldnote.example", name, emailVerified: true, hasPassword, profile: PROFILE }, via: "session", spaceId: "u1" });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, "");
    const method = init?.method ?? "GET";
    const reply = (data: unknown) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
    if (method !== "GET") {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      writes.push({ method, path, body });
      if (path === "/api/auth/profile") {
        name = (body as { name: string }).name;
        return reply({ user: me().user, profile: PROFILE });
      }
      if (path === "/api/auth/me" && (body as { password?: string }).password) hasPassword = true;
      return reply({ user: me().user });
    }
    if (path === "/api/auth/me") return reply(me());
    if (path === "/api/shell") return reply({ templateName: "Default", devTools: false });
    if (path === "/api/auth/identities") return reply({ identities: [], providers: [] });
    return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: 0 } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<QueryClientProvider client={client}><AccountSection /></QueryClientProvider>));
  await settle();
  return {
    host,
    writes,
    field: (label: string) => document.querySelector<HTMLInputElement>(`#${CSS.escape(Array.from(document.querySelectorAll("label")).find((node) => node.textContent === label)!.htmlFor)}`)!,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
      client.clear();
      globalThis.fetch = realFetch;
    },
  };
}

const CSS = { escape: (value: string) => value.replace(/([^a-zA-Z0-9_-])/g, "\\$1") };

test("changing the password needs it typed twice, shows the rule first, and a double click sends it once", async () => {
  const view = await mount();
  try {
    await act(async () => Array.from(view.host.querySelectorAll("button")).find(button => button.textContent === "Change password")!.click());
    const form = document.querySelector<HTMLFormElement>("[data-password-form]")!;
    assert.match(form.textContent ?? "", /At least 8 characters/);
    assert.ok(form.querySelector('button[aria-label="Show new password"]'), "each field can be shown");
    const submit = () => act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await act(async () => {
      typeInput(view.field("Current password"), "test-password-only-123");
      typeInput(view.field("New password"), "a-new-password-1");
      typeInput(view.field("Confirm new password"), "a-new-password-2");
    });
    assert.equal(hasUnsaved(), true, "a typed password counts as unsaved");
    await submit();
    assert.match(form.querySelector('[role="alert"]')?.textContent ?? "", /don't match/);
    assert.equal(view.field("Confirm new password").getAttribute("aria-invalid"), "true");
    assert.equal(view.writes.length, 0);

    await act(async () => {
      typeInput(view.field("New password"), "        ");
      typeInput(view.field("Confirm new password"), "        ");
    });
    await submit();
    assert.match(form.querySelector('[role="alert"]')?.textContent ?? "", /only spaces/);
    assert.equal(view.writes.length, 0);

    await act(async () => {
      typeInput(view.field("New password"), "a-new-password-1");
      typeInput(view.field("Confirm new password"), "a-new-password-1");
    });
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle();
    assert.deepEqual(view.writes.map((row) => `${row.method} ${row.path}`), ["PATCH /api/auth/me"]);
    assert.deepEqual(view.writes[0]!.body, { password: "a-new-password-1", current: "test-password-only-123" });
    assert.equal(document.querySelector("[data-password-form]"), null, "successful save closes the dialog");
    assert.equal(hasUnsaved(), false);
  } finally {
    await view.done();
  }
});

test("Save profile waits for a change, marks it unsaved, and a double click saves once", async () => {
  const view = await mount();
  try {
    const form = view.host.querySelector<HTMLFormElement>("[data-profile-form]")!;
    const save = Array.from(form.querySelectorAll("button")).find((button) => /Save profile/.test(button.textContent ?? ""))!;
    assert.equal(save.disabled, true, "nothing to save yet");
    const name = form.querySelector<HTMLInputElement>('input[autocomplete="name"]')!;
    await act(async () => typeInput(name, "Mira Chen-Okafor"));
    assert.equal(save.disabled, false);
    assert.equal(hasUnsaved(), true);
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle();
    assert.deepEqual(view.writes.map((row) => `${row.method} ${row.path}`), ["PUT /api/auth/profile"]);
    assert.equal(save.disabled, true, "saved, so nothing is left to save");
    assert.equal(hasUnsaved(), false);
  } finally {
    await view.done();
  }
});

test("a social-only account adds its first password in a dialog and then requires current password", async () => {
  const view = await mount(false);
  try {
    await act(async () => Array.from(view.host.querySelectorAll("button")).find(button => button.textContent === "Add a password")!.click());
    assert.equal(Array.from(document.querySelectorAll("label")).some(label => label.textContent === "Current password"), false);
    await act(async () => { typeInput(view.field("New password"), "a-new-password-1"); typeInput(view.field("Confirm new password"), "a-new-password-1"); });
    await act(async () => document.querySelector<HTMLFormElement>("[data-password-form]")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle();
    assert.deepEqual(view.writes[0]!.body, { password: "a-new-password-1" });
    await act(async () => Array.from(view.host.querySelectorAll("button")).find(button => button.textContent === "Change password")!.click());
    assert.ok(view.field("Current password"));
    assert.equal(document.querySelectorAll('[data-password-form] input[type="password"]').length, 3);
  } finally { await view.done(); }
});
