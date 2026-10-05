/** Provider-native web grounding. An empty list means the Hub should use its fallback search. */
import { resolveCredential } from "./credentials.js";
import { ModelAuthError } from "./errors.js";

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
