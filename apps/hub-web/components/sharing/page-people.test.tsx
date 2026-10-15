import "../ui-test-dom.js";
import React, { act, useRef } from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { createRoot } from "react-dom/client";
import type { PresenceEntry } from "@/lib/api";
import { presenceStore } from "@/lib/presence";
import { PagePeople } from "./page-people";
import { PeoplePanel } from "./people";
(globalThis as { React?: typeof React }).React = React;

const NAMES = ["Test 3", "Test 4", "Test Five", "Test One", "Test Six", "Test Two"];
const entry = (name: string, typing = false): PresenceEntry => ({
  accountId: `acct-${name}`,
  tabId: `tab-${name}`,
  name,
  initials: "",
  color: "#7048E8",
  route: "/pages/p1",
  resource: { kind: "page", id: "p1" },
  cursor: null,
  viewport: null,
  typing,
  at: Date.now(),
});
const frame = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 40))));

test("past four people the page header shows +N naming the rest, and full names everywhere", async () => {
  presenceStore.reset(NAMES.map((name) => entry(name, name === "Test One")), "me");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<PagePeople kind="page" id="p1" />));
    const chip = host.querySelector("button")!;
    assert.equal(chip.querySelectorAll("[aria-label^='Test']").length, 4);
    const more = [...chip.querySelectorAll("span")].find((node) => node.textContent === "+2")!;
    assert.equal(more.getAttribute("title"), "Test Six is viewing\nTest Two is viewing");
    assert.match(chip.getAttribute("aria-label")!, /Test One is editing, .*Test Six is viewing, Test Two is viewing$/);
    assert.deepEqual([...chip.querySelectorAll("[aria-label^='Test']")].map((node) => node.textContent), ["T3", "T4", "TF", "TO"]);
    assert.match(host.textContent!, /Test One is editing…/);

    await act(async () => chip.click());
    await frame();
    const panel = document.querySelector("[role='dialog']") as HTMLElement;
    assert.equal(panel.getAttribute("aria-label"), "On this page");
    assert.equal(document.activeElement, panel);
    assert.equal(panel.querySelectorAll("li").length, 6);

    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(document.querySelector("[role='dialog']"), null);
    assert.equal(document.activeElement, chip);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    presenceStore.clear();
  }
});

function Panel({ onClose }: { onClose: () => void }) {
  const opener = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = React.useState(true);
  return (
    <>
      <button ref={opener} type="button">
        Chip
      </button>
      {open ? (
        <PeoplePanel label="Here now" opener={opener}>
          <button type="button">Go to Test One</button>
          <button type="button">Follow Test One</button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onClose();
            }}
          >
            Go to Test Two
          </button>
        </PeoplePanel>
      ) : null}
    </>
  );
}

test("the people list takes focus, moves with arrows and Tab, and hands focus back when it closes", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let closed = 0;
  try {
    await act(async () => root.render(<Panel onClose={() => closed++} />));
    await frame();
    const label = () => document.activeElement?.textContent?.trim();
    assert.equal(label(), "Go to Test One");
    const key = (init: KeyboardEventInit) => act(async () => void document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init })));
    await key({ key: "ArrowDown" });
    assert.equal(label(), "Follow Test One");
    await key({ key: "Tab" });
    assert.equal(label(), "Go to Test Two");
    await key({ key: "Tab" });
    assert.equal(label(), "Go to Test One");
    await key({ key: "Tab", shiftKey: true });
    assert.equal(label(), "Go to Test Two");
    await key({ key: "End" });
    await act(async () => (document.activeElement as HTMLButtonElement).click());
    assert.equal(closed, 1);
    assert.equal(label(), "Chip");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
