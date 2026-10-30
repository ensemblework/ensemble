/**
 * Provider-native web grounding. An empty list means the Hub should use its fallback search. Included
 * models search with Azure Foundry's hosted web_search tool on the account's included credits
 * (`includedWebSearch`); hub_web_search (assistant/tools/graph.ts) picks the path.
 */
import { INCLUDED_PROVIDER, type IncludedModel } from "@ensemble/shared-types";
import { reserveIncluded, settleIncluded } from "../included/budget.js";
import { includedConfig, openaiBase, type IncludedConfig } from "../included/config.js";
import { onDevice } from "../included/device.js";
import { WEB_SEARCH_CALL_USD, type IncludedTokens } from "../included/pricing.js";
import { resolveCredential } from "./credentials.js";
import { ModelAuthError } from "./errors.js";
import { estimateInputTokens, responsesUsage } from "./included.js";
import { pace } from "./pace.js";

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

let fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis);

export function setSearchFetchForTests(fetchFn: typeof fetch | null): void {
  fetchImpl = fetchFn ?? globalThis.fetch.bind(globalThis);
}

export async function groundedSearch(userId: string | null | undefined, provider: string, model: string, query: string): Promise<SearchHit[]> {
  const name = provider || "google";
  if (name === "google") return gemini(userId, model, query);
  if (name === "openai") return openai(userId, model, query);
  if (name === "anthropic") return anthropic(userId, model, query);
  return [];
}

async function gemini(userId: string | null | undefined, model: string, query: string): Promise<SearchHit[]> {
  const cred = await resolveCredential(userId, "google");
  if (!cred.secret) throw new ModelAuthError("No key for google.");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const payload = { contents: [{ role: "user", parts: [{ text: query }] }], tools: [{ google_search: {} }] };
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "x-goog-api-key": cred.secret, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw error;
  }
  if (!response.ok) return [];
  const data = (await response.json()) as {
    candidates?: Array<{ groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string; title?: string } }> } }>;
  };
  const chunks = data.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  const results: SearchHit[] = [];
  for (const chunk of chunks) {
    const uri = chunk.web?.uri;
    if (!uri) continue;
    results.push({ title: chunk.web?.title || uri, url: uri, snippet: "" });
  }
  return results.slice(0, 8);
}

async function openai(userId: string | null | undefined, model: string, query: string): Promise<SearchHit[]> {
  const cred = await resolveCredential(userId, "openai");
  if (!cred.secret) return [];
  const response = await fetchImpl("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${cred.secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, tools: [{ type: "web_search_preview" }], input: query }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) return [];
  const data = (await response.json()) as {
    output?: Array<{ type?: string; content?: Array<{ annotations?: Array<{ url?: string; title?: string }> }> }>;
  };
  const results: SearchHit[] = [];
  for (const item of data.output ?? []) {
    if (item.type !== "message") continue;
    for (const block of item.content ?? []) {
      for (const annotation of block.annotations ?? []) {
        if (annotation.url) results.push({ title: annotation.title || annotation.url, url: annotation.url, snippet: "" });
      }
    }
  }
  return results.slice(0, 8);
}

async function anthropic(userId: string | null | undefined, model: string, query: string): Promise<SearchHit[]> {
  const cred = await resolveCredential(userId, "anthropic");
  if (!cred.secret) return [];
  const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": cred.secret, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 800,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
      messages: [{ role: "user", content: query }],
    }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) return [];
  const data = (await response.json()) as { content?: Array<{ type?: string; content?: Array<{ url?: string; title?: string; page_age?: string }> }> };
  const results: SearchHit[] = [];
  for (const block of data.content ?? []) {
    if (block.type !== "web_search_tool_result") continue;
    for (const item of block.content ?? []) {
      if (item.url) results.push({ title: item.title || item.url, url: item.url, snippet: item.page_age || "" });
    }
  }
  return results.slice(0, 8);
}

// ── Included models: Azure Foundry's web_search tool ────────────────────────────────────────────

/** What an included web search found: its sources, the model's answer from them, and what it cost. */
export type GroundedAnswer = { hits: SearchHit[]; answer: string; model: string; searches: number; credits: number | null };

/** Included models that take the hosted web_search tool: OpenAI's, on the Responses API of the OpenAI host. */
const searchable = (model: IncludedModel) => model.api === "responses" && model.host === "openai";

/** The model that searches: the person's tier model when it is an included model that can, else GPT-6 Luna, else the first that can. */
export function includedSearchModel(config: Pick<IncludedConfig, "models">, tier?: { provider: string; model: string } | null): IncludedModel | null {
  const own = tier?.provider === INCLUDED_PROVIDER ? config.models.find((model) => model.id === tier.model) : undefined;
  if (own && searchable(own)) return own;
  return config.models.find((model) => model.id === "gpt-6-luna") ?? config.models.find(searchable) ?? null;
}

const SEARCH_OUTPUT_TOKENS = 1500;
const SEARCH_TIMEOUT_MS = 30_000;
/** The searches one answer is reserved for (web_search calls are billed each); more are charged as they come. */
const SEARCHES_RESERVED = 5;
/** Input tokens reserved for the pages each search reads. */
const SEARCH_CONTENT_TOKENS = 12_000;
const NO_USAGE: IncludedTokens = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };

/** “United States” for en-US; the market itself when it names no country. */
function marketPlace(market: string): string {
  const region = market.split("-")[1];
  if (!region) return market;
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(region.toUpperCase()) ?? market;
  } catch {
    return market;
  }
}

function searchInput(query: string, market?: string | null): string {
  return [
    `Search the web for: ${query}`,
    market ? `Market: ${market}. Search and answer for ${marketPlace(market)}: its stores, prices, currency and language.` : "",
    "Answer briefly with the facts you found, and cite each source.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** A search engine's tracking parameter on a cited link, which tells the reader nothing. */
function cleanUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("utm_source");
    return parsed.toString();
  } catch {
    return url;
  }
}

/** The sentence a citation closes, without the citation's own link text. */
function sentenceBefore(text: string, start: unknown): string {
  if (typeof start !== "number" || start <= 0 || start > text.length) return "";
  const before = text.slice(0, start);
  const from = Math.max(before.lastIndexOf(". "), before.lastIndexOf("\n"), before.lastIndexOf("? "), before.lastIndexOf("! "));
  const sentence = before
    .slice(from + 1)
    .replace(/\(\[[^\]]*\]\([^)]*\)\)?/g, "")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s(]+$/, "");
  return sentence.length > 300 ? `${sentence.slice(0, 299)}…` : sentence;
}

type Json = Record<string, unknown>;
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.filter((item): item is Json => Boolean(item) && typeof item === "object") : []);

/** The sources a Responses answer cites (its url_citation annotations), its text, and how many searches it ran. */
export function fromWebSearchResponse(data: Json): { hits: SearchHit[]; answer: string; searches: number } {
  const hits: SearchHit[] = [];
  const texts: string[] = [];
  let searches = 0;
  for (const item of list(data.output)) {
    if (item.type === "web_search_call") searches += 1;
    if (item.type !== "message") continue;
    for (const part of list(item.content)) {
      if (part.type !== "output_text" && part.type !== "text") continue;
      const text = String(part.text ?? "");
      texts.push(text);
      for (const note of list(part.annotations)) {
        if (note.type !== "url_citation" || typeof note.url !== "string" || !/^https?:\/\//i.test(note.url)) continue;
        const url = cleanUrl(note.url);
        if (hits.some((hit) => hit.url === url)) continue;
        hits.push({ title: typeof note.title === "string" && note.title.trim() ? note.title.trim() : url, url, snippet: sentenceBefore(text, note.start_index) });
      }
    }
  }
  return { hits: hits.slice(0, 8), answer: texts.join("\n").trim().slice(0, 3000), searches };
}

/**
 * One web search on an included model (Azure Foundry's Responses API with the hosted web_search tool),
 * on the account's included credits: its worst case is reserved first, and its tokens and searches
 * are settled after. Null when this server has no included model that can search (or on a computer,
 * which holds no Azure key). An IncludedLimitError (credits used, paused) is the caller's to explain.
 */
export async function includedWebSearch(
  userId: string,
  query: string,
  options: { tier?: { provider: string; model: string } | null; market?: string | null; signal?: AbortSignal } = {},
): Promise<GroundedAnswer | null> {
  if (onDevice()) return null;
  const config = includedConfig();
  const entry = config ? includedSearchModel(config, options.tier) : null;
  if (!config || !entry) return null;
  const request: Json = {
    model: entry.id,
    tools: [{ type: "web_search" }],
    input: searchInput(query, options.market),
    max_output_tokens: SEARCH_OUTPUT_TOKENS,
    ...(entry.efforts.includes("low") ? { reasoning: { effort: "low" } } : {}),
  };
  await pace(userId, INCLUDED_PROVIDER);
  const reservation = await reserveIncluded({
    userId,
    model: entry.id,
    inputTokens: estimateInputTokens(request) + SEARCHES_RESERVED * SEARCH_CONTENT_TOKENS,
    maxOutputTokens: SEARCH_OUTPUT_TOKENS,
    purpose: "Web search",
    extraUsd: SEARCHES_RESERVED * WEB_SEARCH_CALL_USD,
  });
  const settle = async (usage: IncludedTokens | null, searches: number) => {
    try {
      return (await settleIncluded({ id: reservation.id, usage, answeredBy: entry.id, extraUsd: searches * WEB_SEARCH_CALL_USD })).credits;
    } catch (error) {
      console.warn(`included web search settle of ${reservation.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };
  const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(`${openaiBase(config.resource, entry.host)}/responses`, {
      method: "POST",
      headers: { "api-key": config.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
  } catch (error) {
    // Stopped while Azure may have run it: the reservation is charged. Never sent: nothing is.
    const stopped = options.signal?.aborted || timeout.aborted;
    await settle(stopped ? null : NO_USAGE, stopped ? SEARCHES_RESERVED : 0);
    throw error;
  }
  if (!response.ok) {
    // Azure refused it: nothing was billed.
    await settle(NO_USAGE, 0);
    throw new Error(`Included web search answered ${response.status}.`);
  }
  let data: Json;
  try {
    data = (await response.json()) as Json;
  } catch (error) {
    await settle(null, SEARCHES_RESERVED);
    throw error;
  }
  const found = fromWebSearchResponse(data);
  const credits = await settle(responsesUsage(data.usage), found.searches);
  return { ...found, model: entry.id, credits };
}
