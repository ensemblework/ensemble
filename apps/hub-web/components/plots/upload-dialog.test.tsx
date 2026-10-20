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
