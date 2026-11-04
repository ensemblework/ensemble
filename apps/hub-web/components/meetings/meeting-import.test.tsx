import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import type { ImportedMeetingNote } from "../../lib/api-connected.js";
import { MEETING_QUERY, providerForUrl, type MeetingProblem, type MeetingSources } from "../../lib/api-meetings.js";
import { FetchProblem } from "./fetch-problem.js";
import { ImportMenu } from "./import-menu.js";
import { MeetingNoteDetail } from "./imported-notes.js";
import { TranscriptView } from "./transcript-view.js";

(globalThis as { React?: typeof React }).React = React;
// next/link prefetches through requestIdleCallback, which reads `self`.
Object.defineProperty(globalThis, "self", { configurable: true, value: window });
const router = { push() {}, replace() {}, prefetch() {}, back() {}, forward() {}, refresh() {} };

async function mount(node: React.ReactNode, seed?: (client: QueryClient) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  seed?.(client);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<AppRouterContext.Provider value={router as never}><QueryClientProvider client={client}>{node}</QueryClientProvider></AppRouterContext.Provider>));
  return { host, done: async () => { await act(async () => root.unmount()); host.remove(); client.clear(); } };
}

const click = (element: Element) => act(async () => { (element as HTMLElement).click(); });
/** Visible text with a space between elements, as a reader would see it. */
function text(element: Element | null): string {
  if (!element) return "";
  const walker = document.createTreeWalker(element, 4);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) parts.push(node.textContent ?? "");
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

test("join links name their meeting app; look-alike hosts and calendar links do not", () => {
  assert.equal(providerForUrl("https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0"), "teams");
  assert.equal(providerForUrl("https://teams.live.com/meet/9876"), "teams");
  assert.equal(providerForUrl("https://meet.google.com/abc-mnop-xyz?authuser=0"), "google_meet");
  assert.equal(providerForUrl("https://fieldnote.zoom.us/j/85012345678?pwd=x"), "zoom");
  assert.equal(providerForUrl("https://teams.microsoft.com.example.net/l/meetup-join/x"), null);
  assert.equal(providerForUrl("https://calendar.google.com/event?eid=abc"), null);
  assert.equal(providerForUrl("not a link"), null);
  assert.equal(providerForUrl(null), null);
});

test("the transcript opens on request and its search keeps only matching turns, marked", async () => {
  const lines = [
    { speaker: "Mira Chen", text: "Okay, let's start.", at: "00:03" },
    { speaker: "Arjun Rao", text: "The import fix is on staging.", at: "00:10" },
    { speaker: "Arjun Rao", text: "I'll send a FIX for the dates too.", at: "01:05" },
  ];
  const view = await mount(<TranscriptView lines={lines} />);
  try {
    const toggle = view.host.querySelector<HTMLButtonElement>(".transcript-toggle")!;
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.match(text(toggle), /3 turns · 2 speakers/);
    assert.equal(view.host.querySelector(".transcript-lines"), null, "closed until asked");
    await click(toggle);
    assert.equal(view.host.querySelectorAll(".transcript-line").length, 3);
    const search = view.host.querySelector<HTMLInputElement>('input[aria-label="Search the transcript"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "fix");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const shown = [...view.host.querySelectorAll(".transcript-line")];
    assert.equal(shown.length, 2);
    assert.deepEqual([...view.host.querySelectorAll(".transcript-line mark")].map((mark) => mark.textContent), ["fix", "FIX"]);
    assert.equal(text(view.host.querySelector(".transcript-count")), "2 turns");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "arjun");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    assert.equal(view.host.querySelectorAll(".transcript-line").length, 2, "a speaker's name finds their turns");
    await click(view.host.querySelector('button[aria-label="Clear search"]')!);
    assert.equal(view.host.querySelectorAll(".transcript-line").length, 3);
  } finally {
    await view.done();
  }
});

test("an attendee's Teams refusal offers the organizer, Teams and a guided paste", async () => {
  const problem: MeetingProblem = {
    code: "not_organizer",
    provider: "teams",
    title: "Only the organizer can download this transcript",
    detail: "Ask them to share the file, or copy the transcript from Teams and paste it here.",
    actions: [
      { kind: "ask_organizer", label: "Ask Lena to share it", email: "lena@fieldnote.example", subject: "Transcript of “Atlas review”", body: "Hi Lena,\n\nCould you share it?" },
      { kind: "open", label: "Open in Teams", url: "https://teams.microsoft.com/l/meetup-join/x" },
      { kind: "paste", label: "Paste from Teams" },
    ],
  };
  let pasted = 0;
  const view = await mount(<FetchProblem problem={problem} onPaste={() => pasted++} onUpload={() => {}} />);
  try {
    const box = view.host.querySelector("[data-code='not_organizer']")!;
    assert.match(text(box), /Only the organizer can download this transcript/);
    const ask = box.querySelector<HTMLAnchorElement>("a[href^='mailto:']")!;
    assert.equal(text(ask), "Ask Lena to share it");
    assert.ok(ask.classList.contains("btn-primary"), "the first next step leads");
    const mail = new URL(ask.href);
    assert.equal(decodeURIComponent(mail.pathname), "lena@fieldnote.example");
    assert.equal(mail.searchParams.get("subject"), "Transcript of “Atlas review”");
    assert.match(mail.searchParams.get("body") ?? "", /Could you share it\?/);
    const teams = box.querySelector<HTMLAnchorElement>("a[target='_blank']")!;
    assert.equal(teams.href, "https://teams.microsoft.com/l/meetup-join/x");
    assert.equal(teams.rel, "noopener noreferrer");
    const paste = [...box.querySelectorAll("button")].find((button) => text(button) === "Paste from Teams")!;
    await click(paste);
    assert.equal(pasted, 1);
  } finally {
    await view.done();
  }
});

test("one Import menu lists files, pastes, the meeting apps and the meeting-notes apps with their state", async () => {
  const sources: MeetingSources = {
    apps: [
      { id: "teams", label: "Microsoft Teams", connector: "microsoft_365", product: "teams_meetings", productLabel: "Teams meeting transcripts", state: "ready", available: true, account: "mira@fieldnote.example" },
      { id: "google_meet", label: "Google Meet", connector: "google_workspace", product: "meet", productLabel: "Google Meet transcripts", state: "needs_access", available: true, account: "mira@fieldnote.example" },
      { id: "zoom", label: "Zoom", connector: "zoom", product: null, productLabel: "Zoom", state: "not_connected", available: false, account: null },
    ],
    vendors: [
      { id: "granola", label: "Granola", connected: false, account: null, available: true },
      { id: "fireflies", label: "Fireflies.ai", connected: true, account: "mira@fieldnote.example", available: true },
    ],
    calendar: true,
    fileLimitBytes: 10 * 1024 * 1024,
  };
  const chosen: string[] = [];
  const view = await mount(<ImportMenu sources={sources} onUpload={() => chosen.push("upload")} onPaste={() => chosen.push("paste")} onRemote={(provider) => chosen.push(provider)} />);
  try {
    await click(view.host.querySelector("button[aria-haspopup='menu']")!);
    const menu = document.querySelector("[role='menu'][aria-label='Import a meeting']")!;
    const items = [...menu.querySelectorAll<HTMLElement>("[role='menuitem']")];
    const row = (name: string) => items.find((item) => text(item).startsWith(name))!;
    assert.deepEqual(items.map((item) => text(item)), [
      "Upload a transcript .vtt, .docx, .srt, .txt or .json",
      "Paste a transcript Copied from Teams, Zoom or Meet",
      "Microsoft Teams Connected",
      "Google Meet Turn on",
      "Zoom Not set up here",
      "Granola Connect",
      "Fireflies.ai Import 30 days",
    ]);
    assert.equal((row("Zoom") as HTMLButtonElement).disabled, true, "an app the server can't connect is not offered");
    assert.equal(row("Granola").getAttribute("href"), "/settings?tab=connections&connector=granola");
    await click(row("Microsoft Teams"));
    assert.deepEqual(chosen, ["teams"]);
  } finally {
    await view.done();
  }
});

const note = (overrides: Partial<ImportedMeetingNote> = {}): ImportedMeetingNote => ({
  id: "note-1",
  title: "Customer call: Northwind",
  source: "transcript",
  sourceLabel: "Copied from a Teams transcript",
  occurredAt: "2026-11-02T09:00:00.000Z",
  summary: "",
  decisions: ["Keep the old importer for two weeks."],
  actionItems: [
    { text: "Could you share the rollout plan with our admins?", owner: null, mine: false, completed: false, due: null, url: null, at: "01:40", taskId: null },
    { text: "I'll send a fix to staging by Thursday.", owner: { name: "Arjun Rao", email: null }, mine: false, completed: false, due: null, url: null, at: "01:05", taskId: null },
    { text: "Book the follow-up.", owner: { name: "Mira Chen", email: null }, mine: true, completed: false, due: null, url: null, at: null, taskId: "task-9" },
  ],
  waitingOn: [{ text: "I'll send a fix to staging by Thursday.", owner: { name: "Arjun Rao", email: null } }],
  suggested: true,
  speakers: ["Mira Chen", "Arjun Rao", "Dana Whitfield"],
  lineCount: 2,
  durationMinutes: 3,
  format: "teams-copy",
  transcriptUrl: null,
  event: { id: "evt-1", title: "Customer call: Northwind", url: null, startsAt: "2026-11-02T09:00:00.000Z" },
  project: null,
  people: [{ id: "p-arjun", name: "Arjun Rao" }],
  tasks: [{ id: "task-9", title: "Book the follow-up", status: "todo" }],
  ...overrides,
});

test("an imported meeting: event, people, your action items apart from others', and the transcript", async () => {
  const listed = note();
  const view = await mount(<MeetingNoteDetail note={listed} />, (client) => {
    client.setQueryData(["me"], { user: { id: "u-mira", email: "mira@fieldnote.example", name: "Mira Chen" } });
    client.setQueryData(MEETING_QUERY.note(listed.id), { note: { ...listed, transcript: [{ speaker: "Arjun Rao", text: "I'll send a fix.", at: "01:05" }, { speaker: "Dana Whitfield", text: "Thanks.", at: "01:20" }] } });
  });
  try {
    assert.match(text(view.host.querySelector(".note-props")), /Meeting Customer call: Northwind/);
    const people = [...view.host.querySelectorAll(".note-person")];
    assert.deepEqual(people.map((row) => [text(row), row.hasAttribute("data-linked")]), [["Arjun Rao", true], ["Dana Whitfield", false]], "you are not listed among the others");
    const sections = [...view.host.querySelectorAll(".note-section")];
    const section = (title: string) => sections.find((row) => text(row.querySelector("h3")) === title)!;
    const rows = (title: string) => [...section(title).querySelectorAll(".note-action > div > p:first-child, .note-action > p")].map(text);
    assert.deepEqual(rows("Action items"), ["Could you share the rollout plan with our admins?", "Book the follow-up."]);
    assert.deepEqual(rows("Waiting on others"), ["I'll send a fix to staging by Thursday."], "an item someone else owns is listed once");
    assert.equal(section("Action items").querySelector("a[href='/tasks/task-9']")?.textContent, "Open task");
    assert.ok(section("Waiting on others").querySelector("button[aria-label^='Make task:']"));
    assert.match(text(view.host.querySelector(".transcript-toggle")), /2 turns · 2 speakers/);
  } finally {
    await view.done();
  }
});
