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

/** Stands in for the browser's XMLHttpRequest, which filesApi.upload uses for progress. Each upload waits for the test. */
class FakeUpload {
  static made: FakeUpload[] = [];
  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  responseText = "";
  withCredentials = false;
  url = "";
  body = "";
  aborted = false;
  constructor() {
    FakeUpload.made.push(this);
  }
  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader() {}
  send(body: string) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  progress(fraction: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded: fraction * 100, total: 100 });
  }
  respond(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
  get filename(): string {
    return (JSON.parse(this.body || "{}") as { filename?: string }).filename ?? "";
  }
}

async function attachmentDock(handle: (url: string, init?: RequestInit) => Response | null) {
  if (typeof Element !== "undefined" && typeof Element.prototype.scrollTo !== "function") Element.prototype.scrollTo = () => undefined;
  window.localStorage.setItem("ensemble.assistant.open", "true");
  window.localStorage.removeItem("ensemble.assistant.conversation");
  FakeUpload.made = [];
  const hadXhr = "XMLHttpRequest" in globalThis;
  const realXhr = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
  Object.defineProperty(globalThis, "XMLHttpRequest", { configurable: true, writable: true, value: FakeUpload });
  const original = globalThis.fetch;
  const requests: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? "GET" });
    const handled = handle(url, init);
    if (handled) return handled;
    if (url.includes("/api/settings")) return new Response(JSON.stringify(settings), { headers: { "content-type": "application/json" } });
    if (url.includes("/messages")) return new Response(JSON.stringify({ messages: [] }), { headers: { "content-type": "application/json" } });
    return new Response("{}", { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  const wait = (ms = 15) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
  const until = async (check: () => unknown, label: string) => {
    for (let attempt = 0; attempt < 60 && !check(); attempt += 1) await wait();
    assert.ok(check(), label);
  };
  await act(async () => root.render(<PathnameContext.Provider value="/today"><QueryClientProvider client={client}><AssistantDock /></QueryClientProvider></PathnameContext.Provider>));
  await until(() => document.body.querySelector("textarea"), "the box is there");
  const chips = () => [...document.body.querySelectorAll<HTMLElement>(".assistant-attachment")];
  const chip = (name: string) => chips().find((node) => node.querySelector(".truncate")?.textContent === name);
  const button = (label: string) => document.body.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  const pick = async (files: File[]) => {
    const input = document.body.querySelector<HTMLInputElement>("input[data-attach-input]")!;
    Object.defineProperty(input, "files", { configurable: true, value: files });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  };
  const type = async (text: string) => {
    const textarea = document.body.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, text);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const notice = () => document.body.querySelector("[data-attachment-notice]")?.textContent ?? "";
  const cleanup = async () => {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = original;
    client.clear();
    if (hadXhr) Object.defineProperty(globalThis, "XMLHttpRequest", { configurable: true, writable: true, value: realXhr });
    else delete (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
    window.localStorage.removeItem("ensemble.assistant.open");
    window.localStorage.removeItem("ensemble.assistant.conversation");
  };
  return { requests, wait, until, chips, chip, button, pick, type, notice, cleanup };
}

const savedFile = (id: string, filename: string, more: Record<string, unknown> = {}) => ({ id, filename, byteSize: 2048, kind: "pdf", createdAt: "2026-10-20T09:00:00.000Z", ...more });

test("attached files upload with progress, Cancel stops one, Send waits for uploads, a failed send puts them back, and a files-only message carries them", async () => {
  const turns: Array<{ message: string; mentions?: unknown }> = [];
  let failures = 2;
  const created: string[] = [];
  const revoked: string[] = [];
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (blob: Blob) => {
    const url = realCreate(blob);
    created.push(url);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url);
    realRevoke(url);
  };
  const dock = await attachmentDock((url, init) => {
    if (url.includes("/messages") && turns.length === 3) {
      // The chat as the server keeps it: the files are on the message's mentions.
      return new Response(JSON.stringify({ messages: [{ id: "saved-user", role: "user", content: turns[2]!.message, mentions: turns[2]!.mentions, toolCalls: [], model: null, createdAt: "2026-10-25T09:00:00.000Z" }] }), { headers: { "content-type": "application/json" } });
    }
    if (!url.includes("/api/assistant/turn")) return null;
    turns.push(JSON.parse(String(init?.body)));
    if (failures > 0) {
      failures -= 1;
      return new Response(JSON.stringify({ error: "The assistant is down." }), { status: 500, headers: { "content-type": "application/json" } });
    }
    return new Response(`event: done\ndata: ${JSON.stringify({ conversationId: CONVERSATION, content: "Done." })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  });
  try {
    const { chip, button, until } = dock;
    const upload = button("Upload from this computer");
    assert.equal(upload, null, "the choices are behind the paperclip");
    await act(async () => button("Attach files")!.click());
    const input = document.body.querySelector<HTMLInputElement>("input[data-attach-input]")!;
    let opened = 0;
    input.click = () => { opened += 1; };
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((node) => /Upload from this computer/.test(node.textContent ?? ""))!.click());
    assert.equal(opened, 1, "Upload from this computer opens the file chooser");

    await dock.pick([new File([new Uint8Array([137, 80, 78, 71])], "chart.png", { type: "image/png" }), new File(["%PDF-1.7"], "notes.pdf", { type: "application/pdf" })]);
    await until(() => FakeUpload.made.length === 2, "both files start uploading");
    const [picture, pdf] = FakeUpload.made.sort((a, b) => a.filename.localeCompare(b.filename));
    assert.equal(picture!.withCredentials, true);
    assert.equal(JSON.parse(pdf!.body).summarize, false, "chat attachments skip the AI summary");
    const thumb = chip("chart.png")!.querySelector("img")!;
    assert.ok(thumb.getAttribute("src")?.startsWith("blob:"), "a picture shows itself while it uploads");
    const send = button("Send")!;
    assert.equal(send.disabled, true, "Send waits for uploads");
    assert.match(document.getElementById(send.getAttribute("aria-describedby")!)?.textContent ?? "", /Uploading 2 files\. You can send when they finish\./);

    await act(async () => picture!.progress(0.5));
    assert.match(chip("chart.png")!.textContent ?? "", /Uploading 50%/);
    assert.equal(chip("chart.png")!.querySelector('[role="progressbar"]')!.getAttribute("aria-valuenow"), "50");
    await act(async () => button("Cancel uploading chart.png")!.click());
    assert.equal(picture!.aborted, true, "Cancel stops the request");
    assert.equal(chip("chart.png"), undefined);
    assert.ok(revoked.includes(thumb.getAttribute("src")!), "its picture is released");
    assert.match(document.body.querySelector('[role="status"][aria-live="polite"]')?.textContent ?? "", /Upload of chart\.png cancelled/);

    await act(async () => pdf!.respond(201, { file: savedFile("doc-notes", "notes.pdf") }));
    await until(() => chip("notes.pdf")?.dataset.state === "ready", "the upload lands");
    assert.equal(button("Send")!.disabled, false, "a files-only message can be sent");
    assert.ok(button("Remove notes.pdf from this message"));

    await dock.type("Compare these");
    await act(async () => button("Send")!.click());
    await until(() => document.body.querySelector('[role="alert"]'), "the failed send says so");
    assert.equal(turns.length, 1);
    assert.deepEqual(turns[0]!.mentions, [{ kind: "file", id: "doc-notes", label: "notes.pdf" }]);
    assert.equal(document.body.querySelector("textarea")!.value, "Compare these", "the text comes back");
    assert.equal(chip("notes.pdf")?.dataset.state, "ready", "and so do the files");

    const retry = [...document.body.querySelectorAll<HTMLButtonElement>('[role="alert"] button')].find((node) => node.textContent === "Retry")!;
    await act(async () => retry.click());
    await until(() => turns.length === 2, "Retry sends the turn again");
    assert.deepEqual({ message: turns[1]!.message, mentions: turns[1]!.mentions }, { message: "Compare these", mentions: [{ kind: "file", id: "doc-notes", label: "notes.pdf" }] });
    await until(() => chip("notes.pdf"), "after a second failure the file is back once");
    assert.equal(dock.chips().length, 1);

    await dock.type("");
    await act(async () => button("Send")!.click());
    await until(() => turns.length === 3, "the files-only message is sent");
    assert.equal(turns[2]!.message, "Take a look at the attached file.");
    assert.deepEqual(turns[2]!.mentions, [{ kind: "file", id: "doc-notes", label: "notes.pdf" }]);
    assert.equal(dock.chips().length, 0, "the shelf empties with the box");
    await until(() => dock.requests.some((request) => request.url.includes(`/conversations/${CONVERSATION}/messages`)), "the chat reloads");
    await dock.wait(30);
    const sent = document.body.querySelector<HTMLAnchorElement>('.assistant-user-turn .assistant-message-files a[href="/files/doc-notes"]');
    assert.ok(sent, "the reloaded message lists its file with a link to it in Files");
    assert.match(sent.textContent ?? "", /notes\.pdf/);
    assert.doesNotMatch(document.body.querySelector(".assistant-conversation")?.textContent ?? "", /\b(read|saw|seen)\b/i);
  } finally {
    await dock.cleanup();
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
  }
});

test("Retry after a failed send leaves out a file removed from the shelf meanwhile", async () => {
  const turns: Array<{ message: string; mentions?: unknown }> = [];
  const dock = await attachmentDock((url, init) => {
    if (!url.includes("/api/assistant/turn")) return null;
    turns.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ error: "The assistant is down." }), { status: 500, headers: { "content-type": "application/json" } });
  });
  try {
    const { chip, button, until } = dock;
    await dock.pick([new File(["%PDF-1.7"], "notes.pdf", { type: "application/pdf" }), new File(["a,b"], "data.csv", { type: "text/csv" })]);
    await until(() => FakeUpload.made.length === 2, "both files start uploading");
    for (const upload of FakeUpload.made) await act(async () => upload.respond(201, { file: savedFile(upload.filename === "notes.pdf" ? "doc-notes" : "doc-data", upload.filename) }));
    await until(() => chip("notes.pdf")?.dataset.state === "ready" && chip("data.csv")?.dataset.state === "ready", "the uploads land");
    await dock.type("Compare these");
    await act(async () => button("Send")!.click());
    await until(() => document.body.querySelector('[role="alert"]'), "the failed send says so");
    assert.equal(dock.chips().length, 2, "the files come back");
    await act(async () => button("Remove data.csv from this message")!.click());
    const retry = [...document.body.querySelectorAll<HTMLButtonElement>('[role="alert"] button')].find((node) => node.textContent === "Retry")!;
    await act(async () => retry.click());
    await until(() => turns.length === 2, "Retry sends the turn again");
    assert.deepEqual(turns[1]!.mentions, [{ kind: "file", id: "doc-notes", label: "notes.pdf" }]);
  } finally {
    await dock.cleanup();
  }
});

test("one message takes up to eight files: Choose from Files attaches a saved file once, drops and pastes count, Remove never deletes", async () => {
  const dock = await attachmentDock((url) => {
    if (new URL(url, "http://localhost").pathname !== "/api/documents") return null;
    return new Response(
      JSON.stringify({
        files: [savedFile("saved-new", "Plan.pdf", { byteSize: 5 * 1024 * 1024 }), savedFile("saved-old", "Plan.pdf", { byteSize: 1024, createdAt: "2026-09-02T09:00:00.000Z" })],
        usage: { count: 2, bytes: 0, maxCount: null, maxBytes: null, maxFileBytes: 26_214_400 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  const files = (count: number, prefix: string) => Array.from({ length: count }, (_, index) => new File([`${prefix} ${index}`], `${prefix}-${index + 1}.txt`, { type: "text/plain" }));
  try {
    const { button, chips, until } = dock;
    const choose = async () => {
      await act(async () => button("Attach files")!.click());
      await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((node) => /Choose from Files/.test(node.textContent ?? ""))!.click());
      await until(() => document.querySelectorAll('[role="dialog"] button[title="Plan.pdf"]').length === 2, "the picker lists saved files");
      return [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button[title="Plan.pdf"]')];
    };
    let rows = await choose();
    assert.notEqual(rows[0]!.textContent, rows[1]!.textContent, "two files with one name read differently");
    assert.match(rows[0]!.textContent ?? "", /PDF · 5\.0 MB/);
    await act(async () => rows[0]!.click());
    assert.equal(chips().length, 1);
    assert.equal(chips()[0]!.dataset.state, "ready", "a saved file is referenced, not uploaded again");
    assert.equal(FakeUpload.made.length, 0);
    rows = await choose();
    assert.match(rows[0]!.textContent ?? "", /Attached$/);
    await act(async () => rows[0]!.click());
    assert.equal(chips().length, 1, "the same file is attached once");
    assert.match(dock.notice(), /Plan\.pdf is already attached\./);

    const composer = document.body.querySelector<HTMLElement>(".assistant-composer")!;
    const drag = (type: string, dropped: File[]) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: dropped, dropEffect: "none" } });
      return event;
    };
    await act(async () => composer.dispatchEvent(drag("dragenter", [])));
    assert.ok(composer.hasAttribute("data-dropping"), "the box shows it takes the drop");
    assert.match(composer.querySelector(".assistant-drop-target")?.textContent ?? "", /Drop files to attach/);
    const drop = drag("drop", files(3, "dropped"));
    await act(async () => composer.dispatchEvent(drop));
    assert.equal(drop.defaultPrevented, true, "the browser does not open the file");
    assert.equal(composer.hasAttribute("data-dropping"), false);
    assert.equal(chips().length, 4);

    const textarea = document.body.querySelector("textarea")!;
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { files: [new File([new Uint8Array([1])], "image.png", { type: "image/png" })], types: ["Files"], getData: () => "" } });
    await act(async () => textarea.dispatchEvent(paste));
    assert.equal(chips().length, 5, "a pasted picture is attached");

    await dock.pick([new File(["MZ"], "setup.exe"), ...files(4, "more")]);
    assert.equal(chips().length, 8, "no more than eight");
    assert.match(dock.notice(), /setup\.exe: \.exe files are programs/);
    assert.match(dock.notice(), /A message can carry up to 8 files\. Remove one to add another\./);
    assert.ok(dock.chip("more-3.txt"));
    assert.equal(dock.chip("more-4.txt"), undefined);
    assert.equal(button("Send")!.disabled, true);
    await until(() => FakeUpload.made.length === 2, "two upload at a time");
    assert.match(dock.chip("more-3.txt")!.textContent ?? "", /Waiting to upload/);

    await act(async () => button("Remove Plan.pdf from this message")!.click());
    assert.equal(chips().length, 7);
    assert.equal(dock.requests.some((request) => request.method === "DELETE"), false, "removing never deletes the file from Files");

    await act(async () => FakeUpload.made[0]!.respond(413, { error: "That file is too big to upload here." }));
    await until(() => chips().some((node) => node.dataset.state === "failed"), "a failed upload shows why");
    const failed = chips().find((node) => node.dataset.state === "failed")!;
    assert.match(failed.textContent ?? "", /That file is too big to upload here\./);
    const name = failed.querySelector(".truncate")!.textContent!;
    assert.ok(button(`Remove ${name} from this message`));
    await act(async () => button(`Retry uploading ${name}`)!.click());
    assert.match(dock.chip(name)!.textContent ?? "", /Waiting to upload/, "Retry queues it behind the uploads running");
    const retried = () => FakeUpload.made.some((upload, index) => index > 0 && upload.filename === name);
    for (let round = 0; round < 10 && !retried(); round += 1) {
      const running = FakeUpload.made.filter((upload) => !upload.status && !upload.aborted);
      await act(async () => running.forEach((upload) => upload.respond(201, { file: savedFile(`doc-${upload.filename}`, upload.filename, { kind: "text" }) })));
      await dock.wait();
    }
    assert.ok(retried(), "Retry uploads it again");
    assert.equal(button("Send")!.disabled, true, "still waiting for it");
  } finally {
    const open = FakeUpload.made.filter((upload) => !upload.status);
    await dock.cleanup();
    assert.ok(open.length > 0 && open.every((upload) => upload.aborted), "closing the app stops uploads still running");
  }
});

test("a reloaded message lists the files it carried, with pictures fetched with the session, and a picture that will not load shows its name", async () => {
  const original = globalThis.fetch;
  const asked: Array<{ url: string; credentials?: RequestCredentials }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    asked.push({ url, credentials: init?.credentials });
    if (url.endsWith("/api/documents/f-chart/original")) return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
    return new Response(JSON.stringify({ error: "Not found." }), { status: 404, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  const message = {
    id: "u-files",
    role: "user",
    content: "Compare @file:inline.txt with these",
    mentions: [
      { kind: "file" as const, id: "f-inline", label: "inline.txt" },
      { kind: "file" as const, id: "f-chart", label: "chart.png" },
      { kind: "file" as const, id: "f-gone", label: "gone.png" },
      { kind: "file" as const, id: "f-q3", label: "q3.pdf" },
    ],
    toolCalls: [],
    model: null,
    createdAt: "2026-10-25T09:00:00.000Z",
  };
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><Message conversationId={null} message={message} /></QueryClientProvider>));
    for (let attempt = 0; attempt < 30 && !host.querySelector('a[href="/files/f-chart"] img'); attempt += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    const listed = [...host.querySelectorAll<HTMLAnchorElement>(".assistant-message-files a")];
    assert.deepEqual(listed.map((link) => link.getAttribute("href")), ["/files/f-chart", "/files/f-gone", "/files/f-q3"], "a file already shown in the text is not listed twice");
    assert.equal(host.querySelector('.assistant-user-message a.mention[data-id="f-inline"]')?.getAttribute("href"), "/files/f-inline");
    assert.ok(listed[0]!.querySelector("img")?.getAttribute("src")?.startsWith("blob:"), "a picture shows a thumbnail");
    assert.equal(listed[1]!.querySelector("img"), null, "a picture that cannot load shows its name only");
    assert.match(listed[1]!.textContent ?? "", /gone\.png/);
    assert.equal(listed[2]!.querySelector("img"), null, "other files show an icon");
    assert.deepEqual(asked.map((request) => [new URL(request.url, "http://localhost").pathname, request.credentials]), [["/api/documents/f-chart/original", "include"], ["/api/documents/f-gone/original", "include"]]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
    globalThis.fetch = original;
  }
});
