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
    const close = host.querySelector<HTMLButtonElement>('button[aria-label="Close"]');
    assert.ok(close);
    await act(async () => { close.click(); });
    const launcher = host.querySelector<HTMLButtonElement>('button[aria-label="Ask Ensemble"]');
    assert.ok(launcher);
    assert.equal(launcher.querySelector('.u-morph')?.getAttribute('data-state'), 'loop', 'minimized assistant keeps the real pending work visible');
    await act(async () => { launcher.click(); });
    const reopenedStop = host.querySelector<HTMLButtonElement>('button[aria-label="Stop"]');
    assert.ok(reopenedStop);
    await act(async () => {
      reopenedStop.click();
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

test("the box grows to eight lines, Recent chats opens an earlier chat, and a change the assistant makes refreshes the board", async () => {
  if (typeof Element !== "undefined" && typeof Element.prototype.scrollTo !== "function") {
    Element.prototype.scrollTo = () => undefined;
  }
  window.localStorage.setItem("ensemble.assistant.open", "true");
  window.localStorage.removeItem("ensemble.assistant.conversation");
  const EARLIER = "22222222-2222-4222-8222-222222222222";
  const asked: string[] = [];
  const original = globalThis.fetch;
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    if (url.includes("/api/settings")) return json(settings);
    if (url.includes("/api/assistant/conversations?chats=1")) {
      return json({
        conversations: [
          { id: CONVERSATION, title: "Plan my day", updatedAt: new Date().toISOString(), createdAt: new Date().toISOString() },
          { id: EARLIER, title: "Draft the launch note", updatedAt: new Date(Date.now() - 86_400_000).toISOString(), createdAt: new Date().toISOString() },
        ],
      });
    }
    if (url.includes(`/conversations/${EARLIER}/messages`)) {
      return json({ messages: [{ id: "old-user", role: "user", content: "Draft the launch note", toolCalls: [], model: null, createdAt: "2026-10-12T09:00:00.000Z" }] });
    }
    if (url.includes("/messages")) return json({ messages: [] });
    if (url.includes("/api/assistant/turn")) {
      const frames = [
        `event: status\ndata: ${JSON.stringify({ conversationId: CONVERSATION })}\n\n`,
        `event: tool\ndata: ${JSON.stringify({ call: { id: "call-1", name: "hub_create_task", state: "ok", isWrite: true, summary: "Created “Buy milk”." } })}\n\n`,
        `event: done\ndata: ${JSON.stringify({ conversationId: CONVERSATION })}\n\n`,
      ];
      return new Response(new ReadableStream({ start(controller) { for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame)); controller.close(); } }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return json({});
  }) as typeof fetch;

  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  client.setQueryData(["tasks"], { tasks: [] });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  const wait = (ms = 20) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
  const button = (label: string) => [...host.querySelectorAll("button")].find((node) => node.getAttribute("aria-label") === label);
  try {
    await act(async () => {
      root.render(
        <PathnameContext.Provider value="/board">
          <QueryClientProvider client={client}>
            <AssistantDock />
          </QueryClientProvider>
        </PathnameContext.Provider>,
      );
    });
    for (let attempt = 0; attempt < 20 && !host.querySelector("textarea"); attempt += 1) await wait();
    const textarea = host.querySelector("textarea")!;
    let lines = 1;
    Object.defineProperty(textarea, "scrollHeight", { configurable: true, get: () => lines * 24 });
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    const type = async (value: string) => {
      lines = value.split("\n").length;
      await act(async () => {
        setter.call(textarea, value);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    await type("First line\nSecond line\nThird line");
    assert.equal(textarea.style.height, "72px", "every line typed so far stays in view");
    assert.equal(textarea.style.overflowY, "hidden");
    await type(Array.from({ length: 12 }, (_, index) => `Line ${index + 1}`).join("\n"));
    assert.equal(textarea.style.height, "192px", "eight lines, then it scrolls");
    assert.equal(textarea.style.overflowY, "auto");

    await type("Add a todo to buy milk");
    await act(async () => {
      button("Send")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    for (let attempt = 0; attempt < 20 && !client.getQueryState(["tasks"])?.isInvalidated; attempt += 1) await wait(40);
    assert.equal(client.getQueryState(["tasks"])?.isInvalidated, true, "the board's tasks are refetched without the live stream");

    const toggle = button("Recent chats")!;
    for (let attempt = 0; attempt < 20 && toggle.disabled; attempt += 1) await wait();
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    for (let attempt = 0; attempt < 20 && !/Draft the launch note/.test(host.querySelector("[data-chat-history]")?.textContent ?? ""); attempt += 1) await wait();
    const panel = host.querySelector("[data-chat-history]")!;
    assert.match(panel.textContent ?? "", /Plan my day.*Draft the launch note/);
    assert.ok(asked.some((url) => url.includes("/api/assistant/conversations?chats=1")));
    const earlier = [...panel.querySelectorAll("button")].find((node) => /Draft the launch note/.test(node.textContent ?? ""))!;
    await act(async () => {
      earlier.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    for (let attempt = 0; attempt < 20 && !asked.some((url) => url.includes(`/conversations/${EARLIER}/messages`)); attempt += 1) await wait();
    assert.equal(host.querySelector("[data-chat-history]"), null, "the list closes");
    assert.equal(JSON.parse(window.localStorage.getItem("ensemble.assistant.conversation") ?? "null"), EARLIER);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = original;
    client.clear();
    window.localStorage.removeItem("ensemble.assistant.open");
    window.localStorage.removeItem("ensemble.assistant.conversation");
  }
});
