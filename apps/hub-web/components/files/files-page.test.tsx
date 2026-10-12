import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { FileImportSource, FileRecord, FileUsage } from "@ensemble/shared-types";
import { bindToast } from "@/lib/toast-bus";
import { FilesScreen, usageLine } from "./files-screen.js";
import { ImportFromApps } from "./import-from-apps.js";
import { checkUploads } from "./use-uploads.js";

Object.defineProperty(globalThis, "self", { configurable: true, value: window });

type Call = { method: string; url: URL; body: unknown };

const MB = 1024 * 1024;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function record(id: string, filename: string, more: Partial<FileRecord> = {}): FileRecord {
  return {
    id,
    filename,
    mediaType: "application/pdf",
    byteSize: 2 * MB,
    format: filename.split(".").pop() ?? "",
    kind: "pdf",
    sha256: `sha-${id}`,
    textStatus: "ready",
    textCharacters: 1200,
    pageCount: 3,
    warnings: [],
    summary: null,
    source: null,
    hasStyle: false,
    createdAt: "2026-10-10T09:00:00.000Z",
    updatedAt: "2026-10-10T09:00:00.000Z",
    ...more,
  };
}

const HOSTED: FileUsage = { count: 4, bytes: 18 * MB, maxCount: 10, maxBytes: 50 * MB, maxFileBytes: 25 * MB };
const FILES = [
  record("f1", "Lease agreement.pdf"),
  record("f2", "Budget.xlsx", { kind: "sheet", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", source: { app: "google_drive", label: "Google Drive" } }),
  record("f3", "Field notes.txt", { kind: "text", mediaType: "text/plain", byteSize: 4200 }),
];

async function mount(node: React.ReactNode, handle: (call: Call) => unknown) {
  const calls: Call[] = [];
  const toasts: Array<{ text: string; tone?: string }> = [];
  bindToast((text, options) => void toasts.push({ text, tone: options?.tone }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { method: init?.method ?? "GET", url: new URL(String(input), "http://localhost"), body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    const answer = handle(call);
    if (answer instanceof Response) return answer;
    if (answer !== undefined) return json(answer);
    return json({ error: `not mocked: ${call.method} ${call.url.pathname}` }, 404);
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return {
    calls,
    toasts,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
      client.clear();
      globalThis.fetch = realFetch;
      bindToast(null);
    },
  };
}

const text = () => document.body.textContent ?? "";

async function waitFor(check: () => boolean, label: string, timeout = 3000) {
  const until = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${label}; page says: ${text().slice(0, 600)}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  }
}

function button(label: RegExp): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find((node) => label.test((node.textContent ?? "").trim()) || label.test(node.getAttribute("aria-label") ?? ""));
  assert.ok(found, `Missing button ${label}; page says: ${text().slice(0, 400)}`);
  return found as HTMLButtonElement;
}

async function click(node: HTMLElement) {
  await act(async () => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function choose(files: File[]) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  assert.ok(input, "the upload input is on the page");
  Object.defineProperty(input, "files", { configurable: true, value: files });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

test("the list shows each file with its kind, size and source, and hosted usage above it", async () => {
  const view = await mount(<FilesScreen />, (call) => (call.url.pathname === "/api/documents" ? { files: FILES, usage: HOSTED } : undefined));
  try {
    await waitFor(() => Boolean(document.querySelector('[data-file-row="f2"]')), "the files");
    assert.match(document.querySelector('[data-testid="file-usage"]')?.textContent ?? "", /4 of 10 files · 18 MB of 50 MB/);
    const budget = document.querySelector<HTMLAnchorElement>('[data-file-row="f2"]')!;
    assert.equal(budget.getAttribute("href"), "/files/f2");
    assert.match(budget.textContent ?? "", /Budget\.xlsx/);
    assert.match(budget.textContent ?? "", /Excel workbook · 2\.0 MB/);
    assert.match(budget.textContent ?? "", /Google Drive/);
    await click(button(/^Spreadsheet$/));
    assert.equal(document.querySelectorAll("[data-file-row]").length, 1, "the kind chips filter the list");
    await click(button(/^All$/));
    assert.equal(document.querySelectorAll("[data-file-row]").length, 3);
  } finally {
    await view.done();
  }
});

test("usage is hidden where there are no caps (desktop)", async () => {
  assert.equal(usageLine({ count: 40, bytes: 900 * MB, maxCount: null, maxBytes: null, maxFileBytes: 200 * MB }), null);
  const view = await mount(<FilesScreen />, (call) =>
    call.url.pathname === "/api/documents" ? { files: FILES, usage: { count: 3, bytes: 4 * MB, maxCount: null, maxBytes: null, maxFileBytes: 200 * MB } } : undefined,
  );
  try {
    await waitFor(() => Boolean(document.querySelector("[data-file-row]")), "the files");
    assert.equal(document.querySelector('[data-testid="file-usage"]'), null);
  } finally {
    await view.done();
  }
});

test("an upload sends the file, shows it as uploaded, and refreshes the list", async () => {
  let listed = FILES;
  const view = await mount(<FilesScreen />, (call) => {
    if (call.url.pathname !== "/api/documents") return undefined;
    if (call.method === "POST") {
      const body = call.body as { filename: string; mediaType: string; dataBase64: string };
      const added = record("f9", body.filename, { kind: "text", mediaType: body.mediaType });
      listed = [added, ...listed];
      return json({ file: added }, 201);
    }
    return { files: listed, usage: HOSTED };
  });
  try {
    await waitFor(() => Boolean(document.querySelector("[data-file-row]")), "the files");
    await choose([new File(["Planting dates"], "Plan.txt", { type: "text/plain" })]);
    await waitFor(() => view.toasts.some((toast) => toast.text === "Uploaded 1 file."), "the upload to finish");
    const post = view.calls.find((call) => call.method === "POST")!;
    assert.deepEqual(post.body, { filename: "Plan.txt", mediaType: "text/plain", dataBase64: Buffer.from("Planting dates").toString("base64") });
    assert.equal(document.querySelector("[data-upload-state]")?.getAttribute("data-upload-state"), "done");
    await waitFor(() => Boolean(document.querySelector('[data-file-row="f9"]')), "the new file in the list");
  } finally {
    await view.done();
  }
});

test("the server's cap message is shown as it is, and files over the size limit never leave the browser", async () => {
  const view = await mount(<FilesScreen />, (call) => {
    if (call.url.pathname !== "/api/documents") return undefined;
    if (call.method === "POST") return json({ error: "Hosted accounts keep up to 10 files. Delete one to add another." }, 413);
    return { files: FILES, usage: HOSTED };
  });
  try {
    await waitFor(() => Boolean(document.querySelector("[data-file-row]")), "the files");
    await choose([new File(["x"], "Notes.md", { type: "text/markdown" })]);
    await waitFor(() => view.toasts.some((toast) => toast.tone === "error"), "the error");
    assert.deepEqual(view.toasts.at(-1), { text: "Notes.md: Hosted accounts keep up to 10 files. Delete one to add another.", tone: "error" });
    assert.equal(document.querySelector("[data-upload-state]")?.getAttribute("data-upload-state"), "failed");
    const before = view.calls.filter((call) => call.method === "POST").length;
    const big = new File(["x"], "Scan.pdf", { type: "application/pdf" });
    Object.defineProperty(big, "size", { value: 30 * MB });
    await choose([big]);
    assert.equal(view.calls.filter((call) => call.method === "POST").length, before, "nothing was sent");
    assert.match(view.toasts.at(-1)!.text, /Scan\.pdf is 30 MB\. Each file can be up to 25 MB here\./);
  } finally {
    await view.done();
  }
});

test("upload checks keep within the count and space a hosted account has left", () => {
  const files = [new File(["a"], "a.txt"), new File(["b"], "b.txt"), new File(["c"], "c.txt")];
  const nearlyFull = checkUploads(files, { ...HOSTED, count: 9 });
  assert.deepEqual(nearlyFull.accepted.map((file) => file.name), ["a.txt"]);
  assert.match(nearlyFull.problem ?? "", /Only 1 more file fits/);
  const full = checkUploads(files, { ...HOSTED, count: 10 });
  assert.equal(full.accepted.length, 0);
  assert.match(full.problem ?? "", /Files is full/);
  const desktop = checkUploads(files, { count: 400, bytes: 9e9, maxCount: null, maxBytes: null, maxFileBytes: 500 * MB });
  assert.equal(desktop.accepted.length, 3);
  assert.equal(desktop.problem, null);
});

const SOURCES: FileImportSource[] = [
  {
    id: "google_drive",
    itemSource: "google_workspace",
    connector: "google_workspace",
    name: "Google Drive",
    logo: "google_drive",
    kind: "file",
    state: "ready",
    message: "Pick any file from your Drive.",
    picker: true,
  },
  {
    id: "gmail",
    itemSource: "google_workspace",
    connector: "google_workspace",
    name: "Gmail attachments",
    logo: "gmail",
    kind: "attachment",
    state: "needs_permission",
    message: "Ensemble needs permission to read your mail before it can bring in attachments.",
    steps: ["Open Settings → Connections → Google Workspace.", "Turn on Gmail.", "Approve the request from Google."],
    action: { label: "Open Google Workspace", href: "/settings?tab=connections&connector=google_workspace" },
  },
  {
    id: "dropbox",
    itemSource: "dropbox",
    connector: "dropbox",
    name: "Dropbox",
    logo: "dropbox",
    kind: "file",
    state: "not_connected",
    message: "Connect Dropbox to bring in files from it.",
    action: { label: "Connect Dropbox", href: "/settings?tab=connections&connector=dropbox" },
  },
];

test("Add from your apps lists each app's state, with plain steps and a way to fix what is missing", async () => {
  const view = await mount(<ImportFromApps open onClose={() => undefined} />, (call) => {
    if (call.url.pathname === "/api/shell") return { user: { name: "Mira Chen" } };
    if (call.url.pathname === "/api/documents/import-sources") return { sources: SOURCES };
    if (call.url.pathname === "/api/app-items/sources") return { sources: [{ id: "google_workspace", name: "Google Workspace", logo: "google_workspace", kinds: ["file", "attachment"], people: false, comments: false }] };
    if (call.url.pathname === "/api/app-items/search") return { items: [], errors: [] };
    return undefined;
  });
  try {
    await waitFor(() => Boolean(document.querySelector('[data-import-source="dropbox"]')), "the sources");
    const gmail = document.querySelector('[data-import-source="gmail"]')!;
    assert.match(gmail.textContent ?? "", /Needs permission/);
    assert.deepEqual(
      Array.from(gmail.querySelectorAll("ol li")).map((item) => item.textContent),
      ["Open Settings → Connections → Google Workspace.", "Turn on Gmail.", "Approve the request from Google."],
    );
    assert.equal(gmail.querySelector("a")?.getAttribute("href"), "/settings?tab=connections&connector=google_workspace");
    assert.match(document.querySelector('[data-import-source="dropbox"]')?.textContent ?? "", /Not connected.*Connect Dropbox to bring in files from it\..*Connect Dropbox/);
    const drive = document.querySelector('[data-import-source="google_drive"]')!;
    assert.ok(!drive.querySelector("[data-import-guidance]"), "a ready app needs no steps");
    assert.match(drive.textContent ?? "", /Pick from Google Drive/);
    await click(button(/^Search Drive$/));
    await waitFor(() => Boolean(document.querySelector('[data-testid="app-item-picker"]')), "the app picker");
    assert.match(document.querySelector('[role="dialog"]')?.textContent ?? "", /Add from Google Drive/);
    await waitFor(() => view.calls.some((call) => call.url.pathname === "/api/app-items/search"), "the picker's search");
    const search = view.calls.find((call) => call.url.pathname === "/api/app-items/search");
    assert.equal(search?.url.searchParams.get("source"), "google_workspace");
    assert.equal(search?.url.searchParams.get("kind"), "file");
  } finally {
    await view.done();
  }
});
