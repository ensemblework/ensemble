import "../ui-test-dom.js";
import React, { act } from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { compareSave, mergeSaveObject, saveObject, type SaveObject } from "@ensemble/shared-types/save-merge";
import { api } from "@/lib/api";
import { answerSaveChoice, listenSaveChoices, pendingSaveChoice } from "@/lib/save-conflict";
import { BoardInsights } from "./insights";
import { INSIGHTS_KEY } from "./insight-data";
import { useLayoutPreference, useTileControls } from "../desk/arrange";
import { layoutKey } from "../desk/layout";
import { ToastProvider } from "../toast";

(globalThis as { React?: typeof React }).React = React;

/** PUT /api/preferences/:key as hub-api answers it: the same merge, the same 409, nothing written on a clash. */
function fakeHub(initial: Record<string, unknown>) {
  const store = new Map(Object.entries(initial));
  const puts: Array<{ key: string; value: unknown; base?: SaveObject; status: number }> = [];
  let held: Array<() => void> | null = null;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://hub.test");
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/shell") return json({ user: { id: "me", name: "Mira" }, space: null, activeTemplateId: null, onboardingTemplateId: null });
    if (url.pathname === "/api/preferences" && method === "GET") {
      return json({ preferences: [...store].map(([key, value]) => ({ id: key, key, value, source: "me", confidence: 1, evidence: [] })) });
    }
    const key = decodeURIComponent(url.pathname.replace("/api/preferences/", ""));
    if (method === "PUT") {
      if (held) await new Promise<void>((resolve) => held!.push(resolve));
      const { _base: base, ...body } = JSON.parse(String(init!.body)) as { value: unknown; _base?: SaveObject };
      const current = { value: store.get(key) ?? null };
      let value = body.value;
      if (base) {
        const result = compareSave(base, current, body);
        if (result.conflicts.length) {
          puts.push({ key, value: body.value, base, status: 409 });
          return json({ error: "This changed in another place. Choose which version to save.", code: "SAVE_CONFLICT", current, patch: result.patch, conflicts: result.conflicts }, 409);
        }
        const patch = result.patch.value;
        value = patch === undefined ? current.value : saveObject(patch) && saveObject(current.value) ? mergeSaveObject(current.value, patch) : patch;
      }
      store.set(key, value);
      puts.push({ key, value, base, status: 200 });
      return json({ preference: { id: key, key, value, source: "me", confidence: 1, evidence: [] } });
    }
    return json({ error: "Not found" }, 404);
  }) as typeof fetch;
  return {
    store, puts, fetch,
    hold() { held = []; },
    release() { const waiting = held ?? []; held = null; waiting.forEach((go) => go()); },
  };
}

/** React Query tells components about new data on a timer. */
const tick = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 1)); });

async function settle() {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
}

async function mount(node: React.ReactNode, hub: ReturnType<typeof fakeHub>) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = hub.fetch;
  let choices = 0;
  const stop = listenSaveChoices(() => { if (pendingSaveChoice()) { choices += 1; answerSaveChoice(null); } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  await act(async () => root.render(<QueryClientProvider client={client}><ToastProvider>{node}</ToastProvider></QueryClientProvider>));
  await settle();
  return {
    host,
    conflicts: () => choices,
    done: async () => { await act(async () => root.unmount()); host.remove(); client.clear(); stop(); globalThis.fetch = realFetch; },
  };
}

const press = async (label: string) => {
  const target = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
  assert.ok(target, `no button "${label}"`);
  assert.equal(target.disabled, false, `"${label}" is disabled`);
  await act(async () => target.click());
  await tick();
};
const selected = () => [...document.querySelectorAll(".insight-selected > div > span")].map((node) => node.textContent);
const overview = (host: HTMLElement) => [...host.querySelectorAll("[data-board-insight]")].map((node) => node.getAttribute("data-board-insight"));

test("swapping board overview tiles moves them at once, saves each move in order and never conflicts with itself", async () => {
  const hub = fakeHub({ [INSIGHTS_KEY]: { v: 1, tiles: ["flow", "done", "agent"], collapsed: false }, "ui.example": { kept: true } });
  const props = { tasks: [], editing: true, onEditingChange: () => {}, who: { me: "me", ownerId: "me" }, onOpen: () => {}, focus: null, onFocus: () => {} };
  const view = await mount(<BoardInsights {...props} />, hub);
  try {
    assert.deepEqual(selected(), ["Delivery flow", "A week of progress", "Agent work"]);
    hub.hold();
    await press("Move Delivery flow right");
    assert.deepEqual(overview(view.host), ["done", "flow", "agent"], "the swap is drawn before the save returns");
    await press("Move Delivery flow right");
    assert.deepEqual(overview(view.host), ["done", "agent", "flow"], "a second move while the first is saving is not dropped");
    hub.release();
    await settle();
    // And straight back: the layout the page first loaded, which used to fail on the Hub.
    await press("Move Delivery flow left");
    await press("Move Delivery flow left");
    await settle();
    assert.deepEqual(overview(view.host), ["flow", "done", "agent"]);
    assert.equal(view.conflicts(), 0);
    assert.deepEqual(hub.puts.map((put) => put.status), [200, 200, 200, 200]);
    assert.deepEqual(hub.puts.map((put) => (put.value as { tiles: string[] }).tiles), [["done", "flow", "agent"], ["done", "agent", "flow"], ["done", "flow", "agent"], ["flow", "done", "agent"]]);
    assert.equal(view.host.querySelector('[role="alert"]'), null);
  } finally { await view.done(); }
  const reload = await mount(<BoardInsights tasks={[]} editing={false} onEditingChange={() => {}} who={{ me: "me", ownerId: "me" }} onOpen={() => {}} focus={null} onFocus={() => {}} />, hub);
  try {
    assert.deepEqual(overview(reload.host), ["flow", "done", "agent"]);
    assert.deepEqual(hub.store.get("ui.example"), { kept: true });
  } finally { await reload.done(); }
});

type Spec = { key: string; title: string; c: number; r: number };
function ResizableDesk({ storageKey, defaults }: { storageKey: string; defaults: Spec[] }) {
  const { layout, save } = useLayoutPreference(storageKey);
  const shown = layout ? layout.tiles.map((tile) => ({ ...defaults.find((spec) => spec.key === tile.key)!, c: tile.c, r: tile.r })) : defaults;
  const tiles = useTileControls({ shown, hidden: layout?.hidden ?? [], save, customized: Boolean(layout), restoreHint: "" });
  return <div className="bento">{shown.map((spec) => <section key={spec.key} data-desk-key={spec.key} data-size={`${spec.c}x${spec.r}`}>{tiles.controls(spec).corner}</section>)}</div>;
}

test("resizing desk tiles twice in a row saves both sizes without a save conflict", async () => {
  const key = layoutKey("default");
  const tiles = [{ key: "deploys", c: 3, r: 3 }, { key: "proposed", c: 4, r: 3 }, { key: "progress", c: 5, r: 3 }];
  const hub = fakeHub({ [key]: { v: 1, tiles, hidden: ["calendar"] } });
  const defaults = tiles.map((tile) => ({ ...tile, title: tile.key }));
  const view = await mount(<ResizableDesk storageKey={key} defaults={defaults} />, hub);
  const grow = async (tile: string, arrow: string) => {
    const corner = view.host.querySelector<HTMLElement>(`[data-desk-key="${tile}"] .tresize`);
    assert.ok(corner);
    await act(async () => { corner.dispatchEvent(new KeyboardEvent("keydown", { key: arrow, bubbles: true })); });
    await tick();
  };
  const sizes = () => [...view.host.querySelectorAll("[data-desk-key]")].map((node) => `${node.getAttribute("data-desk-key")}:${node.getAttribute("data-size")}`);
  try {
    hub.hold();
    await grow("deploys", "ArrowRight");
    await grow("deploys", "ArrowRight");
    await grow("progress", "ArrowDown");
    assert.deepEqual(sizes(), ["deploys:5x3", "proposed:4x3", "progress:5x4"]);
    hub.release();
    await settle();
    await grow("deploys", "ArrowLeft");
    await settle();
    assert.equal(view.conflicts(), 0);
    assert.deepEqual(hub.puts.map((put) => put.status), [200, 200, 200, 200]);
    assert.deepEqual(hub.store.get(key), { v: 1, tiles: [{ key: "deploys", c: 4, r: 3 }, { key: "proposed", c: 4, r: 3 }, { key: "progress", c: 5, r: 4 }], hidden: ["calendar"] });
    assert.deepEqual(sizes(), ["deploys:4x3", "proposed:4x3", "progress:5x4"]);
  } finally { await view.done(); }
});

test("a list read that started before a save cannot make the next save conflict", async () => {
  const key = "desk.layout.stale-read";
  const hub = fakeHub({ [key]: { v: 1, tiles: [{ key: "a", c: 3, r: 3 }], hidden: [] } });
  const realFetch = globalThis.fetch;
  let releaseRead: () => void = () => {};
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const answer = await hub.fetch(input, init);
    if (String(input).endsWith("/api/preferences") && (init?.method ?? "GET") === "GET" && hub.puts.length) await new Promise<void>((resolve) => { releaseRead = resolve; });
    return answer;
  }) as typeof fetch;
  let choices = 0;
  const stop = listenSaveChoices(() => { if (pendingSaveChoice()) { choices += 1; answerSaveChoice(null); } });
  try {
    await api.preferences();
    await api.putPreference(key, { v: 1, tiles: [{ key: "a", c: 4, r: 3 }], hidden: [] });
    const read = api.preferences();
    await api.putPreference(key, { v: 1, tiles: [{ key: "a", c: 5, r: 3 }], hidden: [] });
    releaseRead();
    await read;
    await api.putPreference(key, { v: 1, tiles: [{ key: "a", c: 6, r: 3 }], hidden: [] });
    assert.equal(choices, 0);
    assert.deepEqual(hub.puts.map((put) => put.status), [200, 200, 200]);
    assert.deepEqual(hub.puts[2]!.base, { value: { v: 1, tiles: [{ key: "a", c: 5, r: 3 }], hidden: [] } });
  } finally { stop(); globalThis.fetch = realFetch; }
});
