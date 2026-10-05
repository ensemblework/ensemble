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
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 } },
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
