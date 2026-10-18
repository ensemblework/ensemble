import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime.js";
import { AssistantDock, Message } from "./assistant-dock.js";
import { quotaFor } from "@/lib/model-quota";

// next/link schedules its prefetch with self.requestIdleCallback; mention chips in sent messages are links.
Object.defineProperty(globalThis, "self", { configurable: true, value: window });

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
    for (let attempt = 0; attempt < 20 && !document.body.querySelector("textarea"); attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    const textarea = document.body.querySelector("textarea");
    assert.ok(textarea, host.innerHTML);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    assert.ok(setter);
    await act(async () => {
      setter.call(textarea, "Hello from a new chat");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const send = [...document.body.querySelectorAll("button")].find((node) => node.getAttribute("aria-label") === "Send");
    assert.ok(send);
    await act(async () => {
      send.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    const stop = [...document.body.querySelectorAll("button")].find((node) => node.getAttribute("aria-label") === "Stop");
    assert.ok(stop, host.innerHTML);
    for (let i = 0; i < 20 && (document.body.textContent?.match(/Hello from a new chat/g) ?? []).length !== 2; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
    assert.equal(textarea.value, "");
    assert.equal((document.body.textContent?.match(/Hello from a new chat/g) ?? []).length, 2);
    const close = document.body.querySelector<HTMLButtonElement>('button[aria-label="Close"]');
    assert.ok(close);
    await act(async () => { close.click(); });
    const launcher = document.body.querySelector<HTMLButtonElement>('button[aria-label="Ask Ensemble"]');
    assert.ok(launcher);
    assert.equal(launcher.querySelector('.u-morph')?.getAttribute('data-state'), 'loop', 'minimized assistant keeps the real pending work visible');
    await act(async () => { launcher.click(); });
    const reopenedStop = document.body.querySelector<HTMLButtonElement>('button[aria-label="Stop"]');
    assert.ok(reopenedStop);
    await act(async () => {
      reopenedStop.click();
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    assert.equal(stops.length, 1);
    assert.equal(stops[0]?.includes(`/api/assistant/conversations/${CONVERSATION}/stop`), true);
    assert.equal(seen.turnSignal?.aborted, true);
    assert.match(document.body.textContent ?? "", /Stopped/);
    assert.equal((document.body.textContent ?? "").includes("What needs me today"), false);
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
    for (let attempt = 0; attempt < 20 && !document.body.querySelector("textarea"); attempt += 1) await wait();
    const textarea = document.body.querySelector("textarea")!;
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
  const button = (label: string) => [...document.body.querySelectorAll("button")].find((node) => node.getAttribute("aria-label") === label);
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
    for (let attempt = 0; attempt < 20 && !document.body.querySelector("textarea"); attempt += 1) await wait();
    const textarea = document.body.querySelector("textarea")!;
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
    for (let attempt = 0; attempt < 20 && !/Draft the launch note/.test(document.body.querySelector("[data-chat-history]")?.textContent ?? ""); attempt += 1) await wait();
    const panel = document.body.querySelector("[data-chat-history]")!;
    assert.match(panel.textContent ?? "", /Plan my day.*Draft the launch note/);
    assert.ok(asked.some((url) => url.includes("/api/assistant/conversations?chats=1")));
    const earlier = [...panel.querySelectorAll("button")].find((node) => /Draft the launch note/.test(node.textContent ?? ""))!;
    await act(async () => {
      earlier.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    for (let attempt = 0; attempt < 20 && !asked.some((url) => url.includes(`/conversations/${EARLIER}/messages`)); attempt += 1) await wait();
    assert.equal(document.body.querySelector("[data-chat-history]"), null, "the list closes");
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

test("the styled tier menu closes before the assistant on Escape", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input).includes("/api/settings") ? settings : {}), { headers: { "Content-Type": "application/json" } })) as typeof fetch;
  window.localStorage.setItem("ensemble.assistant.open", "true");
  window.localStorage.removeItem("ensemble.assistant.conversation");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  const host = document.createElement("div"), root = createRoot(host);
  document.body.appendChild(host);
  try {
    await act(async () => root.render(<PathnameContext.Provider value="/today"><QueryClientProvider client={client}><AssistantDock /></QueryClientProvider></PathnameContext.Provider>));
    await act(async () => new Promise(resolve => setTimeout(resolve, 50)));
    const trigger = document.body.querySelector<HTMLButtonElement>('[aria-label="Complexity"]')!;
    assert.ok(trigger); assert.equal(document.body.querySelector('select[aria-label="Complexity"]'), null);
    await act(async () => trigger.click());
    const list = document.querySelector('[role="listbox"][aria-label="Response complexity"]')!;
    assert.ok(list); assert.equal(list.querySelectorAll('[role="option"]').length, 4);
    await act(async () => list.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    assert.ok(document.body.querySelector("textarea"), "first Escape keeps the assistant");
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    assert.equal(JSON.parse(window.localStorage.getItem("ensemble.assistant.open")!), false);
  } finally {
    await act(async () => root.unmount()); host.remove(); client.clear(); globalThis.fetch = original;
    window.localStorage.removeItem("ensemble.assistant.open"); window.localStorage.removeItem("ensemble.assistant.conversation");
  }
});

test("an included refusal shows its sentence as the turn error, is not stored or marked out of quota, and refreshes credits", async () => {
  if (typeof Element !== "undefined" && typeof Element.prototype.scrollTo !== "function") {
    Element.prototype.scrollTo = () => undefined;
  }
  window.localStorage.setItem("ensemble.assistant.open", "true");
  window.localStorage.removeItem("ensemble.assistant.conversation");
  const PAUSED = "Ensemble's included AI is paused for everyone until Nov 1: this month's shared budget is used up, even for accounts with credits left. Your own API keys and AI plans still work (Settings → Models).";
  const USED = "You've used this month's Ensemble credits. They reset on Nov 1. To keep going now, add your own API key or AI plan in Settings → Models.";
  const included = {
    settings: {
      ...settings.settings,
      models: { ...settings.settings.models, medium: { provider: "ensemble", model: "grok-4.7", effort: "default" } },
    },
  };
  let turns = 0;
  let modelLists = 0;
  const original = globalThis.fetch;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/settings")) return json(included);
    if (url.includes("/api/models")) {
      modelLists += 1;
      return json({ providers: [], runtime: true, updatedAt: "2026-10-17T00:00:00.000Z" });
    }
    if (url.includes("/messages")) {
      return json({ messages: [{ id: "saved-user", role: "user", content: "Plan my day", toolCalls: [], model: null, createdAt: "2026-10-17T09:00:00.000Z" }] });
    }
    if (url.includes("/api/assistant/turn")) {
      turns += 1;
      if (turns === 2) {
        return json({ code: "included_credits_used", error: USED, message: USED, resetsAt: "2026-11-01T00:00:00.000Z", status: 429 }, 429);
      }
      const frames = [
        `event: status\ndata: ${JSON.stringify({ conversationId: CONVERSATION, userMessageId: "saved-user" })}\n\n`,
        `event: error\ndata: ${JSON.stringify({ code: "included_paused", error: PAUSED, message: PAUSED, model: "grok-4.7", resetsAt: "2026-11-01T00:00:00.000Z", status: 429 })}\n\n`,
        `event: done\ndata: ${JSON.stringify({ conversationId: CONVERSATION })}\n\n`,
      ];
      return new Response(frames.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return json({});
  }) as typeof fetch;

  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  const wait = (ms = 20) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
  const alertText = () => document.body.querySelector('[role="alert"]')?.textContent ?? "";
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
    for (let attempt = 0; attempt < 20 && !/Grok 4\.7/.test(document.body.querySelector('[aria-label="Complexity"]')?.textContent ?? ""); attempt += 1) await wait();
    assert.equal(document.body.querySelector('[aria-label="Complexity"]')?.textContent, "Medium · Grok 4.7", "the tier menu names the included model");
    await act(async () => document.body.querySelector<HTMLButtonElement>('[aria-label="Complexity"]')!.click());
    const medium = [...document.querySelectorAll('[aria-label="Response complexity"] [role="option"]')].find((node) => /^Medium/.test(node.textContent ?? ""))!;
    assert.match(medium.textContent ?? "", /Included with Ensemble · Grok 4\.7/);
    await act(async () => medium.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));

    client.setQueryData(["included-usage"], { available: true, remaining: 10 });
    client.setQueryData(["models"], { providers: [], runtime: true, updatedAt: "2026-10-17T00:00:00.000Z" });
    const textarea = document.body.querySelector("textarea")!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    const send = async (text: string) => {
      await act(async () => {
        setter.call(textarea, text);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        document.body.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    };

    const listsBefore = modelLists;
    await send("Plan my day");
    for (let attempt = 0; attempt < 30 && !alertText().includes("paused for everyone"); attempt += 1) await wait();
    assert.match(alertText(), /Ensemble's included AI is paused for everyone until Nov 1/);
    for (let attempt = 0; attempt < 30 && !/Plan my day/.test(document.body.querySelector(".assistant-conversation")?.textContent ?? ""); attempt += 1) await wait();
    assert.equal((document.body.textContent?.match(/paused for everyone/g) ?? []).length, 1, "shown once, as the turn error, not as a saved reply");
    assert.equal(document.body.querySelectorAll(".assistant-answer-turn").length, 0, "no assistant message holds it");
    assert.equal(client.getQueryState(["included-usage"])?.isInvalidated, true, "credits are fetched again");
    for (let attempt = 0; attempt < 30 && modelLists === listsBefore; attempt += 1) await wait();
    assert.ok(modelLists > listsBefore, "the model list is fetched again");
    assert.equal(quotaFor("grok-4.7"), null, "the model is not marked out of quota");

    client.setQueryData(["included-usage"], { available: true, remaining: 0 });
    await send("And tomorrow?");
    for (let attempt = 0; attempt < 30 && !alertText().includes("used this month"); attempt += 1) await wait();
    assert.match(alertText(), /You've used this month's Ensemble credits\. They reset on Nov 1\./, "the sentence, not the JSON body");
    assert.doesNotMatch(alertText(), /included_credits_used/);
    assert.equal(textarea.value, "And tomorrow?", "the message stays in the box to send again");
    assert.equal(client.getQueryState(["included-usage"])?.isInvalidated, true);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = original;
    client.clear();
    window.localStorage.removeItem("ensemble.assistant.open");
    window.localStorage.removeItem("ensemble.assistant.conversation");
  }
});

test("the model menu offers the included models: a pick is sent with the turn on Auto, and a tier takes over again", async () => {
  window.localStorage.setItem("ensemble.assistant.open", "true");
  window.localStorage.removeItem("ensemble.assistant.conversation");
  const bodies: Array<Record<string, unknown>> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("/api/settings")) return json(settings);
    if (url.includes("/api/models")) {
      return json({ runtime: true, providers: [{ provider: "ensemble", available: true, source: "included", models: ["gpt-5-mini", "gpt-4.1-mini"], meta: {}, chat: true, cheapest: "gpt-5-mini", error: null }] });
    }
    if (url.includes("/api/metrics/credits")) {
      return json({ available: true, models: [], period: "2026-10", resetsAt: "2026-11-01T00:00:00.000Z", limit: 20000, used: 1000, remaining: 19000, paused: false, totals: {}, byModel: [], byPurpose: [], days: [] });
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
  const menu = async () => {
    await act(async () => document.body.querySelector<HTMLButtonElement>('[aria-label="Complexity"]')!.click());
    return document.querySelector('[role="listbox"][aria-label="Response complexity"]')!;
  };
  const send = async (text: string) => {
    const textarea = document.body.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, text);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    const before = bodies.length;
    for (let attempt = 0; attempt < 20 && bodies.length === before; attempt += 1) await wait();
  };
  try {
    await act(async () => root.render(<PathnameContext.Provider value="/today"><QueryClientProvider client={client}><AssistantDock /></QueryClientProvider></PathnameContext.Provider>));
    for (let attempt = 0; attempt < 20 && !document.body.querySelector("textarea"); attempt += 1) await wait();
    let list = await menu();
    // The menu is portalled to the page: it must stack above the assistant window, or it opens unseen behind it.
    const dock = document.querySelector<HTMLElement>("[data-assistant-surface]")!;
    const panel = list.closest<HTMLElement>("[data-popover]")!;
    assert.ok(Number(panel.style.zIndex) > Number(dock.style.zIndex), `menu z ${panel.style.zIndex} is above the assistant's ${dock.style.zIndex}`);
    for (let attempt = 0; attempt < 20 && !list.querySelector('[role="group"]'); attempt += 1) { await wait(); list = document.querySelector('[role="listbox"][aria-label="Response complexity"]')!; }
    let group = list.querySelector('[role="group"]')!;
    for (let attempt = 0; attempt < 20 && !/credits left/.test(group.textContent ?? ""); attempt += 1) { await wait(); group = document.querySelector('[role="listbox"] [role="group"]')!; }
    assert.match(group.textContent ?? "", /Included with Ensemble · 19,000 credits left/);
    const options = [...group.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    assert.deepEqual(options.map((option) => option.textContent), ["GPT-5 mini (2025-08-07)", "GPT-4.1 mini (2025-04-14)"]);
    await act(async () => options[0]!.click());
    assert.match(document.body.querySelector('[aria-label="Complexity"]')?.textContent ?? "", /GPT-5 mini \(2025-08-07\) · Included/);
    await send("Hello");
    assert.deepEqual({ model: bodies[0]!.model, provider: bodies[0]!.provider, reasoningEffort: bodies[0]!.reasoningEffort, tier: bodies[0]!.tier }, { model: "gpt-5-mini", provider: "ensemble", reasoningEffort: "default", tier: undefined });
    list = await menu();
    await act(async () => [...list.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((option) => option.textContent?.startsWith("High"))!.click());
    await send("Again");
    assert.equal(bodies[1]!.tier, "high");
    assert.equal(bodies[1]!.model, undefined, "a tier sends no model of its own");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = original;
    client.clear();
    window.localStorage.removeItem("ensemble.assistant.open");
  }
});

test("a sent message shows its saved mentions as chips and its addresses as links; an older message without saved mentions guesses none", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  const content = "@task:Clone a repo do this on my machine, see https://app.notion.com/p/Plan-2f3c?pvs=204.";
  try {
    await act(async () => {
      root.render(<Message conversationId={null} message={{ id: "u1", role: "user", content, mentions: [{ kind: "task", id: "task-1", label: "Clone a repo" }], toolCalls: [], model: null, createdAt: "2026-10-18T09:00:00.000Z" }} />);
    });
    const bubble = host.querySelector(".assistant-user-message")!;
    const chip = bubble.querySelector<HTMLAnchorElement>("a.mention");
    assert.ok(chip, bubble.innerHTML);
    assert.equal(chip.dataset.kind, "task");
    assert.equal(chip.getAttribute("href"), "/tasks/task-1");
    assert.equal(chip.textContent, "@Clone a repo");
    assert.equal(chip.getAttribute("target"), null, "a mention opens in the app");
    assert.match(bubble.textContent ?? "", /^@Clone a repo do this on my machine, see /);
    const link = bubble.querySelector<HTMLAnchorElement>("a:not(.mention)")!;
    assert.equal(link.getAttribute("href"), "https://app.notion.com/p/Plan-2f3c?pvs=204");
    assert.equal(link.getAttribute("target"), "_blank");
    assert.equal(link.getAttribute("rel"), "noopener noreferrer");
    assert.ok(bubble.textContent?.endsWith("pvs=204."));

    await act(async () => {
      root.render(<Message conversationId={null} message={{ id: "u0", role: "user", content, toolCalls: [], model: null, createdAt: "2026-10-01T09:00:00.000Z" }} />);
    });
    const old = host.querySelector(".assistant-user-message")!;
    assert.equal(old.querySelector(".mention"), null, "no saved mentions: the label's end is unknown, so no chip");
    assert.ok(old.querySelector('a[href^="https://app.notion.com"]'), "its links still work");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
