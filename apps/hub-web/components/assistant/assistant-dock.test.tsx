import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime.js";
import { AssistantDock } from "./assistant-dock.js";

const CONVERSATION = "11111111-1111-4111-8111-111111111111";

const settings = {
  settings: {
    assistant: { defaultTier: "medium", writePolicy: "preview" },
    models: {
      easy: { model: "gemini-3.5-flash-lite" },
      medium: { model: "gemini-3.5-flash-lite" },
      high: { model: "gemini-3.5-flash" },
      max: { model: "gemini-3.5-flash" },
    },
  },
};

test("streaming reconciles the saved user message by id, keeps real repeats, and Stop cancels the turn", async () => {
  if (typeof Element !== "undefined" && typeof Element.prototype.scrollTo !== "function") {
    Element.prototype.scrollTo = () => undefined;
  }
  if (typeof window.matchMedia !== "function") {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() {
        return false;
      },
    })) as typeof window.matchMedia;
  }
  window.localStorage.setItem("ensemble.assistant.open", "true");
  window.localStorage.removeItem("ensemble.assistant.conversation");

  const seen: { turnSignal: AbortSignal | null } = { turnSignal: null };
  const stops: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/settings")) {
      return new Response(JSON.stringify(settings), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/api/entities")) {
      return new Response(JSON.stringify({ entities: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/api/assistant/turn")) {
      seen.turnSignal = init?.signal ?? null;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(`event: status\ndata: ${JSON.stringify({ conversationId: CONVERSATION, userMessageId: "saved-user" })}\n\n`),
          );
          const abort = () => {
            try {
              controller.error(new DOMException("The operation was aborted.", "AbortError"));
            } catch {
              // already closed
            }
          };
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener("abort", abort, { once: true });
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (url.includes("/stop")) {
      stops.push(url);
      return new Response(null, { status: 204 });
    }
    if (url.includes("/messages")) {
      return new Response(
        JSON.stringify({
          messages: [
            { id: "earlier-user", role: "user", content: "Hello from a new chat", toolCalls: [], model: null, createdAt: "2026-10-04T20:29:00.000Z" },
            { id: "saved-user", role: "user", content: "Hello from a new chat", toolCalls: [], model: null, createdAt: "2026-10-04T20:30:00.000Z" },
            {
              id: "saved-stop",
              role: "assistant",
              content: "Stopped before finishing.",
              toolCalls: [],
              model: null,
              createdAt: "2026-10-04T20:30:00.000Z",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 } },
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  try {
    await act(async () => {
      root.render(
        <PathnameContext.Provider value="/today">
          <QueryClientProvider client={client}>
            <AssistantDock />
          </QueryClientProvider>
        </PathnameContext.Provider>,
      );
    });
    for (let attempt = 0; attempt < 20 && !host.querySelector("textarea"); attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    const textarea = host.querySelector("textarea");
    assert.ok(textarea, host.innerHTML);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    assert.ok(setter);
    await act(async () => {
      setter.call(textarea, "Hello from a new chat");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const send = [...host.querySelectorAll("button")].find((node) => node.getAttribute("aria-label") === "Send");
    assert.ok(send);
    await act(async () => {
      send.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    const stop = [...host.querySelectorAll("button")].find((node) => node.getAttribute("aria-label") === "Stop");
    assert.ok(stop, host.innerHTML);
    for (let i = 0; i < 20 && (host.textContent?.match(/Hello from a new chat/g) ?? []).length !== 2; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
    assert.equal(textarea.value, "");
    assert.equal((host.textContent?.match(/Hello from a new chat/g) ?? []).length, 2);
    await act(async () => {
      stop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    assert.equal(stops.length, 1);
    assert.equal(stops[0]?.includes(`/api/assistant/conversations/${CONVERSATION}/stop`), true);
    assert.equal(seen.turnSignal?.aborted, true);
    assert.match(host.textContent ?? "", /Stopped/);
    assert.equal((host.textContent ?? "").includes("What needs me today"), false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = original;
    client.clear();
    window.localStorage.removeItem("ensemble.assistant.open");
    window.localStorage.removeItem("ensemble.assistant.conversation");
  }
});

test("@ in the box ranks across kinds, Enter writes @people:Name, and Send passes the picked ids with the turn", async () => {
  window.localStorage.setItem("ensemble.assistant.open", "true");
  window.localStorage.removeItem("ensemble.assistant.conversation");
  const bodies: Array<{ message: string; mentions?: unknown }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("/api/settings")) return json(settings);
    if (url.includes("/api/shell")) return json({ modules: "diagrams,plots" });
    if (url.includes("/api/entities")) {
      return json({
        entities: [
          { kind: "people", id: "p-support", label: "support", detail: "support@shop.example" },
          { kind: "people", id: "p-anika", label: "Anika Rao", detail: "anika@fieldnote.example" },
          { kind: "diagram", id: "diagram-1", label: "Transformer", detail: "" },
        ],
      });
    }
    if (url.includes("/api/assistant/turn")) {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(`event: done\ndata: ${JSON.stringify({ conversationId: CONVERSATION, content: "Done." })}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (url.includes("/messages")) return json({ messages: [] });
    return json({});
  }) as typeof fetch;

  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  const wait = async (ms = 20) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
  try {
    await act(async () => {
      root.render(
        <PathnameContext.Provider value="/today">
          <QueryClientProvider client={client}>
            <AssistantDock />
          </QueryClientProvider>
        </PathnameContext.Provider>,
      );
    });
    for (let attempt = 0; attempt < 20 && !host.querySelector("textarea"); attempt += 1) await wait();
    const textarea = host.querySelector("textarea")!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    const type = async (text: string) => {
      await act(async () => {
        textarea.focus();
        setter.call(textarea, text);
        textarea.setSelectionRange(text.length, text.length);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await wait();
    };
    const key = async (name: string) => {
      await act(async () => {
        textarea.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
      });
      await wait();
    };
    await type("Ask @anik");
    for (let attempt = 0; attempt < 20 && !document.querySelector("[role=option]"); attempt += 1) await type("Ask @anik");
    assert.match(document.querySelector("[role=option]")?.textContent ?? "", /Anika Rao.*Person/);
    await key("Enter");
    assert.equal(textarea.value, "Ask @people:Anika Rao ");
    assert.equal(bodies.length, 0);
    // Typed by hand: no id here; the server resolves the token.
    await type("Ask @people:Anika Rao about @diagram:Transformer today");
    assert.equal(document.querySelector("[role=option]"), null);
    await key("Enter");
    for (let attempt = 0; attempt < 20 && !bodies.length; attempt += 1) await wait();
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0]!.message, "Ask @people:Anika Rao about @diagram:Transformer today");
    assert.deepEqual(bodies[0]!.mentions, [{ kind: "people", id: "p-anika", label: "Anika Rao" }]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = original;
    client.clear();
    window.localStorage.removeItem("ensemble.assistant.open");
    window.localStorage.removeItem("ensemble.assistant.conversation");
  }
});
