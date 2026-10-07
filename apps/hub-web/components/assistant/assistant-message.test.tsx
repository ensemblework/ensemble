import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { api, type AssistantMessageRecord } from "@/lib/api";
import { Message } from "./assistant-dock.js";

const stale: AssistantMessageRecord = {
  id: "m1",
  role: "assistant",
  content: "Create project “Launch”.\n\nNothing has changed yet — press Apply.",
  toolCalls: [
    {
      id: "c1",
      name: "hub_create_project",
      summary: "Create project “Launch”",
      state: "awaiting_approval",
      isWrite: true,
      input: { name: "Launch" },
    },
  ],
  model: "gemini-3.5-flash",
  createdAt: "2026-10-04T20:00:00.000Z",
};

const updated: AssistantMessageRecord = {
  ...stale,
  content: "Create project “Launch”.\n\nApplied. Created “Launch”.",
  toolCalls: [{ ...stale.toolCalls[0]!, state: "ok", summary: "Created “Launch”." }],
};

function Thread() {
  const messages = useQuery({
    queryKey: ["assistant-messages", "conv"],
    queryFn: () => api.conversationMessages("conv"),
    retry: false,
  });
  return (
    <div>
      {(messages.data?.messages ?? []).map((message) => (
        <Message key={message.id} message={message} conversationId="conv" />
      ))}
    </div>
  );
}

test("Apply updates the open reply before the reload, and the reload stays updated", async () => {
  let gets = 0;
  let releaseReload: () => void = () => undefined;
  const reloadGate = new Promise<void>((resolve) => {
    releaseReload = resolve;
  });
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/assistant/apply")) {
      assert.equal(init?.method, "POST");
      return new Response(
        JSON.stringify({
          summary: "Created “Launch”.",
          href: null,
          undoEntryId: null,
          replies: [{ id: updated.id, content: updated.content, toolCalls: updated.toolCalls }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    gets += 1;
    if (gets > 1) await reloadGate;
    const messages = gets > 1 ? [updated] : [stale];
    return new Response(JSON.stringify({ messages }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 },
      mutations: { gcTime: 0 },
    },
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Thread />
        </QueryClientProvider>,
      );
    });
    for (let attempt = 0; attempt < 20 && !(host.textContent ?? "").includes("Nothing has changed yet"); attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
    }
    assert.match(host.textContent ?? "", /Nothing has changed yet/, host.innerHTML);
    const button = [...host.querySelectorAll("button")].find((node) => node.textContent === "Apply");
    assert.ok(button);
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    assert.equal((host.textContent ?? "").includes("Nothing has changed yet"), false);
    assert.match(host.textContent ?? "", /Applied\. Created “Launch”\./);
    assert.match(host.textContent ?? "", /Applied/);
    releaseReload();
    await act(async () => {
      await reloadGate;
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    assert.equal((host.textContent ?? "").includes("Nothing has changed yet"), false);
    assert.match(host.textContent ?? "", /Applied\. Created “Launch”\./);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = original;
    client.clear();
  }
});

test("Apply all on a batch that partly lands shows which calls landed and which did not", async () => {
  const pending: AssistantMessageRecord = {
    id: "m2",
    role: "assistant",
    content: "Ready to apply: the project, the invite and the brief.\n\nNothing has changed yet — press Apply.",
    toolCalls: [
      { id: "c1", name: "hub_create_project", summary: "Create project “Launch”", state: "awaiting_approval", isWrite: true, input: { name: "Launch" } },
      { id: "c2", name: "calendar_create_event", summary: "Create event “Design review”", state: "awaiting_approval", isWrite: true, input: { title: "Design review" } },
      { id: "c3", name: "docs_create", summary: "Create Google Doc “Brief”", state: "awaiting_approval", isWrite: true, input: { title: "Brief" } },
    ],
    model: "gemini-3.5-flash",
    createdAt: "2026-10-07T09:00:00.000Z",
  };
  const failure = "Google Docs refused the request (HTTP 500): Backend error.";
  const landed: AssistantMessageRecord = {
    ...pending,
    content: `Ready to apply: the project, the invite and the brief.\n\nApplied. Created “Launch”; Created “Design review”.\n\nNot applied: ${failure.replace(/\.$/, "")}.`,
    toolCalls: [
      { ...pending.toolCalls[0]!, state: "ok", summary: "Created “Launch”." },
      { ...pending.toolCalls[1]!, state: "ok", summary: "Created “Design review”." },
      { ...pending.toolCalls[2]!, state: "failed", error: failure, summary: failure },
    ],
  };
  let sentCalls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/assistant/apply")) {
      sentCalls = (JSON.parse(String(init?.body)) as { calls: unknown[] }).calls.length;
      return new Response(
        JSON.stringify({
          summary: "Created “Launch”. Created “Design review”.",
          href: null,
          undoEntryId: "u1",
          partial: true,
          failed: [{ callId: "c3", name: "docs_create", error: failure, attempted: true }],
          replies: [{ id: landed.id, content: landed.content, toolCalls: landed.toolCalls }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    // The reload after Apply returns what the server saved.
    return new Response(JSON.stringify({ messages: [sentCalls ? landed : pending] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity, gcTime: 0 }, mutations: { gcTime: 0 } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Thread />
        </QueryClientProvider>,
      );
    });
    for (let attempt = 0; attempt < 20 && !(host.textContent ?? "").includes("Apply all"); attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
    }
    const button = [...host.querySelectorAll("button")].find((node) => node.textContent === "Apply all");
    assert.ok(button, host.innerHTML);
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    assert.equal(sentCalls, 3);
    const text = host.textContent ?? "";
    assert.match(text, /Created “Launch”\./);
    assert.match(text, /Created “Design review”\./);
    assert.ok(text.includes(failure), "the failed call shows its error");
    assert.match(text, /Not applied: Google Docs refused/);
    assert.equal(text.includes("Nothing has changed yet"), false);
    assert.equal([...host.querySelectorAll("button")].some((node) => node.textContent === "Apply all" || node.textContent === "Apply"), false, "nothing is offered for a second Apply");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = original;
    client.clear();
  }
});
