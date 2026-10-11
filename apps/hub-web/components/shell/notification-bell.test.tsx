import "../ui-test-dom.js";
import React, { act } from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { createRoot } from "react-dom/client";
import { filterNotifications, groupNotifications, NotificationContent } from "./notification-bell";
import type { HubNotification } from "@/lib/api";
(globalThis as { React?: typeof React }).React = React;
const row = (id: string, kind: string, readAt: string | null = null): HubNotification => ({ id, kind, title: `Update ${id}`, body: "A useful next step", url: null, urgent: false, createdAt: new Date(2026, 9, 11, 9).toISOString(), readAt });
const rows = [row("a", "agent"), row("b", "decision"), row("c", "share", "2026-10-11"), row("d", "reminder")];
test("notification categories and unread state stay separate", () => {
  assert.deepEqual(filterNotifications(rows, "unread").map((r) => r.id), ["a", "b", "d"]);
  assert.deepEqual(filterNotifications(rows, "requests").map((r) => r.id), ["b"]);
  assert.deepEqual(filterNotifications(rows, "sharing").map((r) => r.id), ["c"]);
  assert.equal(groupNotifications([rows[0]!, { ...rows[1]!, createdAt: new Date(2026, 9, 9).toISOString() }, rows[2]!], new Date(2026, 9, 11, 12)).length, 2);
});
test("filtering is read-only; marking read is explicit and errors do not look empty", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host); const read: string[] = []; let all = 0;
  const props = { rows, loading: false, busy: false, onRead: (id: string) => read.push(id), onReadAll: () => all++, onRetry: () => {}, onClose: () => {} };
  try {
    await act(async () => root.render(<NotificationContent {...props} />));
    const buttons = () => [...host.querySelectorAll("button")];
    await act(async () => buttons().find((b) => b.textContent === "Sharing")!.click());
    assert.match(host.textContent!, /Update c/); assert.doesNotMatch(host.textContent!, /Update a/); assert.equal(read.length, 0);
    await act(async () => buttons().find((b) => b.textContent === "Unread")!.click());
    await act(async () => (host.querySelector('[aria-label=\'Mark "Update a" as read\']') as HTMLButtonElement).click());
    assert.deepEqual(read, ["a"]);
    await act(async () => buttons().find((b) => b.textContent?.includes("Mark all as read"))!.click()); assert.equal(all, 1);
    await act(async () => root.render(<NotificationContent {...props} rows={[]} error="Offline" />));
    assert.match(host.querySelector('[role="alert"]')!.textContent!, /Offline/); assert.doesNotMatch(host.textContent!, /You're all caught up/);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
