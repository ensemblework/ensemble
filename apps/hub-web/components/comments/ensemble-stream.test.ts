import "../ui-test-dom";
import assert from "node:assert/strict";
import test from "node:test";
import { abortEnsemble, streamEnsemble } from "./ensemble-view";
import { beginPageEnsemble, isPageEnsembleBusy, readEnsemble } from "./ensemble-bus";

function frame(event: string, data: unknown) { return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; }
test("page request tracking stays busy until every request releases", () => {
  const first = beginPageEnsemble("page", "busy-page");
  const second = beginPageEnsemble("page", "busy-page");
  assert.equal(isPageEnsembleBusy("page", "busy-page"), true);
  assert.equal(isPageEnsembleBusy("task", "busy-page"), false);
  first();
  first();
  assert.equal(isPageEnsembleBusy("page", "busy-page"), true);
  second();
  assert.equal(isPageEnsembleBusy("page", "busy-page"), false);
});

test("Stop follows the adopted server id during a pending stream", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => new Response(new ReadableStream({
    start(controller) {
      init?.signal?.addEventListener("abort", () => controller.error(new DOMException("Stopped", "AbortError")), { once: true });
      controller.enqueue(new TextEncoder().encode(frame("status", { text: "Thinking…", id: "stop-server" })));
    },
  }));
  try {
    await streamEnsemble({ pageKind: "page", pageId: "stop-page", prompt: "Summarize", threadId: "stop-local", onServerId: abortEnsemble });
    assert.equal(readEnsemble("stop-server")?.error, "Stopped.");
    assert.equal(isPageEnsembleBusy("page", "stop-page"), false);
  } finally { globalThis.fetch = original; }
});
test("inline streams preserve artifact calls, live document context, and the final server id", async () => {
  const original = globalThis.fetch;
  let payload: Record<string, unknown> = {};
  const call = { id: "plot-call", name: "hub_create_plot", state: "ok", isWrite: true, input: { title: "Accuracy" }, href: "/plots/11111111-1111-4111-8111-111111111111" };
  globalThis.fetch = async (_url, init) => {
    payload = JSON.parse(String(init?.body));
    return new Response(frame("status", { text: "Thinking…", id: "server-thread", conversationId: "conversation" }) + frame("tool", { call }) + frame("delta", { text: "Created." }) + frame("done", { id: "server-thread", content: "Created.", toolCalls: [call], conversationId: "conversation" }));
  };
  try {
    let serverId = "";
    const content = { type: "doc" as const, content: [{ type: "paragraph", content: [{ type: "text", text: "Newest content" }] }] };
    const mentions = [{ kind: "dataset" as const, id: "file-id", label: "epochs.csv" }];
    await streamEnsemble({ pageKind: "page", pageId: "page-id", prompt: "Plot epochs", threadId: "local-thread", content, mentions, onServerId: (id) => { serverId = id; } });
    assert.equal(serverId, "server-thread");
    assert.deepEqual(payload.content, content);
    assert.deepEqual(payload.mentions, mentions);
    assert.equal(readEnsemble("server-thread")?.toolCalls?.[0]?.href, call.href);
    assert.equal(readEnsemble("server-thread")?.conversationId, "conversation");
  } finally { globalThis.fetch = original; }
});
test("a dropped stream keeps the server anchor and partial output instead of pretending completion", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(frame("status", { text: "Thinking…", id: "partial-server" }) + frame("delta", { text: "Partial answer" }));
  try {
    let anchor = "";
    await streamEnsemble({ pageKind: "page", pageId: "page-id", prompt: "Summarize", threadId: "partial-local", onServerId: (id) => { anchor = id; } });
    assert.equal(anchor, "partial-server");
    assert.equal(readEnsemble(anchor)?.text, "Partial answer");
    assert.equal(readEnsemble(anchor)?.status, "error");
    assert.match(readEnsemble(anchor)?.error ?? "", /ended before it finished/);
  } finally { globalThis.fetch = original; }
});
test("an SSE error followed by done never becomes a success-shaped reply", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(frame("error", { message: "The model failed." }) + frame("done", { id: "failed-server", content: "The model failed." }));
  try {
    await streamEnsemble({ pageKind: "page", pageId: "page-id", prompt: "Summarize", threadId: "failed-local" });
    assert.equal(readEnsemble("failed-server")?.status, "error");
    assert.equal(readEnsemble("failed-server")?.error, "The model failed.");
  } finally { globalThis.fetch = original; }
});
