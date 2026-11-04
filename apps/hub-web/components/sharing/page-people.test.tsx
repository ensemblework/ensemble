import "../ui-test-dom.js";
import React, { act, useRef } from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { createRoot } from "react-dom/client";
import type { PresenceEntry } from "@/lib/api";
import { followStore } from "@/lib/follow";
import { presenceStore } from "@/lib/presence";
import { ToastProvider } from "@/components/toast";
import { PagePeople } from "./page-people";
import { FollowBanner, PeoplePanel } from "./people";
(globalThis as { React?: typeof React }).React = React;

const NAMES = ["Test 3", "Test 4", "Test Five", "Test One", "Test Six", "Test Two"];
const entry = (name: string, typing = false, extra: Partial<PresenceEntry> = {}): PresenceEntry => ({
  accountId: `acct-${name}`,
  tabId: `tab-${name}`,
  name,
  initials: "",
  color: "#7048E8",
  route: "/pages/p1",
  resource: { kind: "page", id: "p1" },
  cursor: null,
  viewport: null,
  role: "edit",
  typing,
  at: Date.now(),
  ...extra,
});
const frame = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 40))));

test("past four people the page header shows +N naming the rest, each avatar says who and what, and the list offers Follow", async () => {
  presenceStore.reset(
    NAMES.map((name) => entry(name, name === "Test One", name === "Test 4" ? { accountId: "visitor:v4", signedIn: false, role: "view" } : name === "Test Five" ? { away: true } : {})),
    "me",
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<PagePeople kind="page" id="p1" />));
    const avatars = [...host.querySelectorAll<HTMLButtonElement>("button[data-presence]")];
    assert.equal(avatars.length, 4);
    assert.deepEqual(
      avatars.map((node) => node.getAttribute("aria-label")),
      ["Test 3 · viewing. Show who's here", "Test 4 (guest) · viewing. Show who's here", "Test Five · away. Show who's here", "Test One · editing. Show who's here"],
    );
    assert.deepEqual(avatars.map((node) => node.querySelector("[role='tooltip']")?.textContent), ["Test 3 · viewing", "Test 4 (guest) · viewing", "Test Five · away", "Test One · editing"]);
    assert.deepEqual(avatars.map((node) => node.querySelector("[aria-label^='Test']")?.textContent), ["T3", "T4", "TF", "TO"]);
    const more = [...host.querySelectorAll("button")].find((node) => node.textContent?.startsWith("+2"))!;
    assert.match(more.getAttribute("aria-label")!, /^2 more: Test Six · viewing, Test Two · viewing/);
    assert.match(host.textContent!, /Test One is editing…/);

    await act(async () => avatars[1]!.click());
    await frame();
    const panel = document.querySelector("[role='dialog']") as HTMLElement;
    assert.equal(panel.getAttribute("aria-label"), "On this page");
    assert.equal(panel.querySelectorAll("[data-person]").length, 6);
    assert.equal(document.activeElement?.getAttribute("aria-label"), "Follow Test 4", "the list opens at the person clicked");
    const guest = panel.querySelector("[data-person='visitor:v4']")!;
    assert.match(guest.textContent!, /Test 4Guest/);
    assert.match(guest.textContent!, /Viewing · Can view/);
    assert.match(panel.querySelector("[data-person='acct-Test Five']")!.textContent!, /Away/);
    assert.equal(document.querySelector("[role='tooltip']"), null, "no hover labels over the open list");

    await act(async () => (document.activeElement as HTMLButtonElement).click());
    assert.deepEqual(followStore.get(), { accountId: "visitor:v4", name: "Test 4", color: "#7048E8" });
    assert.equal(document.querySelector("[role='dialog']"), null);
    assert.equal(document.activeElement, avatars[1], "focus goes back to the avatar");
  } finally {
    followStore.stop();
    await act(async () => root.unmount());
    host.remove();
    presenceStore.clear();
  }
});

test("following: the banner names the person; Esc, your own scroll or click stops it, and their leaving ends it with a toast", async () => {
  presenceStore.reset([entry("Test One")], "me");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <ToastProvider>
          <FollowBanner />
        </ToastProvider>,
      ),
    );
    assert.equal(host.querySelector("[role='status'][data-follow-keep]"), null);
    await act(async () => followStore.start({ accountId: "acct-Test One", name: "Test One", color: "#7048E8" }));
    assert.match(host.querySelector("[role='status'][data-follow-keep]")!.textContent!, /Following Test One/);
    // Clicking the banner itself does not stop it; Esc does.
    await act(async () => host.querySelector("[data-follow-keep]")!.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true })));
    assert.ok(followStore.get());
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    assert.equal(followStore.get(), null);

    await act(async () => followStore.start({ accountId: "acct-Test One", name: "Test One", color: "#7048E8" }));
    await act(async () => window.dispatchEvent(new window.Event("wheel")));
    assert.equal(followStore.get(), null, "a scroll of your own takes over");

    await act(async () => followStore.start({ accountId: "acct-Test One", name: "Test One", color: "#7048E8" }));
    await act(async () => presenceStore.apply({ ...entry("Test One"), gone: true }));
    assert.ok(followStore.get(), "a reload looks like leaving for a moment");
  } finally {
    followStore.stop();
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
