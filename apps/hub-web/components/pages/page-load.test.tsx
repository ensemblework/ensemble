/** @jsxRuntime automatic */
/** @jsxImportSource react */
import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ApiError } from "../../lib/api.js";
import { PageLoadFailure, inTrash } from "./page-load.js";

// next/link schedules its prefetch with self.requestIdleCallback.
Object.defineProperty(globalThis, "self", { configurable: true, value: window });

async function render(node: React.ReactNode): Promise<{ root: Root; host: HTMLDivElement }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
  });
  return { root, host };
}

async function unmount({ root, host }: { root: Root; host: HTMLDivElement }) {
  await act(async () => {
    root.unmount();
  });
  host.remove();
}

test("a failed page load offers retry and tells a server error from offline", async () => {
  let retried = 0;
  const failed = await render(<PageLoadFailure missing={false} error={new ApiError("Something went wrong on the Hub.", 500)} onRetry={() => { retried += 1; }} />);
  try {
    const text = document.body.textContent ?? "";
    assert.match(text, /Couldn't load this page/);
    assert.match(text, /server ran into a problem/);
    assert.equal(text.includes("not found"), false);
    const retry = [...document.querySelectorAll("button")].find((node) => node.textContent === "Retry");
    assert.ok(retry);
    await act(async () => {
      retry.click();
    });
    assert.equal(retried, 1);
  } finally {
    await unmount(failed);
  }
  const offline = await render(<PageLoadFailure missing={false} error={new ApiError("Ensemble can't reach its server right now.", 0)} onRetry={() => undefined} />);
  try {
    assert.match(document.body.textContent ?? "", /Can't reach Ensemble/);
  } finally {
    await unmount(offline);
  }
});

test("a missing page or task says so for deleted and never-existing ids, with a way back", async () => {
  const page = await render(<PageLoadFailure missing onRetry={() => undefined} />);
  try {
    const text = document.body.textContent ?? "";
    assert.match(text, /Page not found/);
    assert.match(text, /deleted for good, or the link may be wrong/);
    assert.equal(text.includes("no longer exists"), false);
    assert.deepEqual([...document.querySelectorAll("a")].map((link) => link.getAttribute("href")), ["/pages", "/trash"]);
    assert.equal([...document.querySelectorAll("button")].some((node) => node.textContent === "Retry"), false);
  } finally {
    await unmount(page);
  }
  const task = await render(<PageLoadFailure kind="task" missing onRetry={() => undefined} />);
  try {
    assert.match(document.body.textContent ?? "", /Task not found/);
    assert.equal(document.querySelector("a")?.getAttribute("href"), "/board");
  } finally {
    await unmount(task);
  }
  const shared = await render(<PageLoadFailure missing links={false} onRetry={() => undefined} />);
  try {
    assert.equal(document.querySelectorAll("a").length, 0);
  } finally {
    await unmount(shared);
  }
});

test("a page or task in Trash is told apart from one that is gone", () => {
  assert.equal(inTrash(new ApiError("This page is in Trash.", 404, "PAGE_IN_TRASH")), true);
  assert.equal(inTrash(new ApiError("This task is in Trash.", 404, "TASK_IN_TRASH")), true);
  assert.equal(inTrash(new ApiError("Page not found.", 404, "PAGE_NOT_FOUND")), false);
  assert.equal(inTrash(null), false);
});
