import "../ui-test-dom.js";
import React, { act } from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { createRoot } from "react-dom/client";
import { filterNotifications, groupNotifications, NotificationContent } from "./notification-bell";
import type { HubNotification } from "@/lib/api";
(globalThis as { React?: typeof React }).React = React;
const row = (id: string, kind: string, readAt: string | null = null): HubNotification => ({ id, kind, title: `Update ${id}`, body: "A useful next step", url: null, urgent: false, createdAt: new Date(2026, 9, 11, 9).toISOString(), readAt });
const rows = [row("a", "agent"), row("b", "decision"), row("c", "share"), row("d", "reminder"), row("e", "share", "2026-10-11")];
const props = { rows, loading: false, busy: false, onRetry: () => {}, onClose: () => {} };

test("tabs: unread is everything unread; needs me holds requests and stuck runs; read rows never show", () => {
  assert.deepEqual(filterNotifications(rows, "unread").map((r) => r.id), ["a", "b", "c", "d"]);
  assert.deepEqual(filterNotifications(rows, "needs").map((r) => r.id), ["a", "b"]);
  assert.deepEqual(filterNotifications(rows, "reminders").map((r) => r.id), ["d"]);
  assert.deepEqual(filterNotifications(rows, "sharing").map((r) => r.id), ["c"]);
  assert.equal(groupNotifications([rows[0]!, { ...rows[1]!, createdAt: new Date(2026, 9, 9).toISOString() }, rows[2]!], new Date(2026, 9, 11, 12)).length, 2);
});

test("opens on Unread, switching tabs reads nothing, Clear dismisses only the visible tab, errors do not look empty", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host); const read: string[] = []; const cleared: string[][] = [];
  try {
    await act(async () => root.render(<NotificationContent {...props} onRead={(id) => read.push(id)} onClear={(ids) => cleared.push(ids)} />));
    assert.equal(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.replace(/\d+/g, ""), "Unread");
    assert.deepEqual(["Unread", "Needs me", "Reminders", "Sharing"], [...host.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent!.replace(/\d+/g, "")));
    const tab = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent!.startsWith(name))!;
    await act(async () => tab("Needs me").click());
    assert.match(host.textContent!, /Update a/); assert.match(host.textContent!, /Update b/); assert.doesNotMatch(host.textContent!, /Update c/); assert.equal(read.length, 0);
    await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Clear these")!.click());
    assert.deepEqual(cleared, [["a", "b"]]);
    await act(async () => tab("Sharing").click());
    assert.match(host.textContent!, /Update c/); assert.doesNotMatch(host.textContent!, /Update e/);
    await act(async () => root.render(<NotificationContent {...props} rows={[]} error="Offline" onRead={() => {}} onClear={() => {}} />));
    assert.match(host.querySelector('[role="alert"]')!.textContent!, /Offline/); assert.doesNotMatch(host.textContent!, /all caught up/);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

test("dismissing a notification keeps keyboard focus on the next one", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host); const read: string[] = [];
  try {
    await act(async () => root.render(<NotificationContent {...props} onRead={(id) => read.push(id)} onClear={() => {}} />));
    const first = host.querySelector('[aria-label=\'Dismiss "Update a"\']') as HTMLButtonElement;
    first.focus();
    await act(async () => { first.click(); await new Promise((resolve) => setTimeout(resolve, 220)); });
    assert.deepEqual(read, ["a"]);
    assert.equal(document.activeElement?.getAttribute("aria-label"), 'Dismiss "Update b"');
  } finally { await act(async () => root.unmount()); host.remove(); }
});
