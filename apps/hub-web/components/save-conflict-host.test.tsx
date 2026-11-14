import "./ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { SaveConflictHost } from "./save-conflict-host.js";
import { api } from "../lib/api.js";
import { answerSaveChoice } from "../lib/save-conflict.js";

(globalThis as { React?: typeof React }).React = React;
Object.defineProperty(globalThis, "CustomEvent", { configurable: true, value: window.CustomEvent });

test("conflict dialog shows both values and retries the chosen version against the returned baseline", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  const current = { quietHours: { from: "07:30", until: "09:00" } };
  globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 1) return Response.json({
      error: "Choose a version.", code: "SAVE_CONFLICT", current,
      patch: { quietHours: { from: "08:45", until: "09:30" } },
      conflicts: [{ path: ["quietHours", "from"], saved: "07:30", yours: "08:45" }],
    }, { status: 409 });
    return Response.json({ settings: { quietHours: { from: "07:30", until: "09:30" } } });
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let saving: ReturnType<typeof api.saveSettings> | undefined;
  try {
    await act(async () => { root.render(<SaveConflictHost />); });
    await act(async () => {
      saving = api.saveSettings({ quietHours: { from: "08:45", until: "09:30" } }, { quietHours: { from: "09:00", until: "09:00" } });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    const dialog = document.querySelector('[role="dialog"]')!;
    assert.match(dialog.textContent ?? "", /07:30/);
    assert.match(dialog.textContent ?? "", /08:45/);
    await act(async () => {
      const button = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent === "Keep saved version")!;
      button.click();
      await saving;
    });
    assert.deepEqual(bodies[1], { quietHours: { from: "07:30", until: "09:30" }, _base: current });
    assert.equal(document.querySelector('[role="dialog"]'), null);
  } finally {
    await act(async () => { answerSaveChoice(null); root.unmount(); });
    host.remove();
    globalThis.fetch = originalFetch;
  }
});

test("a whole-record PUT keeps its required fields when the chosen patch contains only a conflict", async () => {
  const originalFetch = globalThis.fetch;
  const id = "9b25b70d-35ec-47e8-b481-5d4a7437ba2b";
  const config = { type: "workspace", tiles: [], datasetIds: [] };
  const before = { id, config, code: "" };
  const current = { id, config, code: "first()" };
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    if (!init?.method) return Response.json({ workspace: before });
    bodies.push(JSON.parse(String(init.body)));
    if (bodies.length === 1) return Response.json({
      error: "Choose a version.", code: "SAVE_CONFLICT", current, patch: { code: "second()" },
      conflicts: [{ path: ["code"], saved: "first()", yours: "second()" }],
    }, { status: 409 });
    return Response.json({ workspace: current });
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let saving: ReturnType<typeof api.savePlotWorkspace> | undefined;
  try {
    await act(async () => { root.render(<SaveConflictHost />); });
    await api.plotWorkspace(id);
    await act(async () => {
      saving = api.savePlotWorkspace({ id, config, code: "second()" });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await act(async () => {
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(element => element.textContent === "Keep saved version")!.click();
      await saving;
    });
    assert.deepEqual(bodies[1], { id, config, code: "first()", _base: current });
  } finally {
    await act(async () => { answerSaveChoice(null); root.unmount(); });
    host.remove();
    globalThis.fetch = originalFetch;
  }
});
