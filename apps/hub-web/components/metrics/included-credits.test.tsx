import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IncludedUsage } from "@ensemble/shared-types";
import { IncludedCreditsCard, monthDays } from "./included-credits.js";
import MetricsPage from "../../app/(hub)/metrics/page.js";

(globalThis as { React?: typeof React }).React = React;

const USAGE: IncludedUsage = {
  available: true,
  models: [],
  period: "2026-10",
  resetsAt: "2026-11-01T00:00:00.000Z",
  limit: 20_000,
  used: 5_740.4,
  remaining: 14_259.6,
  paused: false,
  totals: { calls: 42, inputTokens: 1_234_000, cachedTokens: 300_000, outputTokens: 85_000, inputCredits: 4_210.3, outputCredits: 1_530.1, credits: 5_740.4 },
  byModel: [
    { model: "gpt-6-luna", label: "GPT-6 Luna", calls: 40, inputTokens: 1_000_000, cachedTokens: 300_000, outputTokens: 60_000, inputCredits: 1_210.3, outputCredits: 530.1, credits: 1_740.4 },
    { model: "gpt-6.1-sol", label: "GPT-6.1 Sol", calls: 2, inputTokens: 234_000, cachedTokens: 0, outputTokens: 25_000, inputCredits: 3_000, outputCredits: 1_000, credits: 4_000 },
  ],
  byPurpose: [
    { purpose: "Hub chat", calls: 38, credits: 5_700 },
    { purpose: "Meeting extraction", calls: 4, credits: 40.4 },
  ],
  days: [
    { day: "2026-10-03", credits: 120, calls: 4 },
    { day: "2026-10-16", credits: 0.4, calls: 1 },
  ],
};

async function render(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return {
    host,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test("the credits card: what is left, the reset day, input and output with cached tokens, models, purposes and days", async () => {
  const view = await render(<IncludedCreditsCard usage={USAGE} />);
  try {
    const card = view.host.querySelector<HTMLElement>('[data-testid="ensemble-credits"]')!;
    assert.equal(card.dataset.state, "ok");
    assert.match(card.textContent ?? "", /Ensemble credits/);
    assert.match(card.textContent ?? "", /resets Nov 1/);
    assert.match(card.textContent ?? "", /14,259of 20,000 credits left this month/);
    assert.equal(card.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow"), "5740");
    assert.equal(card.querySelector('[data-testid="credits-notice"]'), null);
    const split = card.querySelector('[data-testid="credits-split"]')!.textContent ?? "";
    assert.match(split, /Input · 1\.2M tokens \(300K cached\) · 4,210 credits/);
    assert.match(split, /Output · 85K tokens · 1,530 credits/);
    const rows = Array.from(card.querySelectorAll('[data-testid="credits-by-model"] tbody tr')).map((row) => Array.from(row.children).map((cell) => cell.textContent));
    assert.deepEqual(rows, [
      ["GPT-6 Luna (2026-09-22)", "40", "1,210 credits", "530 credits", "1,740 credits"],
      ["GPT-6.1 Sol (2026-09-29)", "2", "3,000 credits", "1,000 credits", "4,000 credits"],
    ]);
    assert.match(card.querySelector('[data-testid="credits-by-purpose"]')?.textContent ?? "", /Meeting extraction4 calls · 40 credits/);
    const days = card.querySelectorAll('[data-testid="credits-per-day"] [data-day]');
    assert.equal(days.length, 31, "every day of October");
    assert.match(card.querySelector('[data-day="2026-10-16"]')?.textContent ?? "", /Oct 16: 0\.4 credits · 1 call/);
    assert.doesNotMatch(card.textContent ?? "", /\$/, "never dollars");
  } finally {
    await view.done();
  }
});

test("used up and paused each say why included calls stop and that people's own keys still work", async () => {
  const used = await render(<IncludedCreditsCard usage={{ ...USAGE, used: 20_000, remaining: 0 }} />);
  try {
    const card = used.host.querySelector<HTMLElement>('[data-testid="ensemble-credits"]')!;
    assert.equal(card.dataset.state, "used");
    assert.match(card.querySelector('[data-testid="credits-notice"]')?.textContent ?? "", /You've used this month's credits\. They reset on Nov 1\. Your own keys and plans still work\./);
    assert.equal(card.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow"), "20000");
  } finally {
    await used.done();
  }
  const paused = await render(<IncludedCreditsCard usage={{ ...USAGE, paused: true }} />);
  try {
    const card = paused.host.querySelector<HTMLElement>('[data-testid="ensemble-credits"]')!;
    assert.equal(card.dataset.state, "paused");
    assert.match(
      card.querySelector('[data-testid="credits-notice"]')?.textContent ?? "",
      /Included AI is paused for everyone until Nov 1 because this month's shared budget is used up\. Your own keys and plans still work\./,
    );
    assert.match(card.textContent ?? "", /14,259of 20,000 credits left/, "credits left are still shown");
  } finally {
    await paused.done();
  }
  assert.equal(monthDays({ period: "2026-02", days: [] }).length, 28);
});

const SUMMARY = {
  days: [
    { day: "2026-10-16", calls: 3, tokensIn: 3000, tokensOut: 300, estimatedUsd: 0.12, credits: 12.4 },
    { day: "2026-10-17", calls: 1, tokensIn: 1000, tokensOut: 100, estimatedUsd: null, credits: 0.4 },
  ],
  byModel: [
    { model: "gpt-6-luna", provider: "ensemble", calls: 2, tokensIn: 2000, tokensOut: 200, estimatedUsd: null, credits: 12.8 },
    { model: "gpt-6-luna", provider: "openai", calls: 2, tokensIn: 2000, tokensOut: 200, estimatedUsd: 0.12, credits: null },
  ],
  byPurpose: [{ purpose: "Hub chat", calls: 4, tokensIn: 4000, tokensOut: 400, estimatedUsd: 0.12, credits: 12.8 }],
  recent: [
    { title: "Plan my day", purpose: "Hub chat", provider: "ensemble", model: "gpt-6-luna", tokensIn: 1000, tokensOut: 100, estimatedUsd: null, credits: 0.4, at: "2026-10-17T09:00:00.000Z" },
    { title: "Draft the launch note", purpose: "Hub chat", provider: "openai", model: "gpt-6-luna", tokensIn: 1000, tokensOut: 100, estimatedUsd: 0.06, credits: null, at: "2026-10-16T09:00:00.000Z" },
  ],
  providers: ["ensemble", "openai"],
  baselines: [],
  events: [],
  throughput: { completed: 0, failed: 0, medianMinutes: null, waitingOnYou: 0 },
  trust: { approved: 0, edited: 0, rejected: 0 },
  governance: { ledgerEntries: 0 },
};

async function mountPage(credits: IncludedUsage) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    const body = path.startsWith("/api/metrics/summary") ? SUMMARY : path === "/api/metrics/credits" ? credits : { error: "not found" };
    return new Response(JSON.stringify(body), { status: body && typeof body === "object" && "error" in body ? 404 : 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const view = await render(
    <QueryClientProvider client={client}>
      <MetricsPage />
    </QueryClientProvider>,
  );
  for (let i = 0; i < 40 && (!view.host.querySelector("[data-model-row]") || (credits.available && !view.host.querySelector('[data-testid="ensemble-credits"]'))); i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  return {
    host: view.host,
    done: async () => {
      await view.done();
      client.clear();
      globalThis.fetch = realFetch;
    },
  };
}

test("the Metrics page leads with the credits card and shows credits, not dollars, for included calls", async () => {
  const view = await mountPage(USAGE);
  try {
    const text = view.host.textContent ?? "";
    assert.ok(view.host.querySelector('[data-testid="ensemble-credits"]'), "the credits card");
    const included = view.host.querySelector('[data-model-row="ensemble:gpt-6-luna"]')!;
    const own = view.host.querySelector('[data-model-row="openai:gpt-6-luna"]')!;
    assert.match(included.textContent ?? "", /GPT-6 Luna \(2026-09-22\).*2 calls · 13 credits/);
    assert.doesNotMatch(included.textContent ?? "", /\$/);
    assert.match(own.textContent ?? "", /gpt-6-luna.*2 calls · \$0\.12/);
    const calls = Array.from(view.host.querySelectorAll("[data-call-provider]"));
    assert.match(calls[0]!.querySelector("summary")!.textContent ?? "", /Included with Ensemble · GPT-6 Luna \(2026-09-22\).*0\.4 credits$/);
    assert.match(calls[1]!.querySelector("summary")!.textContent ?? "", /OpenAI · gpt-6-luna.*\$0\.06$/);
    assert.ok(view.host.querySelector('[aria-label="Daily AI activity"]'));
    assert.match(text, /Input tokens/);
    assert.match(text, /Output tokens/);
    assert.doesNotMatch(text, /Verify hash chain|Baselines are|eval\/baseline/);
    assert.ok(Array.from(view.host.querySelectorAll("option")).some((node) => node.textContent === "Included with Ensemble"), "the provider filter names it");
  } finally {
    await view.done();
  }
});

test("the Metrics page shows nothing about credits when included models are not set up", async () => {
  const view = await mountPage({ ...USAGE, available: false });
  try {
    assert.match(view.host.textContent ?? "", /Most recent calls/);
    assert.equal(view.host.querySelector('[data-testid="ensemble-credits"]'), null);
  } finally {
    await view.done();
  }
});


test("erased call details are explained while monthly consumption stays visible", async () => {
  const view = await render(<IncludedCreditsCard usage={{ ...USAGE, erasedCredits: 500 }} />);
  try {
    assert.match(view.host.querySelector('[data-testid="erased-credits-notice"]')?.textContent ?? "", /500 credits used before/);
    assert.match(view.host.querySelector('[title*="deleted previous usage"]')?.getAttribute("title") ?? "", /credits already used still count/);
    assert.match(view.host.querySelector('[data-testid="credits-left"]')?.textContent ?? "", /14,259/);
  } finally { await view.done(); }
});
