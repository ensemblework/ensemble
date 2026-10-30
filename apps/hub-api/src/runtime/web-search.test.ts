/**
 * hub_web_search for every model (runtime/search.ts, workspace/research.ts): included models search
 * with Azure Foundry's web_search tool on the account's included credits, with the search fee on the
 * ledger; Bing's RSS results and then DuckDuckGo answer when that finds nothing, fails or is refused.
 * Azure, Bing, DuckDuckGo and the ledger are faked. No network, no database.
 */
import "./test-env.js";
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS, INCLUDED_CREDITS_USED, INCLUDED_PROVIDER, type Settings } from "@ensemble/shared-types";
import { setIncludedBudgetForTests } from "../included/budget.js";
import { IncludedLimitError } from "../included/errors.js";
import { WEB_SEARCH_CALL_USD, type IncludedTokens } from "../included/pricing.js";
import { resetBuckets } from "./pace.js";
import { fromWebSearchResponse, includedSearchModel, includedWebSearch, setSearchFetchForTests } from "./search.js";
import { setWebSearchFetchForTests, webSearchFrom } from "../workspace/research.js";
import { graphTools } from "../assistant/tools/graph.js";

const ENV = ["AZURE_FOUNDRY_RESOURCE", "AZURE_FOUNDRY_API_KEY", "ENSEMBLE_INCLUDED_MODELS"] as const;
const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));

const FOUNDRY_REPLY = {
  status: "completed",
  output: [
    { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "rtx 5090 price" } },
    { type: "web_search_call", id: "ws_2", status: "completed", action: { type: "search", query: "rtx 5090 best buy" } },
    {
      type: "message",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: "The RTX 5090 lists at $1,999 at Best Buy ([bestbuy.com](https://www.bestbuy.com/site/rtx-5090?utm_source=openai)). Newegg has it for $2,149 ([newegg.com](https://www.newegg.com/p/rtx-5090?utm_source=openai)).",
          annotations: [
            { type: "url_citation", start_index: 42, end_index: 112, url: "https://www.bestbuy.com/site/rtx-5090?utm_source=openai", title: "NVIDIA GeForce RTX 5090 - Best Buy" },
            { type: "url_citation", start_index: 150, end_index: 210, url: "https://www.newegg.com/p/rtx-5090?utm_source=openai", title: "RTX 5090 | Newegg" },
            { type: "url_citation", start_index: 150, end_index: 210, url: "https://www.newegg.com/p/rtx-5090?utm_source=openai", title: "RTX 5090 | Newegg" },
          ],
        },
      ],
    },
  ],
  usage: { input_tokens: 9_000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 300 },
};

const BING_RSS = `<?xml version="1.0" encoding="utf-8" ?><rss version="2.0"><channel><title>Bing: rtx 5090 price</title><link>https://www.bing.com/search?q=rtx+5090+price</link>
<item><title>NVIDIA GeForce RTX 5090 &amp; more - Best Buy</title><link>https://www.bestbuy.com/site/rtx-5090</link><description>Shop the &lt;b&gt;RTX 5090&lt;/b&gt; at Best Buy. Price $1,999.99.</description></item>
<item><title>Images of rtx 5090</title><link>https://www.bing.com/images/search?q=rtx+5090</link><description>Bing's own page</description></item>
<item><title><![CDATA[RTX 5090 | Newegg]]></title><link>https://www.newegg.com/p/rtx-5090</link><description><![CDATA[Free shipping on the RTX 5090.]]></description></item>
</channel></rss>`;

const DUCK_HTML = `<div class="result results_links"><div class="result__body"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.microcenter.com%2Frtx-5090&amp;rut=x">RTX 5090 - Micro Center</a><a class="result__snippet" href="#">In store now.</a></div></div>`;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Seen = { url: string; headers: Record<string, string>; body: string };

/** The search engines: each URL host answers as the test says; every request is recorded. */
function engines(answer: Partial<Record<"azure" | "bing" | "duck", (seen: Seen) => Response | Promise<Response>>>): Seen[] {
  const seen: Seen[] = [];
  const handle = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const row = { url, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : "" };
    seen.push(row);
    const host = new URL(url).hostname;
    const reply = host.endsWith("azure.com") ? answer.azure : host.endsWith("bing.com") ? answer.bing : host.endsWith("duckduckgo.com") ? answer.duck : undefined;
    if (!reply) throw new TypeError("fetch failed");
    return reply(row);
  };
  setSearchFetchForTests(handle as typeof fetch);
  setWebSearchFetchForTests(handle as typeof fetch);
  return seen;
}

type Reserved = { model: string; inputTokens: number; maxOutputTokens: number; purpose?: string | null; extraUsd?: number };
type Settled = { id: string; usage: IncludedTokens | null; answeredBy?: string | null; extraUsd?: number };

function ledger(options: { refuse?: IncludedLimitError } = {}) {
  const book = { reserves: [] as Reserved[], settles: [] as Settled[] };
  setIncludedBudgetForTests({
    reserve: async (args) => {
      book.reserves.push(args);
      if (options.refuse) throw options.refuse;
      return { id: `res-${book.reserves.length}` };
    },
    settle: async (args) => {
      book.settles.push(args);
      return { credits: 12.5 };
    },
  });
  return book;
}

const settings = (provider: string, model: string): Settings => {
  const tier = { provider, model, effort: "default" as const };
  return { ...DEFAULT_SETTINGS, models: { easy: tier, medium: tier, high: tier, max: tier }, assistant: { ...DEFAULT_SETTINGS.assistant, defaultTier: "medium" } } as Settings;
};

const search = graphTools.find((tool) => tool.name === "hub_web_search")!;
const warnings: unknown[] = [];
const ctx = (provider: string = INCLUDED_PROVIDER, model = "gpt-6-luna") => ({ app: { log: { warn: (...args: unknown[]) => void warnings.push(args) } }, userId: "user-1", settings: settings(provider, model) }) as never;

test.beforeEach(() => {
  process.env.AZURE_FOUNDRY_RESOURCE = "ensemble-ai";
  process.env.AZURE_FOUNDRY_API_KEY = "azure-test-key";
  delete process.env.ENSEMBLE_INCLUDED_MODELS;
  resetBuckets();
  warnings.length = 0;
});

test.afterEach(() => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  setSearchFetchForTests(null);
  setWebSearchFetchForTests(null);
  setIncludedBudgetForTests(null);
});

test("an included model searches with Foundry's web_search tool, cites its sources and pays for each search", async () => {
  const seen = engines({ azure: () => json(FOUNDRY_REPLY) });
  const book = ledger();
  const result = await search.run(ctx(), { query: "rtx 5090 price", market: "en-us" });
  const data = result.data as { results: Array<{ title: string; url: string; snippet: string }>; answer: string; provider: string };
  assert.equal(data.provider, "web_search");
  assert.deepEqual(
    data.results.map((hit) => [hit.title, hit.url]),
    [
      ["NVIDIA GeForce RTX 5090 - Best Buy", "https://www.bestbuy.com/site/rtx-5090"],
      ["RTX 5090 | Newegg", "https://www.newegg.com/p/rtx-5090"],
    ],
    "each cited source once, without the search engine's tracking parameter",
  );
  assert.equal(data.results[0]!.snippet, "The RTX 5090 lists at $1,999 at Best Buy");
  assert.match(data.answer, /^The RTX 5090 lists at \$1,999 at Best Buy/);

  assert.equal(seen.length, 1, "nothing else was asked");
  assert.equal(seen[0]!.url, "https://ensemble-ai.openai.azure.com/openai/v1/responses");
  assert.equal(seen[0]!.headers["api-key"], "azure-test-key");
  const sent = JSON.parse(seen[0]!.body) as { model: string; tools: unknown; input: string; max_output_tokens: number; reasoning?: { effort: string } };
  assert.equal(sent.model, "gpt-6-luna");
  assert.deepEqual(sent.tools, [{ type: "web_search" }]);
  assert.equal(sent.max_output_tokens, 1500);
  assert.match(sent.input, /rtx 5090 price[\s\S]*Market: en-US\. Search and answer for United States/);

  // Metered like every included call: the worst case first (searches included), then what it used.
  assert.equal(book.reserves.length, 1);
  assert.equal(book.reserves[0]!.model, "gpt-6-luna");
  assert.equal(book.reserves[0]!.purpose, "Web search");
  assert.ok((book.reserves[0]!.extraUsd ?? 0) >= 2 * WEB_SEARCH_CALL_USD, "the reservation covers the searches");
  assert.deepEqual(book.settles, [{ id: "res-1", usage: { inputTokens: 9000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 300 }, answeredBy: "gpt-6-luna", extraUsd: 2 * WEB_SEARCH_CALL_USD }]);
});

test("the searching model is the tier's when it can search, else GPT-6 Luna, else an OpenAI-host model", () => {
  const all = { models: [...(["gpt-6-luna", "deepseek-v4-flash", "gpt-6.1-sol", "grok-4.7"] as const)].map((id) => ({ id, api: id === "deepseek-v4-flash" ? "chat" : "responses", host: id.startsWith("gpt") ? "openai" : "services" })) } as never;
  assert.equal(includedSearchModel(all, { provider: INCLUDED_PROVIDER, model: "gpt-6.1-sol" })?.id, "gpt-6.1-sol");
  assert.equal(includedSearchModel(all, { provider: INCLUDED_PROVIDER, model: "deepseek-v4-flash" })?.id, "gpt-6-luna", "DeepSeek has no web_search tool");
  assert.equal(includedSearchModel(all, { provider: INCLUDED_PROVIDER, model: "grok-4.7" })?.id, "gpt-6-luna");
  const noLuna = { models: [{ id: "grok-4.7", api: "responses", host: "services" }, { id: "gpt-5-mini", api: "responses", host: "openai" }] } as never;
  assert.equal(includedSearchModel(noLuna, { provider: "claude-code", model: "default" })?.id, "gpt-5-mini");
  assert.equal(includedSearchModel({ models: [{ id: "grok-4.7", api: "responses", host: "services" }] } as never, null), null);
});

test("Foundry's answer without citations still counts its searches", () => {
  const found = fromWebSearchResponse({ output: [{ type: "web_search_call" }, { type: "message", content: [{ type: "output_text", text: "Nothing reliable found.", annotations: [] }] }] });
  assert.deepEqual(found, { hits: [], answer: "Nothing reliable found.", searches: 1 });
});

test("used-up included credits say so in the result, and a free web search answers instead", async () => {
  const seen = engines({ bing: () => new Response(BING_RSS, { status: 200, headers: { "content-type": "application/rss+xml" } }) });
  ledger({ refuse: new IncludedLimitError(INCLUDED_CREDITS_USED, "You've used this month's included credits. They reset on 1 November.") });
  const result = await search.run(ctx(), { query: "rtx 5090 price" });
  const data = result.data as { results: Array<{ url: string }>; provider: string; engine: string; note: string };
  assert.deepEqual([data.provider, data.engine], ["fallback", "bing"]);
  assert.match(data.note, /used this month's included credits[\s\S]*free web search instead/);
  assert.match(result.summary, /Found 2 source\(s\)\. You've used/);
  assert.ok(!seen.some((row) => row.url.includes("azure.com")), "Azure is never called past the limit");
});

test("Bing's RSS results come back without Bing's own links, for the market asked", async () => {
  const seen = engines({ bing: () => new Response(BING_RSS, { status: 200 }) });
  const found = await webSearchFrom("rtx 5090 price", { market: "en_us" });
  assert.equal(found.engine, "bing");
  assert.deepEqual(found.hits, [
    { title: "NVIDIA GeForce RTX 5090 & more - Best Buy", url: "https://www.bestbuy.com/site/rtx-5090", snippet: "Shop the RTX 5090 at Best Buy. Price $1,999.99." },
    { title: "RTX 5090 | Newegg", url: "https://www.newegg.com/p/rtx-5090", snippet: "Free shipping on the RTX 5090." },
  ]);
  const asked = new URL(seen[0]!.url);
  assert.deepEqual([asked.searchParams.get("format"), asked.searchParams.get("q"), asked.searchParams.get("mkt"), asked.searchParams.get("setlang")], ["rss", "rtx 5090 price", "en-US", "en-US"]);
  assert.match(seen[0]!.headers["user-agent"]!, /Chrome\/\d+/);
  assert.doesNotMatch(seen[0]!.headers["user-agent"]!, /Headless|Ensemble/);
});

test("the fallbacks go in order: Foundry fails, Bing fails, DuckDuckGo answers; with none, search is unavailable", async () => {
  ledger();
  let seen = engines({ azure: () => json({ error: { message: "busy" } }, 500), bing: () => new Response("", { status: 503 }), duck: () => new Response(DUCK_HTML, { status: 200 }) });
  const result = await search.run(ctx(), { query: "rtx 5090 price" });
  const data = result.data as { results: Array<{ title: string; url: string }>; provider: string; engine: string };
  assert.deepEqual(seen.map((row) => new URL(row.url).hostname), ["ensemble-ai.openai.azure.com", "www.bing.com", "html.duckduckgo.com"]);
  assert.deepEqual([data.provider, data.engine], ["fallback", "duckduckgo"]);
  assert.deepEqual(data.results.map((hit) => [hit.title, hit.url]), [["RTX 5090 - Micro Center", "https://www.microcenter.com/rtx-5090"]]);

  // A provider with its own grounding is not sent to Foundry; nothing answering means unavailable.
  seen = engines({});
  const none = await search.run(ctx("anthropic", "claude-sonnet-5"), { query: "rtx 5090 price" });
  assert.equal((none.data as { provider: string }).provider, "unavailable");
  assert.match(none.summary, /Web search is unavailable/);
  assert.ok(!seen.some((row) => row.url.includes("azure.com")));
});

test("a search Azure refused costs nothing; one stopped mid-way is charged its reservation", async () => {
  const book = ledger();
  engines({ azure: () => json({ error: { message: "bad request" } }, 400) });
  await assert.rejects(() => includedWebSearch("user-1", "rtx 5090"), /answered 400/);
  assert.deepEqual(book.settles.at(-1), { id: "res-1", usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }, answeredBy: "gpt-6-luna", extraUsd: 0 });

  const stop = new AbortController();
  engines({
    azure: () =>
      new Promise<Response>((_resolve, reject) => {
        stop.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
  });
  const pending = includedWebSearch("user-1", "rtx 5090", { signal: stop.signal });
  setTimeout(() => stop.abort(), 10);
  await assert.rejects(() => pending);
  const charged = book.settles.at(-1)!;
  assert.equal(charged.usage, null, "usage unknown: the reservation is charged");
  assert.equal(charged.extraUsd, book.reserves.at(-1)!.extraUsd);
});
