import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  RequestCancelledError,
  beginNavigation,
  isRequestCancelled,
  isWebKitCancelError,
  resetFetchCancelState,
  trackRequest,
} from "./fetch-cancel";

describe("fetch cancellation", { concurrency: 1 }, () => {
test("AbortError and RequestCancelledError are cancellations", () => {
  const abort = new Error("The operation was aborted");
  abort.name = "AbortError";
  assert.equal(isRequestCancelled(abort), true);
  assert.equal(isRequestCancelled(new RequestCancelledError()), true);
  assert.equal(new RequestCancelledError().name, "AbortError");
});

test("an aborted signal is a cancellation on every engine", () => {
  const signal = AbortSignal.abort();
  assert.equal(isRequestCancelled(new TypeError("Load failed"), { signal }), true);
  assert.equal(isRequestCancelled(new TypeError("Failed to fetch"), { signal }), true);
  assert.equal(
    isRequestCancelled(new TypeError("Fetch API cannot load /api/settings due to access control checks."), { signal }),
    true,
  );
});

test("WebKit cancel messages count while the page is unloading", () => {
  assert.equal(isWebKitCancelError(new TypeError("Load failed")), true);
  assert.equal(isWebKitCancelError(new TypeError("access control checks")), true);
  assert.equal(isWebKitCancelError(new TypeError("Failed to fetch")), false);
  assert.equal(isRequestCancelled(new TypeError("Load failed"), { unloading: true }), true);
  assert.equal(
    isRequestCancelled(new TypeError("/api/settings due to access control checks."), { unloading: true }),
    true,
  );
});

test("a live page treats WebKit Load failed as a real network error", () => {
  assert.equal(isRequestCancelled(new TypeError("Load failed")), false);
  assert.equal(isRequestCancelled(new TypeError("Failed to fetch")), false);
  assert.equal(isRequestCancelled(new TypeError("Load failed"), { unloading: false, signal: new AbortController().signal }), false);
  assert.equal(isRequestCancelled(new Error("socket hang up")), false);
});

test("navigation aborts the previous epoch once per turn", async () => {
  resetFetchCancelState();
  const first = trackRequest();
  assert.equal(beginNavigation(), true);
  assert.equal(first.signal.aborted, true);

  const second = trackRequest();
  assert.equal(beginNavigation(), false);
  assert.equal(second.signal.aborted, false);

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(beginNavigation(), true);
  assert.equal(second.signal.aborted, true);
  first.close();
  second.close();
  resetFetchCancelState();
});

test("navigation keeps the destination request and still aborts the page being left", async () => {
  resetFetchCancelState();
  const leaving = trackRequest(undefined, "/api/tasks");
  const opening = trackRequest(undefined, "/api/runs?take=10");
  assert.equal(beginNavigation((path) => (path.split("?")[0] ?? path) === "/api/runs"), true);
  assert.equal(leaving.signal.aborted, true);
  assert.equal(opening.signal.aborted, false);
  assert.equal(beginNavigation((path) => (path.split("?")[0] ?? path) === "/api/runs"), false);
  assert.equal(opening.signal.aborted, false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(beginNavigation(), true);
  assert.equal(opening.signal.aborted, true);
  const settled = trackRequest(undefined, "/api/skills");
  assert.equal(settled.signal.aborted, false);
  leaving.close();
  opening.close();
  settled.close();
  resetFetchCancelState();
});

test("an external abort cancels the tracked request", () => {
  resetFetchCancelState();
  const external = new AbortController();
  const tracked = trackRequest(external.signal);
  external.abort();
  assert.equal(tracked.signal.aborted, true);
  tracked.close();
  resetFetchCancelState();
});
});
