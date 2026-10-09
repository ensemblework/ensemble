import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ApiError, api } from "./api";
import { abortAll, beginNavigation, resetFetchCancelState, setPageUnloading } from "./fetch-cancel";

const OFFLINE = "Ensemble can't reach its server right now.";

describe("api abort", { concurrency: 1 }, () => {

function installFetch(impl: typeof fetch): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => {
    globalThis.fetch = original;
    resetFetchCancelState();
    setPageUnloading(false);
  };
}

test("WebKit Load failed while the query signal is aborted is not an offline error", async () => {
  const restore = installFetch(((_input: unknown, init?: RequestInit) => {
    return new Promise((_resolve, reject) => {
      const fail = () => reject(new TypeError("Load failed"));
      if (init?.signal?.aborted) fail();
      else init?.signal?.addEventListener("abort", fail, { once: true });
    });
  }) as typeof fetch);
  try {
    const controller = new AbortController();
    const health = api.health as (context?: unknown) => ReturnType<typeof api.health>;
    const pending = health({
      queryKey: ["health"],
      client: { getQueryCache: () => ({}) },
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(pending, (error: unknown) => {
      assert.equal(error instanceof ApiError, false);
      assert.equal((error as Error).name, "AbortError");
      assert.equal((error as Error).message.includes("can't reach"), false);
      return true;
    });
  } finally {
    restore();
  }
});

test("Load failed on a live page is still the offline error", async () => {
  const restore = installFetch((async () => {
    throw new TypeError("Load failed");
  }) as typeof fetch);
  try {
    await assert.rejects(api.health(), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 0);
      assert.equal(error.message, OFFLINE);
      return true;
    });
  } finally {
    restore();
  }
});

test("Load failed while the document is unloading is a cancellation", async () => {
  setPageUnloading(true);
  const restore = installFetch((async () => {
    throw new TypeError("Fetch API cannot load /api/settings due to access control checks.");
  }) as typeof fetch);
  try {
    await assert.rejects(api.settings(), (error: unknown) => {
      assert.equal(error instanceof ApiError, false);
      assert.equal((error as Error).name, "AbortError");
      return true;
    });
  } finally {
    restore();
  }
});

test("meeting autosave survives SPA navigation while reads still cancel", async () => {
  const calls: Array<{ signal: AbortSignal; resolve: (response: Response) => void }> = [];
  const restore = installFetch(((_input: unknown, init?: RequestInit) => new Promise((resolve, reject) => {
    const signal = init!.signal!;
    calls.push({ signal, resolve });
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  })) as typeof fetch);
  try {
    const saving = api.updateMeeting("meeting-1", { title: "Planning", notes: "Latest notes" });
    const reading = api.health();
    const cancelled = assert.rejects(reading, { name: "AbortError" });
    beginNavigation();
    assert.equal(calls[0]!.signal.aborted, false);
    assert.equal(calls[1]!.signal.aborted, true);
    calls[0]!.resolve(Response.json({ session: { title: "Planning", notes: "Latest notes" } }));
    assert.equal((await saving).session.notes, "Latest notes");
    await cancelled;
    const nextSave = api.updateMeeting("meeting-1", { title: "Planning", notes: "More notes" });
    const unloaded = assert.rejects(nextSave, { name: "AbortError" });
    abortAll();
    await unloaded;
  } finally { restore(); }
});
});
