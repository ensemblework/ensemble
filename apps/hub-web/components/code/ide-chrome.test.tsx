import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { threadState } from "./agent-actions.js";
import { ScrollTabs } from "./ide-chrome.js";

(globalThis as { React?: typeof React }).React = React;

test("tabs that do not fit get an arrow at each end, and each click shows the next hidden tab in full", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const width = 120;
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  const saved = ["scrollWidth", "clientWidth", "offsetLeft", "offsetWidth"].map((key) => [key, Object.getOwnPropertyDescriptor(proto, key)] as const);
  // Five tabs of 100 px in a 250 px row.
  Object.defineProperty(proto, "scrollWidth", { configurable: true, get() { return (this as HTMLElement).getAttribute?.("role") === "tablist" ? 500 : 0; } });
  Object.defineProperty(proto, "clientWidth", { configurable: true, get() { return (this as HTMLElement).getAttribute?.("role") === "tablist" ? 250 : 0; } });
  Object.defineProperty(proto, "offsetWidth", { configurable: true, get() { return 100; } });
  Object.defineProperty(proto, "offsetLeft", { configurable: true, get() { return Number((this as HTMLElement).dataset?.index ?? 0) * 100; } });
  try {
    await act(async () =>
      root.render(
        <ScrollTabs label="Open tabs">
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} role="tab" data-index={index} style={{ width }}>
              Thread {index}
            </div>
          ))}
        </ScrollTabs>,
      ),
    );
    const before = host.querySelector<HTMLButtonElement>('[aria-label="Show the tab before"]')!;
    const after = host.querySelector<HTMLButtonElement>('[aria-label="Show the tab after"]')!;
    assert.ok(before && after, "both arrows show when the tabs overflow");
    assert.equal(before.disabled, true, "nothing before the first tab");
    const strip = host.querySelector<HTMLElement>('[role="tablist"]')!;
    await act(async () => after.click());
    assert.equal(strip.scrollLeft, 50, "the third tab, cut off at 250 px, now shows in full");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(proto, key, descriptor);
      else delete proto[key];
    }
  }
});

test("a thread's dot: working, finished and not read yet, stopped on an error, or read", () => {
  const thread = (status: string, id = "job-2") => ({ id: "t1", last: { id, status: status as never, engine: null, model: "" } });
  assert.equal(threadState(thread("running"), {}), "running");
  assert.equal(threadState(thread("waiting_approval"), {}), "running");
  assert.equal(threadState(thread("done"), {}), "new");
  assert.equal(threadState(thread("failed"), {}), "failed");
  assert.equal(threadState(thread("done"), { t1: "job-2" }), "read");
  assert.equal(threadState(thread("done", "job-3"), { t1: "job-2" }), "new", "a later turn is new again");
  assert.equal(threadState({ id: "t2", last: null }, {}), "read");
});
