import assert from "node:assert/strict";
import test from "node:test";
import { deviceCodeApi } from "@/lib/code-target";

type Sent = { url: string; body: { method?: string; path?: string; query?: Record<string, string>; body?: unknown } | null };

function fakeServer(): { sent: Sent[]; restore: () => void } {
  const sent: Sent[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    sent.push({ url, body: init?.body ? (JSON.parse(String(init.body)) as Sent["body"]) : null });
    return new Response(JSON.stringify({ error: "unexpected" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { sent, restore: () => void (globalThis.fetch = real) };
}

test("the Code calls for a computer go through Ensemble on the web with their method, path and query", async () => {
  const server = fakeServer();
  try {
    const code = deviceCodeApi("d1");
    await code.codeDiff({ review: "r1" }, "src/a.ts", false).catch(() => undefined);
    await code.saveCodeFile({ repo: "/r" }, "src/a.ts", "text").catch(() => undefined);
    await code.commit("/r", "message").catch(() => undefined);
    assert.deepEqual(server.sent.map((row) => row.body), [
      { method: "GET", path: "/api/code/diff", query: { review: "r1", path: "src/a.ts", untracked: "false" } },
      { method: "PUT", path: "/api/code/file", query: {}, body: { repo: "/r", path: "src/a.ts", content: "text" } },
      { method: "POST", path: "/api/code/scm/commit", query: {}, body: { repo: "/r", message: "message", all: false } },
    ]);
    assert.ok(server.sent.every((row) => row.url.endsWith("/api/devices/d1/code")));
  } finally {
    server.restore();
  }
});
