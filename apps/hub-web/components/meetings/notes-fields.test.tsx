import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import type { PageDocument } from "@ensemble/shared-types";
import { api, type MeetingSessionRecord } from "../../lib/api.js";
import { textToDoc } from "../editor/doc.js";
import { MeetingNotesFields, type NotesEditor } from "./notes-fields.js";

(globalThis as { React?: typeof React }).React = React;
const original = api.updateMeeting;
const session = (id: string): MeetingSessionRecord => ({ id, artifactId: null, title: "Planning", notes: "Original", content: textToDoc("Original"), recap: "", status: "live", attachState: "not_asked", personIds: [], startedAt: "2026-10-09T00:00:00Z", endedAt: null, href: `/meetings?session=${id}` });

const doc = (text: string) => textToDoc(text);
const textOf = (value: PageDocument | undefined) => (value?.content ?? []).map((node) => (node.content ?? []).map((part) => part.text ?? "").join("")).join("\n");
const router = { push() {}, replace() {}, prefetch() {}, back() {}, forward() {}, refresh() {} };
const seen: Array<{ page?: { kind: string; id: string }; comments?: boolean }> = [];

/** The block editor's place in these tests: a textarea whose text is the page. */
const FakeEditor: NotesEditor = ({ initial, onChange, page, comments, remote }) => {
  seen.push({ page, comments });
  return <textarea defaultValue={textOf(remote?.doc ?? initial)} onChange={(event) => onChange(doc(event.target.value))} />;
};

async function mount(record: MeetingSessionRecord) {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  client.setQueryData(["meeting-session", record.id], { session: record, openTasks: [], voice: "" });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<AppRouterContext.Provider value={router as never}><QueryClientProvider client={client}><MeetingNotesFields session={record} onRemoved={() => {}} editor={FakeEditor} /></QueryClientProvider></AppRouterContext.Provider>));
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
  const writes: Array<{ title?: string; content?: PageDocument }> = [];
  const completions: Array<() => void> = [];
  api.updateMeeting = async (_id, data) => {
    writes.push(data);
    return new Promise((resolve) => completions.push(() => resolve({ session: { ...record, ...data, notes: textOf(data.content) } })));
  };
  const view = await mount(record);
  try {
    const title = view.host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Meeting title"]')!;
    const notes = view.host.querySelector<HTMLTextAreaElement>('textarea:not([aria-label="Meeting title"])')!;
    await edit(title, "Renamed planning");
    await blur(title);
    await edit(notes, "Latest notes");
    await blur(notes);
    assert.equal(writes.length, 1);
    await act(async () => completions[0]!());
    assert.deepEqual(writes[1], { title: "Renamed planning", content: doc("Latest notes") });
    assert.match(view.host.querySelector('[role="status"]')!.textContent!, /Saving/);
    await act(async () => completions[1]!());
    assert.equal(view.host.querySelector('[role="status"]')!.textContent, "Saved");
    assert.equal(view.client.getQueryData<{ session: MeetingSessionRecord }>(["meeting-session", record.id])!.session.notes, "Latest notes");
  } finally { await view.done(); api.updateMeeting = original; }
});

test("leaving the meeting flushes the latest draft before the debounce", async () => {
  const record = session("navigation");
  const writes: unknown[] = [];
  api.updateMeeting = async (_id, data) => { writes.push(data); return { session: { ...record, ...data, notes: textOf(data.content) } }; };
  const view = await mount(record);
  try {
    await edit(view.host.querySelector<HTMLTextAreaElement>('textarea:not([aria-label="Meeting title"])')!, "Notes before navigation");
    assert.equal(writes.length, 0);
    await view.done();
    assert.deepEqual(writes, [{ title: "Planning", content: doc("Notes before navigation") }]);
  } finally { api.updateMeeting = original; }
});

test("reopening a meeting keeps its previous and new saves in order", async () => {
  const record = session("reopen-pending");
  const writes: Array<{ title?: string; content?: PageDocument }> = [];
  const completions: Array<() => void> = [];
  api.updateMeeting = async (_id, data) => {
    writes.push(data);
    return new Promise((resolve) => completions.push(() => resolve({ session: { ...record, ...data, notes: textOf(data.content) } })));
  };
  const first = await mount(record);
  let reopened: Awaited<ReturnType<typeof mount>> | undefined;
  try {
    await edit(first.host.querySelector<HTMLTextAreaElement>('textarea:not([aria-label="Meeting title"])')!, "Before leaving");
    await blur(first.host.querySelector<HTMLTextAreaElement>('textarea:not([aria-label="Meeting title"])')!);
    await first.done();
    reopened = await mount(record);
    assert.equal(reopened.host.querySelector<HTMLTextAreaElement>('textarea:not([aria-label="Meeting title"])')!.value, "Before leaving");
    await edit(reopened.host.querySelector<HTMLTextAreaElement>('textarea:not([aria-label="Meeting title"])')!, "Latest after reopening");
    await blur(reopened.host.querySelector<HTMLTextAreaElement>('textarea:not([aria-label="Meeting title"])')!);
    assert.equal(writes.length, 1, "a reopened editor must wait for the earlier save");
    await act(async () => completions[0]!());
    assert.equal(textOf(writes[1]!.content), "Before leaving");
    await act(async () => completions[1]!());
    assert.equal(textOf(writes[2]!.content), "Latest after reopening");
    await act(async () => completions[2]!());
    assert.equal(reopened.host.querySelector('[role="status"]')!.textContent, "Saved");
    assert.equal(reopened.client.getQueryData<{ session: MeetingSessionRecord }>(["meeting-session", record.id])!.session.notes, "Latest after reopening");
  } finally { if (reopened) await reopened.done(); api.updateMeeting = original; }
});

test("failed meeting drafts survive SPA navigation and retry on reopening", async () => {
  const record = session("failed-draft");
  api.updateMeeting = async () => { throw new Error("Offline"); };
  const view = await mount(record);
  await edit(view.host.querySelector<HTMLTextAreaElement>('textarea:not([aria-label="Meeting title"])')!, "Recoverable draft");
  await blur(view.host.querySelector<HTMLTextAreaElement>('textarea:not([aria-label="Meeting title"])')!);
  assert.match(view.host.querySelector('[role="status"]')!.textContent!, /Not saved: Offline/);
  assert.ok(Array.from(view.host.querySelectorAll("button")).some((button) => button.textContent === "Retry save"));
  await view.done();
  const writes: unknown[] = [];
  api.updateMeeting = async (_id, data) => { writes.push(data); return { session: { ...record, ...data, notes: textOf(data.content) } }; };
  const reopened = await mount(record);
  try {
    assert.equal(reopened.host.querySelector<HTMLTextAreaElement>('textarea:not([aria-label="Meeting title"])')!.value, "Recoverable draft");
    assert.deepEqual(writes, [{ title: "Planning", content: doc("Recoverable draft") }]);
    assert.equal(reopened.host.querySelector('[role="status"]')!.textContent, "Saved");
  } finally { await reopened.done(); api.updateMeeting = original; }
});

test("the notes are a page editor for this meeting, with inline @ensemble and no comments", async () => {
  seen.length = 0;
  const view = await mount(session("editor"));
  try {
    assert.deepEqual(seen.at(-1), { page: { kind: "meeting", id: "editor" }, comments: false });
    assert.equal(view.host.querySelector<HTMLTextAreaElement>('textarea:not([aria-label="Meeting title"])')!.value, "Original");
  } finally { await view.done(); }
});
