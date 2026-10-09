import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api, type MeetingSessionRecord } from "../../lib/api.js";
import { MeetingNotesFields } from "./notes-fields.js";

(globalThis as { React?: typeof React }).React = React;
const original = api.updateMeeting;
const session = (id: string): MeetingSessionRecord => ({ id, artifactId: null, title: "Planning", notes: "Original", recap: "", status: "live", attachState: "not_asked", personIds: [], startedAt: "2026-10-09T00:00:00Z", endedAt: null, href: `/meetings?session=${id}` });

async function mount(record: MeetingSessionRecord) {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  client.setQueryData(["meeting-session", record.id], { session: record, openTasks: [], voice: "" });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<QueryClientProvider client={client}><MeetingNotesFields session={record} onRemoved={() => {}} /></QueryClientProvider>));
  return { host, client, done: async () => { await act(async () => root.unmount()); host.remove(); client.clear(); } };
}

async function edit(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  input.focus();
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}

async function blur(input: HTMLElement) { await act(async () => input.blur()); }

test("meeting saves serialize edits made during an in-flight request", async () => {
  const record = session("serialized");
  const writes: Array<{ title: string; notes: string }> = [];
  const completions: Array<() => void> = [];
  api.updateMeeting = async (_id, data) => {
    writes.push(data);
    return new Promise((resolve) => completions.push(() => resolve({ session: { ...record, ...data } })));
  };
  const view = await mount(record);
  try {
    const title = view.host.querySelector("input")!;
    const notes = view.host.querySelector("textarea")!;
    await edit(title, "Renamed planning");
    await blur(title);
    await edit(notes, "Latest notes");
    await blur(notes);
    assert.equal(writes.length, 1);
    await act(async () => completions[0]!());
    assert.deepEqual(writes[1], { title: "Renamed planning", notes: "Latest notes" });
    assert.match(view.host.querySelector('[role="status"]')!.textContent!, /Saving/);
    await act(async () => completions[1]!());
    assert.equal(view.host.querySelector('[role="status"]')!.textContent, "Saved");
    assert.equal(view.client.getQueryData<{ session: MeetingSessionRecord }>(["meeting-session", record.id])!.session.notes, "Latest notes");
  } finally { await view.done(); api.updateMeeting = original; }
});

test("leaving the meeting flushes the latest draft before the debounce", async () => {
  const record = session("navigation");
  const writes: unknown[] = [];
  api.updateMeeting = async (_id, data) => { writes.push(data); return { session: { ...record, ...data } }; };
  const view = await mount(record);
  try {
    await edit(view.host.querySelector("textarea")!, "Notes before navigation");
    assert.equal(writes.length, 0);
    await view.done();
    assert.deepEqual(writes, [{ title: "Planning", notes: "Notes before navigation" }]);
  } finally { api.updateMeeting = original; }
});

test("reopening a meeting keeps its previous and new saves in order", async () => {
  const record = session("reopen-pending");
  const writes: Array<{ title: string; notes: string }> = [];
  const completions: Array<() => void> = [];
  api.updateMeeting = async (_id, data) => {
    writes.push(data);
    return new Promise((resolve) => completions.push(() => resolve({ session: { ...record, ...data } })));
  };
  const first = await mount(record);
  let reopened: Awaited<ReturnType<typeof mount>> | undefined;
  try {
    await edit(first.host.querySelector("textarea")!, "Before leaving");
    await blur(first.host.querySelector("textarea")!);
    await first.done();
    reopened = await mount(record);
    assert.equal(reopened.host.querySelector("textarea")!.value, "Before leaving");
    await edit(reopened.host.querySelector("textarea")!, "Latest after reopening");
    await blur(reopened.host.querySelector("textarea")!);
    assert.equal(writes.length, 1, "a reopened editor must wait for the earlier save");
    await act(async () => completions[0]!());
    assert.equal(writes[1]!.notes, "Before leaving");
    await act(async () => completions[1]!());
    assert.equal(writes[2]!.notes, "Latest after reopening");
    await act(async () => completions[2]!());
    assert.equal(reopened.host.querySelector('[role="status"]')!.textContent, "Saved");
    assert.equal(reopened.client.getQueryData<{ session: MeetingSessionRecord }>(["meeting-session", record.id])!.session.notes, "Latest after reopening");
  } finally { if (reopened) await reopened.done(); api.updateMeeting = original; }
});

test("failed meeting drafts survive SPA navigation and retry on reopening", async () => {
  const record = session("failed-draft");
  api.updateMeeting = async () => { throw new Error("Offline"); };
  const view = await mount(record);
  await edit(view.host.querySelector("textarea")!, "Recoverable draft");
  await blur(view.host.querySelector("textarea")!);
  assert.match(view.host.querySelector('[role="status"]')!.textContent!, /Not saved: Offline/);
  assert.ok(Array.from(view.host.querySelectorAll("button")).some((button) => button.textContent === "Retry save"));
  await view.done();
  const writes: unknown[] = [];
  api.updateMeeting = async (_id, data) => { writes.push(data); return { session: { ...record, ...data } }; };
  const reopened = await mount(record);
  try {
    assert.equal(reopened.host.querySelector("textarea")!.value, "Recoverable draft");
    assert.deepEqual(writes, [{ title: "Planning", notes: "Recoverable draft" }]);
    assert.equal(reopened.host.querySelector('[role="status"]')!.textContent, "Saved");
  } finally { await reopened.done(); api.updateMeeting = original; }
});
