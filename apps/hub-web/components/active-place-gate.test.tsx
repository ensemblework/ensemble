import "./ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ActivePlaceGate } from "./active-place-gate.js";
import { PLACE_BLOCKED_EVENT } from "../lib/active-place.js";

(globalThis as { React?: typeof React }).React = React;
Object.defineProperty(globalThis, "CustomEvent", { configurable: true, value: window.CustomEvent });
Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: () => true });
const places = Array.from({ length: 3 }, (_, index) => ({ windowId: `place-${index}`, surface: "hub", label: `Browser ${index + 1} on Linux`, lastSeen: new Date().toISOString() }));

test("a refused fourth tab cannot mount the app, can choose one place, and preserves the app when evicted", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ path: string; json: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    const json = init?.body ? JSON.parse(String(init.body)) : {};
    requests.push({ path, json });
    if (path === "/api/auth/me") return Response.json({ via: "session" });
    if (path === "/api/auth/places/continue") return Response.json({ allowed: true, places: [] });
    return Response.json({ allowed: false, code: "PLACE_LIMIT", places }, { status: 409 });
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<ActivePlaceGate><input aria-label="Workspace draft" defaultValue="Keep my draft" /></ActivePlaceGate>); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.equal(host.querySelector("input"), null);
    assert.match(host.textContent ?? "", /Choose where to continue/);
    assert.equal(host.querySelectorAll("li").length, 3);
    assert.doesNotMatch(host.textContent ?? "", /place-0/);
    await act(async () => { host.querySelector<HTMLButtonElement>("li button")!.click(); });
    assert.equal(requests.find((request) => request.path.endsWith("/continue"))!.json.replace, "place-0");
    const draft = host.querySelector<HTMLInputElement>("input")!;
    assert.equal(draft.value, "Keep my draft");
    await act(async () => { window.dispatchEvent(new window.CustomEvent(PLACE_BLOCKED_EVENT, { detail: { allowed: false, places, code: "PLACE_REPLACED" } })); });
    assert.equal(host.querySelector("input"), draft, "eviction keeps unsaved editor state mounted");
    assert.equal(draft.closest("[inert]") !== null, true);
    assert.match(host.textContent ?? "", /Choose where to continue/);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = originalFetch;
  }
});

test("anonymous public-link visitors enter without an account slot", async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async (input) => {
    paths.push(String(input));
    return Response.json({ error: "Sign in first." }, { status: 401 });
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(<ActivePlaceGate allowAnonymous><p>Public page</p></ActivePlaceGate>);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    assert.match(host.textContent ?? "", /Public page/);
    assert.deepEqual(paths, ["/api/auth/me"]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = originalFetch;
  }
});

test("a heartbeat network failure does not block an admitted window's offline draft", async () => {
  const originalFetch = globalThis.fetch;
  let beats = 0;
  globalThis.fetch = async (input) => {
    if (String(input) === "/api/auth/me") return Response.json({ via: "session" });
    beats += 1;
    if (beats > 1) throw new TypeError("Network disconnected");
    return Response.json({ allowed: true, places: [] });
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(<ActivePlaceGate><input aria-label="Offline draft" defaultValue="Keep editing" /></ActivePlaceGate>);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await act(async () => {
      window.dispatchEvent(new window.Event("pageshow"));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const input = host.querySelector<HTMLInputElement>("input")!;
    assert.equal(input.value, "Keep editing");
    assert.equal(input.closest("[inert]"), null);
    assert.match(host.querySelector('[role="status"]')?.textContent ?? "", /can't reach its server/);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = originalFetch;
  }
});
