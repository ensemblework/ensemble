import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AVATARS_PER_GROUP } from "@ensemble/shared-types";
import { AvatarPicker } from "./avatar-picker.js";

(globalThis as { React?: typeof React }).React = React;
Object.defineProperty(globalThis, "self", { configurable: true, value: window });

async function settle() {
  for (let i = 0; i < 6; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
}

test("the picker offers ten faces a group and five backgrounds; a background is saved with the face", async () => {
  const writes: Array<{ avatar: string | null }> = [];
  let avatar: string | null = "vibe.f.2";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, "");
    const reply = (data: unknown) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
    if (init?.method === "PATCH" && path === "/api/auth/me") {
      const body = JSON.parse(String(init.body)) as { avatar: string | null };
      writes.push(body);
      avatar = body.avatar;
    }
    if (path === "/api/auth/me") return reply({ user: { id: "u1", email: "mira@fieldnote.example", name: "Mira Chen", avatar, profile: { gender: "Woman", profession: null } } });
    if (path === "/api/spaces") return reply({ account: { role: "vibe" }, spaces: [] });
    return reply({});
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: 0 } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><AvatarPicker /></QueryClientProvider>));
    await settle();
    const backgrounds = host.querySelector('[role="radiogroup"][aria-label="Avatar background"]')!;
    const swatches = [...backgrounds.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    assert.deepEqual(swatches.map((swatch) => swatch.getAttribute("aria-label")), ["Blue", "Green", "Peach", "Rose", "Slate"]);
    assert.equal(backgrounds.querySelector('[aria-checked="true"]')?.getAttribute("aria-label"), "Rose", "a Maker avatar without a background shows the Maker colour");
    const groups = [...host.querySelectorAll('[role="radiogroup"][aria-label^="Maker avatars"]')];
    assert.equal(groups.length, 3);
    for (const group of groups) assert.equal(group.querySelectorAll('[role="radio"]').length, AVATARS_PER_GROUP);
    assert.equal(AVATARS_PER_GROUP, 10);

    await act(async () => swatches.find((swatch) => swatch.getAttribute("aria-label") === "Green")!.click());
    await settle();
    assert.deepEqual(writes.at(-1), { avatar: "vibe.f.2.mint" }, "the face stays, the background is added");
    assert.equal(host.querySelector('[aria-label="Maker avatars, Women"] [aria-checked="true"]')?.getAttribute("aria-label"), "Maker avatar 2", "the same face stays picked");

    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Maker avatar 7"]')!.click());
    await settle();
    assert.deepEqual(writes.at(-1), { avatar: "vibe.f.7.mint" }, "a new face keeps the picked background");

    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Avatar background"] [role="radio"]')].find((swatch) => swatch.getAttribute("aria-label") === "Rose")!.click());
    await settle();
    assert.deepEqual(writes.at(-1), { avatar: "vibe.f.7" }, "the profession's own colour is written without a background");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
    globalThis.fetch = realFetch;
  }
});
