import "../ui-test-dom";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MAX_UPLOAD_BYTES } from "@ensemble/shared-types";
import { UploadDialog } from "./upload-dialog";

(globalThis as { React?: typeof React }).React = React;

test("a file over 20 MB is refused before it is read or sent", async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    return new Response("{}", { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<UploadDialog open existing={[]} onClose={() => {}} onAccept={() => {}} />));
    assert.match(document.body.textContent ?? "", /Up to 20 MB/);
    const input = document.querySelector<HTMLInputElement>("input[data-plot-file]")!;
    const big = new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], "readings.csv", { type: "text/csv" });
    Object.defineProperty(input, "files", { configurable: true, value: [big] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    assert.match(document.body.textContent ?? "", /Files for plots can be up to 20 MB\./);
    assert.equal(requests, 0, "nothing was sent");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = original;
  }
});

test("table upload starts without a simulated scan and reports only measured transfer progress", async () => {
  const original = globalThis.XMLHttpRequest;
  const requests: DatasetRequest[] = [];
  class DatasetRequest {
    upload = { onprogress: null as ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null, onload: null as (() => void) | null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    status = 200;
    responseText = "";
    payload = "";
    open() {}
    setRequestHeader() {}
    send(payload: string) { this.payload = payload; requests.push(this); }
  }
  globalThis.XMLHttpRequest = DatasetRequest as unknown as typeof XMLHttpRequest;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<UploadDialog open existing={[]} onClose={() => {}} onAccept={() => {}} />));
    const input = document.querySelector<HTMLInputElement>("input[data-plot-file]")!;
    const csv = `epoch,loss\n${"1,0.9\n".repeat(5000)}`;
    Object.defineProperty(input, "files", { configurable: true, value: [new File([csv], "readings.csv", { type: "text/csv" })] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    assert.equal(requests.length, 1, "the large text file reaches the request without timer-driven scanning");
    const request = requests[0]!;
    assert.equal(JSON.parse(request.payload).text, csv);

    await act(async () => {
      request.upload.onprogress?.({ lengthComputable: true, loaded: 25, total: 100 });
      await new Promise((resolve) => setTimeout(resolve, 270));
    });
    assert.equal(document.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow"), "25");
    assert.match(document.querySelector("[data-upload-busy]")?.textContent ?? "", /Uploading/);
    await act(async () => request.upload.onload?.());
    assert.equal(document.querySelector('[role="progressbar"]'), null, "server parsing has no measurable percentage");
    assert.doesNotMatch(document.querySelector("[data-upload-busy]")?.textContent ?? "", /%|Reading columns/);
    assert.match(document.querySelector("[data-upload-busy]")?.textContent ?? "", /Reading the table/);

    request.responseText = JSON.stringify({ dataset: { id: "data", name: "readings", columns: [{ name: "epoch", type: "number" }], rowCount: 5000, warnings: [] } });
    await act(async () => request.onload?.());
    assert.equal(document.querySelector("[data-upload-busy]"), null);
    assert.match(document.querySelector("[data-column-summary]")?.textContent ?? "", /5,000 rows/);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    globalThis.XMLHttpRequest = original;
  }
});

test("a failed upload leaves the loading state and offers another attempt", async () => {
  const original = globalThis.XMLHttpRequest;
  let request: FailedRequest | undefined;
  class FailedRequest {
    upload = { onprogress: null, onload: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    status = 500;
    responseText = JSON.stringify({ error: "The table could not be read." });
    open() {}
    setRequestHeader() {}
    send() { request = this; }
  }
  globalThis.XMLHttpRequest = FailedRequest as unknown as typeof XMLHttpRequest;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<UploadDialog open existing={[]} onClose={() => {}} onAccept={() => {}} />));
    const input = document.querySelector<HTMLInputElement>("input[data-plot-file]")!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["x,y\n1,2"], "table.csv", { type: "text/csv" })] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    assert.ok(request);
    await act(async () => request!.onload?.());
    assert.equal(document.querySelector("[data-upload-busy]"), null);
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /The table could not be read/);
    assert.ok(document.querySelector("[data-upload-start]"));
  } finally {
    await act(async () => root.unmount());
    host.remove();
    globalThis.XMLHttpRequest = original;
  }
});
