import "../components/ui-test-dom.js";
import React, { act } from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { createRoot } from "react-dom/client";
import { useStoredChoice } from "./prefs";

(globalThis as { React?: typeof React }).React = React;
Object.defineProperty(globalThis, "CustomEvent", { configurable: true, value: window.CustomEvent });

test("a stored choice is there on the first render, an unexpected one falls back, and a change reaches every reader", async () => {
  const key = "ensemble.test.order";
  window.localStorage.setItem(key, JSON.stringify("manual"));
  const seen: string[] = [];
  let set: ((value: "priority" | "manual") => void) | null = null;
  function Reader({ log }: { log?: boolean }) {
    const [order, setOrder] = useStoredChoice<"priority" | "manual">(key, "priority", ["priority", "manual"]);
    if (log) { seen.push(order); set = setOrder; }
    return <span data-order={order} />;
  }
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const drawn = () => [...host.querySelectorAll("[data-order]")].map((node) => node.getAttribute("data-order")).join(",");
  try {
    await act(async () => root.render(<><Reader log /><Reader /></>));
    assert.equal(seen[0], "manual", "the first render already sorts by the stored choice");
    assert.equal(seen.includes("priority"), false, "the default order is never drawn first");
    await act(async () => set!("priority"));
    assert.equal(drawn(), "priority,priority");
    assert.equal(window.localStorage.getItem(key), JSON.stringify("priority"));
    window.localStorage.setItem(key, JSON.stringify("sideways"));
    await act(async () => root.render(<><Reader /><Reader /></>));
    await act(async () => window.dispatchEvent(new CustomEvent("ensemble:pref", { detail: key })));
    assert.equal(drawn(), "priority,priority", "a value outside the allowed list falls back");
  } finally {
    await act(async () => root.unmount()); host.remove(); window.localStorage.removeItem(key);
  }
});
