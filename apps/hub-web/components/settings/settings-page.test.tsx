import { setTestUrl } from "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Settings } from "@ensemble/shared-types";
import { catalogWith } from "../connectors/test-fixtures.js";
import SettingsPage from "../../app/(hub)/settings/page.js";

(globalThis as { React?: typeof React }).React = React;
Object.defineProperty(globalThis, "self", { configurable: true, value: window });
// The Account tab's appearance and motion pieces read media queries.
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: (media: string) => ({ matches: false, media, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }),
});

const SETTINGS = Settings.parse({ email: "mira@fieldnote.example", timezone: "Europe/London" });

const SUBSCRIPTIONS = {
  preferred: null,
  computers: [
    {
      id: "device-1",
      name: "Studio Mac",
      platform: "macos",
      local: false,
      online: true,
      lastSeenAt: "2026-10-15T09:00:00.000Z",
      appVersion: "cli-0.3.10",
      ready: true,
      agents: [
        { id: "claude-code", via: "app", version: "2.1.293", signedIn: true, plan: "max", models: [{ id: "default", label: "Your plan's default", isDefault: true }, { id: "haiku", label: "Haiku (latest)" }], typedModels: true, efforts: ["low", "medium", "high"], checkedAt: "2026-10-15T09:00:00.000Z" },
        { id: "codex", via: "app", version: "0.162.0", signedIn: false, plan: null, models: [{ id: "gpt-6-luna", label: "GPT-6 Luna", isDefault: true }], typedModels: true, checkedAt: "2026-10-15T09:00:00.000Z" },
        {
          id: "copilot-cli",
          via: "cli",
          version: "1.0.40",
          signedIn: true,
          account: "mira-chen",
          models: [
            { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", isDefault: true, efforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultEffort: "medium", contexts: [{ id: "default", label: "200K (standard)", tokens: 200000 }, { id: "long_context", label: "922K (long context)", tokens: 922000 }], vision: true, cost: "low cost", description: "OpenAI" },
            { id: "claude-haiku-4.5", label: "Claude Haiku 4.5", contexts: [{ id: "default", label: "136K", tokens: 136000 }], cost: "0.33× premium requests", description: "Anthropic" },
          ],
          checkedAt: "2026-10-15T09:00:00.000Z",
        },
      ],
    },
  ],
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
  }
}

/** Waits for a lazily loaded tab to show something. */
async function until(check: () => boolean, label: string) {
  for (let i = 0; i < 60; i += 1) {
    if (check()) return;
    await settle(1);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

/** `answers`: GET responses that replace the defaults below, by path. */
async function mount(url: string, answers: Record<string, unknown> = {}) {
  setTestUrl(url);
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  const bodies: Array<{ path: string; method: string; body: unknown }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push(path);
    if (init?.method && init.method !== "GET") bodies.push({ path, method: init.method, body: init.body ? JSON.parse(String(init.body)) : null });
    if ((!init?.method || init.method === "GET") && path in answers) return json(answers[path]);
    if (path === "/api/settings") return json({ settings: SETTINGS });
    if (path === "/api/subscriptions") return json(SUBSCRIPTIONS);
    if (path === "/api/subscriptions/sign-in") return json({ message: "A sign-in window is opening on Studio Mac. Finish signing in there." }, 202);
    if (path === "/api/connectors/catalog") return json({ entries: catalogWith({ github: { connected: true, account: "mira-chen" } }) });
    if (path === "/api/model-keys") return json({ credentials: [{ provider: "google", source: "you", hint: "…a1b2", updatedAt: null }] });
    if (path === "/api/models") return json({ providers: [], runtime: true, updatedAt: "2026-10-07T00:00:00.000Z" });
    if (path === "/api/watchers") return json({ watchers: [] });
    if (path === "/api/connections") return json({ connections: [], lastFetch: null });
    return json({ error: "not found" }, 404);
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <SettingsPage />
      </QueryClientProvider>,
    );
  });
  await settle();
  return {
    host,
    calls,
    bodies,
    selected: () => host.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? "",
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
      client.clear();
      globalThis.fetch = realFetch;
      setTestUrl("http://localhost/");
    },
  };
}

test("an old #models link opens the Assistant tab and writes the tab into the address", async () => {
  const view = await mount("http://localhost/settings#models");
  try {
    assert.match(view.selected(), /^Assistant/);
    assert.equal(new URL(window.location.href).searchParams.get("tab"), "assistant");
    assert.equal(window.location.hash, "#models");
    await until(() => Boolean(document.getElementById("models")), "the Models card");
    assert.match(document.getElementById("models")!.textContent ?? "", /Which model each tier uses/);
    // Watchers stay hidden while there are none.
    assert.equal(document.getElementById("watchers"), null);
  } finally {
    await view.done();
  }
});

test("tabs switch by click and arrow keys, and every tab is a real link", async () => {
  const view = await mount("http://localhost/settings");
  try {
    assert.match(view.selected(), /^Account/);
    const tabs = Array.from(view.host.querySelectorAll<HTMLAnchorElement>('[role="tab"]'));
    assert.deepEqual(
      tabs.map((tab) => tab.querySelector("span")?.textContent),
      ["Account", "Appearance", "Spaces", "Sharing", "Assistant", "Connections", "Notifications", "Shortcuts", "Data"],
    );
    assert.equal(tabs[8]!.getAttribute("href"), "?tab=data");
    await act(async () => {
      tabs[8]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await settle(2);
    assert.match(view.selected(), /^Data/);
    assert.equal(new URL(window.location.href).searchParams.get("tab"), "data");
    await act(async () => {
      tabs[8]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    await settle(2);
    assert.match(view.selected(), /^Account/, "wraps around");
    assert.equal(document.activeElement, tabs[0]);
  } finally {
    await view.done();
  }
});

test("Connections shows the five featured apps, connected first, and a connector link opens the store on it", async () => {
  const view = await mount("http://localhost/settings?tab=connections&connector=github");
  try {
    await until(() => Boolean(document.querySelector('[data-testid="featured-connectors"]')), "the featured list");
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="featured-connectors"] [data-connector]')).map((row) => row.dataset.connector);
    assert.deepEqual(rows, ["github", "google_workspace", "microsoft_365", "notion", "linear"], "connected apps come first");
    assert.match(document.querySelector('[data-connector="github"]')!.textContent ?? "", /Connected as mira-chen/);
    await until(() => Boolean(document.querySelector('[data-testid="connector-detail"]')), "the GitHub detail");
    assert.equal(document.querySelector<HTMLElement>('[data-testid="connector-detail"]')!.dataset.connector, "github");
    assert.ok(document.querySelector('[data-testid="fetch-paused"]'), "fetching shows the paused notice");
    assert.equal(document.querySelector('input[type="time"][aria-label^="Fetch time"]'), null, "no schedule editor");
    assert.ok(document.querySelector('a[href="/connect"]'), "editors link to the Connect page");
  } finally {
    await view.done();
  }
});

test("Your AI subscriptions lead the Models card: what each computer has, sign-in, and one click to use a plan", async () => {
  const view = await mount("http://localhost/settings?tab=assistant");
  try {
    await until(() => Boolean(document.querySelector('[data-testid="subscriptions-grid"]')), "the subscriptions");
    const tile = (id: string) => document.querySelector<HTMLElement>(`[data-subscription="${id}"]`)!;
    assert.match(document.querySelector('[data-testid="subscriptions-card"]')!.textContent ?? "", /Studio Maconline/);
    assert.match(tile("claude-code").textContent ?? "", /Signed in · max/);
    assert.match(tile("claude-code").textContent ?? "", /via the Claude app 2\.1\.293/);
    assert.equal(document.querySelector('[data-subscription="gemini"]'), null);
    assert.equal(tile("claude-code").querySelector('[data-provider-logo="claude"]') !== null, true);
    assert.match(tile("codex").textContent ?? "", /Not signed in/);
    assert.equal(tile("cursor-agent").dataset.state, "missing");
    assert.match(tile("cursor-agent").textContent ?? "", /Install Cursor's agent/);

    const button = (root: HTMLElement, text: string) => Array.from(root.querySelectorAll("button")).find((node) => node.textContent?.trim() === text)!;
    await act(async () => {
      button(tile("claude-code"), "Haiku (latest)").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      button(tile("claude-code"), "Use for everything").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    assert.match(tile("claude-code").textContent ?? "", /In use: Low, Medium, High, Max/, "the draft shows it at once");
    // Settings are saved half a second after the last change.
    await settle(45);
    const patch = view.bodies.find((row) => row.path === "/api/settings" && row.method === "PATCH");
    assert.ok(patch, "the tiers are saved");
    const models = (patch.body as { models: Record<string, { provider: string; model: string }> }).models;
    assert.deepEqual(Object.keys(models), ["easy", "medium", "high", "max"]);
    assert.ok(Object.values(models).every((tier) => tier.provider === "claude-code" && tier.model === "haiku"));

    await act(async () => {
      button(tile("codex"), "Sign in").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle(3);
    assert.deepEqual(view.bodies.find((row) => row.path === "/api/subscriptions/sign-in")?.body, { deviceId: "device-1", agent: "codex" });
    assert.match(document.getElementById("models")!.textContent ?? "", /Claude \(your plan\)|Which model each tier uses/);
  } finally {
    await view.done();
  }
});

test("a GitHub Copilot tier shows the account, each model's cost and size, its own thinking default and a context window choice", async () => {
  const settings = Settings.parse({ email: "mira@fieldnote.example", timezone: "Europe/London", models: { easy: { provider: "copilot-cli", model: "gpt-5.6-luna", effort: "default" } } });
  const view = await mount("http://localhost/settings?tab=assistant", { "/api/settings": { settings } });
  try {
    await until(() => Boolean(document.querySelector('[data-tier="easy"] [data-picker="tuning"]')), "the thinking and context button");
    const tile = document.querySelector<HTMLElement>('[data-subscription="copilot-cli"]')!;
    assert.match(tile.textContent ?? "", /Signed in as mira-chen/);
    assert.match(tile.querySelector('[data-testid="subscription-model-facts"]')?.textContent ?? "", /GPT-5\.6 Luna: OpenAI · low cost · 200K or 922K context/);

    const tier = document.querySelector<HTMLElement>('[data-tier="easy"]')!;
    assert.match(tier.querySelector('[data-picker="agent"]')?.textContent ?? "", /GitHub Copilot · GPT-5\.6 Luna/, "agent and model in one picker");
    await act(async () => {
      tier.querySelector<HTMLElement>('[data-picker="tuning"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const radios = (group: string) => Array.from(document.querySelectorAll(`[role="radiogroup"][aria-label="${group}"] [role="radio"]`)) as HTMLElement[];
    assert.equal(radios("Low model: thinking and context: thinking")[0]?.textContent, "Auto (Medium)", "the model's own default level");
    assert.deepEqual(radios("Low model: thinking and context: context window").map((node) => node.textContent), ["Standard · 200K (standard)", "Long context · 922K (long context)"]);
    await act(async () => {
      radios("Low model: thinking and context: context window")[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle(45);
    const patch = view.bodies.find((row) => row.path === "/api/settings" && row.method === "PATCH");
    assert.deepEqual(patch?.body, { models: { easy: { effort: "default", context: "long_context" } } });
  } finally {
    await view.done();
  }
});

test("API keys open as a page of their own from the Models card, and Escape closes it", async () => {
  const view = await mount("http://localhost/settings?tab=assistant");
  try {
    await until(() => Boolean(document.querySelector('[data-testid="model-keys-row"]')), "the keys row");
    assert.match(document.querySelector('[data-testid="model-keys-row"]')!.textContent ?? "", /Google Gemini has a key/);
    assert.equal(document.querySelector('[data-testid="model-keys-dialog"]'), null);
    const open = Array.from(document.querySelectorAll("button")).find((node) => node.textContent?.trim() === "Manage API keys")!;
    await act(async () => {
      open.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await settle(3);
    const dialog = document.querySelector<HTMLElement>('[data-testid="model-keys-dialog"]');
    assert.ok(dialog);
    assert.equal(new URL(window.location.href).searchParams.get("dialog"), "keys");
    assert.match(dialog.textContent ?? "", /OpenRouter/);
    assert.equal(dialog.querySelector('[data-pane]')?.getAttribute("data-pane"), "google", "Gemini first: the cheapest to start");
    const openrouter = dialog.querySelector<HTMLElement>('[data-provider="openrouter"]')!;
    await act(async () => {
      openrouter.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle(2);
    assert.equal(dialog.querySelector('[data-pane]')?.getAttribute("data-pane"), "openrouter");
    assert.ok(dialog.querySelector('input[aria-label="OpenRouter API key"]'), "the key field");
    const more = Array.from(dialog.querySelectorAll("button")).find((node) => node.textContent?.trim() === "Other settings")!;
    await act(async () => {
      more.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle(2);
    assert.match(dialog.textContent ?? "", /Ollama URL/);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle(2);
    assert.equal(document.querySelector('[data-testid="model-keys-dialog"]'), null);
    assert.equal(new URL(window.location.href).searchParams.get("dialog"), null);
    assert.doesNotMatch(document.body.textContent ?? "", /Your field/, "the role from sign-up is not asked again");
    assert.match(document.querySelector('[data-testid="changes-summary"]')?.textContent ?? "", /Everything inside Ensemble · Connected apps ask first/);
  } finally {
    await view.done();
  }
});

test("an old Accent deep link selects Appearance and scrolls to the control", async()=>{
  const previous=HTMLElement.prototype.scrollIntoView;
  const scrolled:HTMLElement[]=[];
  HTMLElement.prototype.scrollIntoView=function(){scrolled.push(this);};
  const view=await mount("http://localhost/settings?tab=account#jump-appearance-accent");
  try {
    await until(()=>scrolled.some(node=>node.dataset.jumpLabel==="Accent"),"Accent control scroll");
    assert.match(view.selected(),/^Appearance/);
    assert.equal(scrolled.at(-1)?.dataset.jumpLabel,"Accent");
  } finally {await view.done();HTMLElement.prototype.scrollIntoView=previous;}
});

const INCLUDED_IDS = ["gpt-6-luna", "deepseek-v4-flash", "gpt-6.1-sol", "grok-4.7"];
const INCLUDED_CATALOG = {
  providers: [
    {
      provider: "ensemble",
      available: true,
      source: "included",
      models: INCLUDED_IDS,
      meta: Object.fromEntries(INCLUDED_IDS.map((id) => [id, { efforts: id === "deepseek-v4-flash" ? [] : ["low", "medium", "high"] }])),
      chat: true,
      cheapest: "gpt-6-luna",
      error: null,
    },
    { provider: "google", available: true, source: "you", models: ["gemini-3.5-flash-lite", "gemini-3.5-flash"], chat: true, cheapest: "gemini-3.5-flash-lite", error: null },
  ],
  runtime: true,
  updatedAt: "2026-10-17T00:00:00.000Z",
};
const EMPTY_ROW = { calls: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, inputCredits: 0, outputCredits: 0, credits: 0 };
const USAGE = {
  available: true,
  models: [],
  period: "2026-10",
  resetsAt: "2026-11-01T00:00:00.000Z",
  limit: 20_000,
  used: 7_654.6,
  remaining: 12_345.4,
  paused: false,
  totals: EMPTY_ROW,
  byModel: [],
  byPurpose: [],
  days: [],
};

const tabNames = () => Array.from(document.querySelectorAll('[role="tablist"][aria-label="Where the model comes from"] [role="tab"]')).map((node) => node.textContent);
const openLowPicker = async () => {
  await act(async () => {
    document.querySelector('[aria-label="Low model: agent and model"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

test("without included models there is no Included tab and nothing about credits", async () => {
  const view = await mount("http://localhost/settings?tab=assistant");
  try {
    await until(() => Boolean(document.querySelector('[aria-label="Low model: agent and model"]')), "the tier pickers");
    await openLowPicker();
    assert.deepEqual(tabNames(), ["Your AI plans", "API keys"]);
    assert.equal(document.querySelector('[data-testid="included-credits"]'), null);
    assert.ok(!view.calls.includes("/api/metrics/credits"), "credits are not asked for");
  } finally {
    await view.done();
  }
});

test("included models: a first Included tab with credits left, the credits line, and picking one sets the cheapest model on Auto", async () => {
  const view = await mount("http://localhost/settings?tab=assistant", { "/api/models": INCLUDED_CATALOG, "/api/metrics/credits": USAGE });
  try {
    await until(() => Boolean(document.querySelector('[data-testid="included-credits"]')), "the credits line");
    const line = document.querySelector<HTMLElement>('[data-testid="included-credits"]')!;
    assert.match(line.textContent ?? "", /Included with Ensemble: 12,345 of 20,000 credits left this month · resets Nov 1/);
    assert.equal(line.dataset.state, "ok");
    assert.equal(line.querySelector("a")?.getAttribute("href"), "/metrics");
    await openLowPicker();
    assert.deepEqual(tabNames(), ["Included", "Your AI plans", "API keys"]);
    const included = Array.from(document.querySelectorAll('[role="tab"]')).find((node) => node.textContent === "Included")!;
    await act(async () => {
      included.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    assert.match(document.querySelector("[data-agent-picker]")?.textContent ?? "", /Included with Ensemble: 12,345 credits left/);
    const option = Array.from(document.querySelectorAll<HTMLElement>('[data-agent-picker] [role="option"]')).find((node) => /GPT-6 Luna \(2026-09-22\)/.test(node.textContent ?? ""))!;
    assert.ok(option.querySelector("[data-provider-logo]"), "the vendor's logo");
    await act(async () => {
      option.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle(2);
    const tier = document.querySelector<HTMLElement>('[data-tier="easy"]')!;
    assert.match(tier.querySelector('[data-picker="agent"]')?.textContent ?? "", /Included · GPT-6 Luna \(2026-09-22\)/);
    const openTuning = async () => {
      if (document.querySelector("[data-tuning-picker]")) return;
      await act(async () => {
        tier.querySelector<HTMLElement>('[data-picker="tuning"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    };
    const levels = () => Array.from(document.querySelectorAll('[aria-label="Low model: thinking and context: thinking"] [role="radio"]'));
    await openTuning();
    assert.deepEqual(levels().map((node) => node.textContent), ["Auto (Medium)", "Low", "Medium", "High"]);
    assert.equal(levels().find((node) => node.getAttribute("aria-checked") === "true")?.textContent, "Auto (Medium)");
    await settle(45);
    const patch = view.bodies.find((row) => row.path === "/api/settings" && row.method === "PATCH");
    assert.ok(patch, "the tier is saved");
    const easy = (patch.body as { models: Record<string, { provider: string; model: string; effort: string }> }).models.easy!;
    assert.deepEqual({ provider: easy.provider, model: easy.model, effort: easy.effort }, { provider: "ensemble", model: "gpt-6-luna", effort: "default" });

    const high = levels().find((node) => node.textContent === "High")!;
    await act(async () => {
      high.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle(2);
    assert.equal(levels().find((node) => node.getAttribute("aria-checked") === "true")?.textContent, "High");
    await openLowPicker();
    const deepseek = Array.from(document.querySelectorAll('[data-agent-picker] [role="option"]')).find((node) => /DeepSeek V4 Flash/.test(node.textContent ?? ""))!;
    await act(async () => {
      deepseek.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle(45);
    assert.equal(tier.querySelector('[data-picker="tuning"]'), null, "DeepSeek decides how much to think: nothing to tune");
    const last = view.bodies.filter((row) => row.path === "/api/settings" && row.method === "PATCH").at(-1)!.body as { models: Record<string, { model: string; effort: string }> };
    assert.deepEqual({ model: last.models.easy!.model, effort: last.models.easy!.effort }, { model: "deepseek-v4-flash", effort: "default" }, "the level goes back to Auto");
  } finally {
    await view.done();
  }
});

test("the credits line warns when this account's credits are used or included AI is paused for everyone", async () => {
  const used = await mount("http://localhost/settings?tab=assistant", { "/api/models": INCLUDED_CATALOG, "/api/metrics/credits": { ...USAGE, used: 20_000, remaining: 0 } });
  try {
    await until(() => Boolean(document.querySelector('[data-testid="included-credits"]')), "the credits line");
    const line = document.querySelector<HTMLElement>('[data-testid="included-credits"]')!;
    assert.equal(line.dataset.state, "used");
    assert.match(line.textContent ?? "", /0 of 20,000 credits left/);
    assert.ok(line.querySelector(".text-warn"), "warning tone");
  } finally {
    await used.done();
  }
  const paused = await mount("http://localhost/settings?tab=assistant", { "/api/models": INCLUDED_CATALOG, "/api/metrics/credits": { ...USAGE, paused: true } });
  try {
    await until(() => Boolean(document.querySelector('[data-testid="included-credits"]')), "the credits line");
    const line = document.querySelector<HTMLElement>('[data-testid="included-credits"]')!;
    assert.equal(line.dataset.state, "paused");
    assert.match(line.textContent ?? "", /Paused for everyone until Nov 1/);
    await openLowPicker();
    const included = Array.from(document.querySelectorAll('[role="tab"]')).find((node) => node.textContent === "Included")!;
    await act(async () => {
      included.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    assert.match(document.querySelector("[data-agent-picker]")?.textContent ?? "", /paused until Nov 1/);
  } finally {
    await paused.done();
  }
});
