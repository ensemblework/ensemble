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

(globalThis as { React?: typeof React }).React = React;
// jsdom has no CSS.escape; the tile keys here are plain words.
(globalThis as { CSS?: { escape: (value: string) => string } }).CSS ??= { escape: (value) => value.replace(/["\\]/g, "\\$&") };

// Assertions here compare strings, numbers and booleans only: a failing assert on a React-rendered
// element formats its whole fiber tree into the message, which can take gigabytes.

const MAX_CALLS = 30;

/** PUT /api/preferences/:key as hub-api answers it: the same merge, the same 409, nothing written on a clash. */
function fakeHub(initial: Record<string, unknown>) {
  const store = new Map(Object.entries(initial));
  const puts: Array<{ value: unknown; base?: SaveObject; status: number }> = [];
  let calls = 0;
  let held: Array<() => void> | null = null;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetch: typeof globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    // A save that retries by itself would show up here, not as a test that never ends.
    if (++calls > MAX_CALLS) return json({ error: "Too many requests in one test." }, 500);
    const url = new URL(String(input), "http://hub.test");
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/shell") return json({ user: { id: "me", name: "Mira" }, space: null, activeTemplateId: null, onboardingTemplateId: null });
    if (url.pathname === "/api/preferences" && method === "GET") {
      return json({ preferences: [...store].map(([key, value]) => ({ id: key, key, value, source: "me", confidence: 1, evidence: [] })) });
    }
    if (method !== "PUT" || !url.pathname.startsWith("/api/preferences/")) return json({ error: "Not found" }, 404);
    if (held) await new Promise<void>((resolve) => held!.push(resolve));
    const key = decodeURIComponent(url.pathname.replace("/api/preferences/", ""));
    const { _base: base, ...body } = JSON.parse(String(init!.body)) as { value: unknown; _base?: SaveObject };
    const current = { value: store.get(key) ?? null };
    let value = body.value;
    if (base) {
      const result = compareSave(base, current, body);
      if (result.conflicts.length) {
        puts.push({ value: body.value, base, status: 409 });
        return json({ error: "This changed in another place.", code: "SAVE_CONFLICT", current, patch: result.patch, conflicts: result.conflicts }, 409);
      }
      const patch = result.patch.value;
      value = patch === undefined ? current.value : saveObject(patch) && saveObject(current.value) ? mergeSaveObject(current.value, patch) : patch;
    }
    store.set(key, value);
    puts.push({ value, base, status: 200 });
    return json({ preference: { id: key, key, value, source: "me", confidence: 1, evidence: [] } });
  };
  const release = () => { const waiting = held ?? []; held = null; waiting.forEach((go) => go()); };
  return { store, puts, fetch, calls: () => calls, hold() { held = []; }, release };
}

/** React Query tells components about new data on a timer. */
const wait = (ms = 5) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

/** Mounts with the fake Hub. A save conflict is answered "decide later" and counted, never left waiting. */
async function mount(node: React.ReactNode, hub: ReturnType<typeof fakeHub>) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = hub.fetch;
  let conflicts = 0;
  const stop = listenSaveChoices(() => { if (pendingSaveChoice()) { conflicts += 1; answerSaveChoice(null); } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  await act(async () => root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>));
  await wait(20);
  return {
    host,
    conflicts: () => conflicts,
    done: async () => { hub.release(); await act(async () => root.unmount()); host.remove(); client.clear(); stop(); globalThis.fetch = realFetch; },
  };
}

async function press(label: string) {
  const target = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
  assert.equal(Boolean(target), true, `no button "${label}"`);
  assert.equal(target!.disabled, false, `"${label}" is disabled`);
  await act(async () => target!.click());
  await wait(1);
}
const overview = (host: HTMLElement) => [...host.querySelectorAll("[data-board-insight]")].map((node) => node.getAttribute("data-board-insight")).join(",");
const sentTiles = (hub: ReturnType<typeof fakeHub>) => hub.puts.map((put) => `${put.status}:${(put.value as { tiles: string[] }).tiles.join(",")}`);

test("swapping board overview tiles moves them at once, saves each move in order and never conflicts with itself", async () => {
  const hub = fakeHub({ [INSIGHTS_KEY]: { v: 1, tiles: ["flow", "done", "agent"], collapsed: false }, "ui.example": { kept: true } });
  const props = { tasks: [], onEditingChange: () => {}, who: { me: "me", ownerId: "me" }, onOpen: () => {}, focus: null, onFocus: () => {} };
  const view = await mount(<BoardInsights {...props} editing />, hub);
  try {
    assert.equal(overview(view.host), "flow,done,agent");
    hub.hold();
    await press("Move Delivery flow right");
    assert.equal(overview(view.host), "done,flow,agent", "the swap is drawn before the save returns");
    await press("Move Delivery flow right");
    assert.equal(overview(view.host), "done,agent,flow", "a second move while the first is saving is not dropped");
    hub.release();
    await wait(20);
    // Straight back to the layout the page loaded with: this save used to fail on the Hub.
    await press("Move Delivery flow left");
    await press("Move Delivery flow left");
    await wait(20);
    assert.equal(overview(view.host), "flow,done,agent");
    assert.equal(view.conflicts(), 0);
    assert.deepEqual(sentTiles(hub), ["200:done,flow,agent", "200:done,agent,flow", "200:done,flow,agent", "200:flow,done,agent"]);
    assert.equal(Boolean(view.host.querySelector('[role="alert"]')), false);
  } finally { await view.done(); }
  const reload = await mount(<BoardInsights {...props} editing={false} />, hub);
  try {
    assert.equal(overview(reload.host), "flow,done,agent");
    assert.deepEqual(hub.store.get("ui.example"), { kept: true });
    assert.ok(hub.calls() < MAX_CALLS);
  } finally { await reload.done(); }
});

type Spec = { key: string; title: string; c: number; r: number };
function ResizableDesk({ storageKey, defaults }: { storageKey: string; defaults: Spec[] }) {
  const { layout, save } = useLayoutPreference(storageKey);
  const shown = layout ? layout.tiles.map((tile) => ({ ...defaults.find((spec) => spec.key === tile.key)!, c: tile.c, r: tile.r })) : defaults;
  const tiles = useTileControls({ shown, hidden: layout?.hidden ?? [], save, customized: Boolean(layout), restoreHint: "" });
  return <div className="bento">{shown.map((spec) => <section key={spec.key} data-desk-key={spec.key} data-size={`${spec.c}x${spec.r}`}>{tiles.controls(spec).options}{tiles.controls(spec).corner}</section>)}</div>;
}

test("resizing desk tiles twice in a row saves both sizes without a save conflict", async () => {
  const key = layoutKey("default");
  const start = [{ key: "deploys", c: 3, r: 3 }, { key: "proposed", c: 4, r: 3 }, { key: "progress", c: 5, r: 3 }];
  const hub = fakeHub({ [key]: { v: 1, tiles: start, hidden: ["calendar"] } });
  const view = await mount(<ResizableDesk storageKey={key} defaults={start.map((tile) => ({ ...tile, title: tile.key }))} />, hub);
  const resize = async (tile: string, arrow: string) => {
    const corner = view.host.querySelector<HTMLElement>(`[data-desk-key="${tile}"] .tresize`);
    assert.equal(Boolean(corner), true, `no resize corner on ${tile}`);
    await act(async () => { corner!.dispatchEvent(new KeyboardEvent("keydown", { key: arrow, bubbles: true })); });
    await wait(1);
  };
  const sizes = () => [...view.host.querySelectorAll("[data-desk-key]")].map((node) => `${node.getAttribute("data-desk-key")}:${node.getAttribute("data-size")}`).join(" ");
  try {
    hub.hold();
    await resize("deploys", "ArrowRight");
    await resize("deploys", "ArrowRight");
    await resize("progress", "ArrowDown");
    assert.equal(sizes(), "deploys:5x3 proposed:4x3 progress:5x4");
    hub.release();
    await wait(20);
    await resize("deploys", "ArrowLeft");
    await wait(20);
    assert.equal(view.conflicts(), 0);
    assert.deepEqual(hub.puts.map((put) => put.status), [200, 200, 200, 200]);
    assert.deepEqual(hub.store.get(key), { v: 1, tiles: [{ key: "deploys", c: 4, r: 3 }, { key: "proposed", c: 4, r: 3 }, { key: "progress", c: 5, r: 4 }], hidden: ["calendar"] });
    assert.equal(sizes(), "deploys:4x3 proposed:4x3 progress:5x4");
  } finally { await view.done(); }
});

test("a list read that started before a save cannot make the next save conflict", async () => {
  const key = "desk.layout.stale-read";
  const layout = (c: number) => ({ v: 1, tiles: [{ key: "a", c, r: 3 }], hidden: [] });
  const hub = fakeHub({ [key]: layout(3) });
  const realFetch = globalThis.fetch;
  let releaseRead = () => {};
  const readHeld = new Promise<void>((resolve) => { releaseRead = resolve; });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const answer = await hub.fetch(input, init);
    // The second list read answers with the layout as it was when it started, after the next save.
    if (String(input).endsWith("/api/preferences") && hub.puts.length === 1) await readHeld;
    return answer;
  }) as typeof fetch;
  let conflicts = 0;
  const stop = listenSaveChoices(() => { if (pendingSaveChoice()) { conflicts += 1; answerSaveChoice(null); } });
  try {
    await api.preferences();
    await api.putPreference(key, layout(4));
    const read = api.preferences();
    await api.putPreference(key, layout(5));
    releaseRead();
    await read;
    await api.putPreference(key, layout(6));
    assert.equal(conflicts, 0);
    assert.deepEqual(hub.puts.map((put) => put.status), [200, 200, 200]);
    assert.deepEqual(hub.puts[2]!.base, { value: layout(5) });
  } finally { releaseRead(); stop(); globalThis.fetch = realFetch; }
});

test("the tile menu edits width and height within the tile's limits and removes the tile", async () => {
  const key = layoutKey("branch");
  const start = [{ key: "deploys", c: 3, r: 3 }, { key: "progress", c: 4, r: 3 }];
  const hub = fakeHub({ [key]: { v: 1, tiles: start, hidden: [] } });
  const view = await mount(<ResizableDesk storageKey={key} defaults={start.map((tile) => ({ ...tile, title: tile.key }))} />, hub);
  const sizes = () => [...view.host.querySelectorAll("[data-desk-key]")].map((node) => `${node.getAttribute("data-desk-key")}:${node.getAttribute("data-size")}`).join(" ");
  try {
    await press("Options for deploys");
    assert.equal(document.querySelector<HTMLButtonElement>('[aria-label="Narrower: deploys"]')?.disabled, true, "3 columns is the narrowest");
    await press("Wider: deploys");
    await press("Taller: deploys");
    await wait(20);
    assert.equal(sizes(), "deploys:4x4 progress:4x3");
    const remove = [...document.querySelectorAll("button")].find((node) => node.textContent?.trim() === "Remove tile");
    assert.equal(Boolean(remove), true);
    await act(async () => remove!.click());
    await wait(20);
    assert.equal(sizes(), "progress:4x3");
    assert.equal(view.conflicts(), 0);
    assert.deepEqual(hub.store.get(key), { v: 1, tiles: [{ key: "progress", c: 4, r: 3 }], hidden: ["deploys"] });
  } finally { await view.done(); }
});
