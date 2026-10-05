/** @jsxRuntime automatic */
/** @jsxImportSource react */
import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PageLoadFailure } from "./page-load.js";

async function render(node: React.ReactNode): Promise<{ root: Root; host: HTMLDivElement }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
  });
  return { root, host };
}

test("a failed page load offers retry, and a 404 says the page is gone", async () => {
  let retried = 0;
  const failed = await render(
    <PageLoadFailure
      missing={false}
      onRetry={() => {
        retried += 1;
      }}
    />,
  );
  try {
    assert.match(document.body.textContent ?? "", /Couldn't load this page/);
    assert.equal((document.body.textContent ?? "").includes("no longer exists"), false);
    const retry = [...document.querySelectorAll("button")].find((node) => node.textContent === "Retry");
    assert.ok(retry);
    await act(async () => {
      retry.click();
    });
    assert.equal(retried, 1);
  } finally {
    await act(async () => {
      failed.root.unmount();
    });
    failed.host.remove();
  }

  const missing = await render(<PageLoadFailure missing onRetry={() => undefined} />);
  try {
    assert.match(document.body.textContent ?? "", /This page no longer exists/);
    assert.equal((document.body.textContent ?? "").includes("Couldn't load this page"), false);
    assert.equal([...document.querySelectorAll("button")].some((node) => node.textContent === "Retry"), false);
  } finally {
    await act(async () => {
      missing.root.unmount();
    });
    missing.host.remove();
  }
});
