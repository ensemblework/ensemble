/** @jsxRuntime automatic */
/** @jsxImportSource react */
import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BoardLabelList, BoardLabelRecord } from "@ensemble/shared-types";
import { ToastProvider } from "../toast";
import { addLabels, LabelChips, LabelColors, LabelPicker, labelTone } from "./labels.js";

(globalThis as { React?: typeof React }).React = React;
Object.defineProperty(globalThis, "CustomEvent", { configurable: true, value: window.CustomEvent });

const tick = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function key(input: HTMLInputElement, name: string) {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  });
}

function Harness({ initial, onChange }: { initial: string[]; onChange: (labels: string[]) => void }) {
  const [labels, setLabels] = useState(initial);
  return (
    <LabelPicker
      of={{ task: "t1" }}
      value={labels}
      onChange={(next) => {
        setLabels(next);
        onChange(next);
      }}
    />
  );
}

async function mount(initial: string[]) {
  const board: BoardLabelRecord[] = [
    { id: "l1", name: "Field", color: "green", count: 2 },
    { id: "l2", name: "Launch", color: "purple", count: 1 },
  ];
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, path: `${url.pathname}${url.search}`, body });
    let data: unknown;
    let status = 200;
    if (method === "GET" && url.pathname === "/api/labels") data = { board: { id: "ensemble", title: "Ensemble board" }, labels: board } satisfies BoardLabelList;
    else if (method === "POST" && url.pathname === "/api/labels") {
      const label = { id: `l${board.length + 1}`, name: body.name, color: "orange" as const, count: 0 };
      board.push(label);
      data = { label };
      status = 201;
    } else if (method === "PATCH" && url.pathname.startsWith("/api/labels/")) {
      const label = board.find((row) => row.id === url.pathname.split("/").pop())!;
      Object.assign(label, body);
      data = { label, changed: 1 };
    } else throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  const changes: string[][] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(
    <QueryClientProvider client={client}><ToastProvider><Harness initial={initial} onChange={(next) => changes.push(next)} /></ToastProvider></QueryClientProvider>,
  ));
  await tick();
  return {
    host,
    requests,
    changes,
    trigger: () => host.querySelector<HTMLButtonElement>("button[aria-haspopup='listbox']")!,
    input: () => document.body.querySelector<HTMLInputElement>("input[aria-label='Find or create a label']")!,
    options: () => [...document.body.querySelectorAll<HTMLElement>("[role='option']")],
    option: (text: string) => [...document.body.querySelectorAll<HTMLElement>("[role='option']")].find((node) => node.textContent?.includes(text)),
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
      client.clear();
      globalThis.fetch = realFetch;
    },
  };
}

const background = (node: Element | null | undefined) => (node as HTMLElement | null | undefined)?.style.background ?? "";

test("addLabels trims, splits, de-duplicates and caps", () => {
  assert.deepEqual(addLabels(["Field"], " field, #Launch; Print "), ["Field", "Launch", "Print"]);
  assert.equal(addLabels([], "x".repeat(60))[0]!.length, 40);
  assert.equal(addLabels(Array.from({ length: 20 }, (_, index) => `l${index}`), "one more").length, 20);
  assert.equal(labelTone("Launch"), labelTone("launch"));
});

test("the picker lists the board's labels in their colours and toggles them", async () => {
  const picker = await mount(["Field"]);
  try {
    assert.equal(picker.requests[0]?.path, "/api/labels?task=t1", "the list the task's board has");
    assert.equal(background(picker.trigger().querySelector(".tag")), "var(--tag-green-bg)", "the chip has the board's colour");
    await act(async () => picker.trigger().click());
    assert.equal(document.activeElement === picker.input(), true, "the search field takes focus");
    assert.deepEqual(picker.options().map((node) => node.getAttribute("aria-selected")), ["true", "false"]);
    assert.equal(background(picker.option("Launch")?.querySelector(".tag")), "var(--tag-purple-bg)");
    await act(async () => picker.option("Launch")!.click());
    assert.deepEqual(picker.changes.at(-1), ["Field", "Launch"]);
    assert.equal(picker.option("Launch")?.getAttribute("aria-selected"), "true", "multi-select: the list stays open");
    await type(picker.input(), "fie");
    assert.deepEqual(picker.options().map((node) => node.textContent), ["Field2", "Createfie"], "filtered as you type, with the new name to create last");
    await key(picker.input(), "Enter");
    assert.deepEqual(picker.changes.at(-1), ["Launch"], "Enter toggles the match");
    assert.equal(picker.input().value, "");
    await key(picker.input(), "ArrowDown");
    assert.equal(picker.input().getAttribute("aria-activedescendant"), picker.options()[1]!.id, "arrows move through the list");
  } finally {
    await picker.done();
  }
});

test("Enter on a new name creates it on the board, in a colour of its own", async () => {
  const picker = await mount([]);
  try {
    assert.equal(picker.trigger().textContent, "Empty");
    await act(async () => picker.trigger().click());
    await type(picker.input(), "Print");
    const create = picker.option("Create");
    assert.equal(Boolean(create), true, "offers to create it");
    await key(picker.input(), "Enter");
    await tick();
    const posted = picker.requests.find((request) => request.method === "POST");
    assert.deepEqual(posted?.body, { board: "ensemble", name: "Print" });
    assert.deepEqual(picker.changes.at(-1), ["Print"]);
    assert.equal(background(picker.trigger().querySelector(".tag")), "var(--tag-orange-bg)", "the new label's colour from the server");
    assert.equal(Boolean(picker.option("Print")), true, "now on the board's list");
    await type(picker.input(), "print");
    assert.equal(Boolean(picker.option("Create")), false, "an existing name, whatever its case, is not created again");
  } finally {
    await picker.done();
  }
});

test("a label's ⋯ renames and recolours it for the board", async () => {
  const picker = await mount(["Launch"]);
  try {
    await act(async () => picker.trigger().click());
    const edit = document.body.querySelector<HTMLButtonElement>("button[aria-label='Edit label Launch']")!;
    await act(async () => edit.click());
    const name = document.body.querySelector<HTMLInputElement>("input[aria-label='Label name']")!;
    await type(name, "Go live");
    await key(name, "Enter");
    await tick();
    assert.deepEqual(picker.requests.find((request) => request.method === "PATCH")?.body, { name: "Go live" });
    assert.deepEqual(picker.changes.at(-1), ["Go live"], "the item follows the rename");
    const red = document.body.querySelector<HTMLButtonElement>("button[role='radio'][aria-label='Red']")!;
    await act(async () => red.click());
    await tick();
    assert.deepEqual(picker.requests.filter((request) => request.method === "PATCH").at(-1)?.body, { color: "red" });
    assert.equal(document.body.querySelector("button[role='radio'][aria-label='Red']")?.getAttribute("aria-checked"), "true");
  } finally {
    await picker.done();
  }
});

test("label chips show a few, count the rest, and use the board's colours", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(
    <LabelColors.Provider value={new Map([["a", "red" as const]])}>
      <LabelChips labels={["A", "b", "c", "d", "e"]} />
    </LabelColors.Provider>,
  ));
  try {
    assert.equal(host.querySelectorAll(".tag").length, 3);
    assert.match(host.textContent ?? "", /\+2/);
    assert.equal(host.firstElementChild?.getAttribute("aria-label"), "Labels: A, b, c, d, e");
    assert.equal(background(host.querySelector(".tag")), "var(--tag-red-bg)", "the board's colour, whatever the case");
    assert.equal(background(host.querySelectorAll(".tag")[1]), `var(--tag-${labelTone("b")}-bg)`, "a name the board lacks keeps its own colour");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("opened from a share, the picker only shows the labels and asks the server for nothing", async () => {
  const realFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    throw new Error("No request expected");
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(
    <QueryClientProvider client={client}><ToastProvider><LabelPicker of={null} value={["Draft"]} onChange={() => assert.fail("read-only")} /></ToastProvider></QueryClientProvider>,
  ));
  await tick();
  try {
    assert.equal(host.querySelector(".tag")?.textContent, "Draft");
    assert.equal(Boolean(host.querySelector("button[aria-haspopup='listbox']")), false, "no picker to open");
    assert.deepEqual(requests, []);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
    globalThis.fetch = realFetch;
  }
});
