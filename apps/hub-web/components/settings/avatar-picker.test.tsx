/** @jsxRuntime automatic */
/** @jsxImportSource react */
import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AVATAR_CHARACTERS } from "@ensemble/shared-types";
import { AvatarPicker } from "./avatar-picker.js";

(globalThis as { React?: typeof React }).React = React;
Object.defineProperty(globalThis, "self", { configurable: true, value: window });
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); }); }
  assert.ok(check(), document.body.textContent ?? "condition not met");
}
async function mount(profile: { gender: string | null; profession: string }, initial = "vibe.f.2") {
  const writes: Array<{ avatar: string | null }> = [];
  let avatar: string | null = initial, refuse = false;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, "");
    const reply = (data: unknown, status = 200) => Response.json(data, { status });
    if (init?.method === "PATCH" && path === "/api/auth/me") {
      writes.push(JSON.parse(String(init.body)));
      if (refuse) return reply({ error: "Could not save your avatar." }, 500);
      avatar = writes.at(-1)!.avatar;
    }
    if (path === "/api/auth/me") return reply({ user: { id: "u1", email: "mira@fieldnote.example", name: "Mira Chen", avatar, profile } });
    return reply({});
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: 0 } } });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  await act(async () => root.render(<QueryClientProvider client={client}><AvatarPicker /></QueryClientProvider>));
  await waitFor(() => host.querySelectorAll('[aria-labelledby="avatar-character-label"] [role="radio"]').length === 12);
  return { host, writes, fail() { refuse = true; }, allow() { refuse = false; }, async done() { await act(async () => root.unmount()); host.remove(); client.clear(); globalThis.fetch = original; } };
}

for (const profile of [{ gender: "Woman", profession: "Engineer" }, { gender: "Man", profession: "Student" }, { gender: "Non-binary", profession: "Lawyer" }, { gender: null, profession: "Teacher" }]) {
  test(`${profile.profession}/${profile.gender}: the same 12 characters are available, without gender filters`, async () => {
    const h = await mount(profile);
    try {
      assert.deepEqual([...h.host.querySelectorAll('[aria-labelledby="avatar-character-label"] [role="radio"]')].map(node => node.getAttribute("aria-label")), AVATAR_CHARACTERS.map(row => row.label));
      assert.equal(h.host.querySelector('[aria-label="Faces to show"]'), null);
      assert.equal(h.host.querySelector('[aria-labelledby="avatar-character-label"] [aria-checked="true"]')?.getAttribute("aria-label"), "At a desk");
      assert.deepEqual(h.writes, [], "opening Settings does not rewrite a profile");
    } finally { await h.done(); }
  });
}

test("color, scenery and character save together, survive refetch and retain the other choices", async () => {
  const h = await mount({ gender: "Woman", profession: "Engineer" });
  try {
    await act(async () => h.host.querySelector<HTMLButtonElement>('[aria-label="Blue and amber"]')!.click());
    await waitFor(() => h.writes.length === 1 && !h.host.querySelector('[role="status"]'));
    assert.equal(h.writes[0]!.avatar, "dots.2.blue.hills");
    const scenery = h.host.querySelector<HTMLSelectElement>('[aria-label="Avatar scenery"]')!;
    await act(async () => { scenery.value = "grove"; scenery.dispatchEvent(new Event("change", { bubbles: true })); });
    await waitFor(() => h.writes.length === 2 && !h.host.querySelector('[role="status"]'));
    assert.equal(h.writes[1]!.avatar, "dots.2.blue.grove");
    await act(async () => h.host.querySelector<HTMLButtonElement>('[aria-label="Elephant"]')!.click());
    await waitFor(() => h.writes.length === 3 && !h.host.querySelector('[role="status"]'));
    assert.equal(h.writes[2]!.avatar, "dots.9.blue.grove");
    assert.equal(h.host.querySelector('[data-persona-avatar]')?.getAttribute("data-persona-avatar"), "dots.9.blue.grove");
    await act(async () => [...h.host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === "Use initials")!.click());
    await waitFor(() => h.writes.length === 4 && !h.host.querySelector('[role="status"]'));
    assert.equal(h.writes[3]!.avatar, null);
    assert.match(h.host.textContent!, /Your initials/);
  } finally { await h.done(); }
});

test("keyboard selection wraps, and a failed save restores the current avatar", async () => {
  const h = await mount({ gender: null, profession: "Student" }, "dots.12.moss.none");
  try {
    const last = h.host.querySelector<HTMLButtonElement>('[aria-label="Bird"]')!;
    await act(async () => last.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
    await waitFor(() => h.writes.length === 1 && !h.host.querySelector('[role="status"]'));
    assert.equal(h.writes[0]!.avatar, "dots.1.moss.none");
    assert.equal(document.activeElement?.getAttribute("aria-label"), "Pausing");
    h.fail();
    await act(async () => h.host.querySelector<HTMLButtonElement>('[aria-label="Dog"]')!.click());
    await waitFor(() => Boolean(h.host.querySelector('[role="alert"]')));
    assert.match(h.host.querySelector('[role="alert"]')!.textContent!, /Could not save/);
    assert.equal(h.host.querySelector('[aria-labelledby="avatar-character-label"] [aria-checked="true"]')?.getAttribute("aria-label"), "Pausing");
  } finally { await h.done(); }
});
