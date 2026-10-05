/**
 * Read-only research tools: web search, paper search, reading a page.
 *
 * None of them needs a key. fetchUrl refuses private and loopback addresses,
 * so a prompt-injected page cannot point the agent at Ensemble's own API or the
 * home network.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 Ensemble";

export class ResearchError extends Error {}

function decode(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)));
}

const strip = (html: string) => decode(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

function privateAddress(address: string): boolean {
  if (address === "::1" || address.startsWith("fe80:") || address.startsWith("fc") || address.startsWith("fd")) return true;
  const v4 = address.replace(/^::ffff:/, "");
  const parts = v4.split(".").map(Number);
  if (parts.length !== 4) return false;
  const [a, b] = parts as [number, number, number, number];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

async function assertPublic(url: URL): Promise<void> {
  if (!["http:", "https:"].includes(url.protocol)) throw new ResearchError("Only http and https pages can be read.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) throw new ResearchError("Local addresses are off limits.");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((row) => row.address);
  if (addresses.some(privateAddress)) throw new ResearchError("That address is on a private network. The agent may only read public pages.");
}

async function get(url: string, signal?: AbortSignal, accept = "text/html,application/json,application/xml;q=0.9,*/*;q=0.5"): Promise<{ text: string; type: string; url: string }> {
  let current = new URL(url);
  for (let hop = 0; hop < 5; hop += 1) {
    await assertPublic(current);
    const response = await fetch(current, {
      headers: { "User-Agent": UA, Accept: accept },
      redirect: "manual",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      current = new URL(response.headers.get("location")!, current);
      continue;
    }
    if (!response.ok) throw new ResearchError(`${current.host} answered ${response.status}.`);
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      chunks.push(value);
      if (size > 3_000_000) {
        await reader.cancel();
        break;
      }
    }
    return { text: Buffer.concat(chunks).toString("utf8"), type: response.headers.get("content-type") ?? "", url: current.toString() };
  }
  throw new ResearchError("Too many redirects.");
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

async function webSearchOnce(query: string, endpoint: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const body = new URLSearchParams({ q: query, kl: "wt-wt" });
  const timeout = AbortSignal.timeout(12_000);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new ResearchError(`Web search is unavailable (${response.status}).`);
  const html = await response.text();
  const hits: SearchHit[] = [];
  const blocks = html.split(/<div class="result(?:s_links|__body)[^"]*"/).slice(1);
  for (const block of blocks) {
    const link = block.match(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    let href = decode(link[1]!);
    const wrapped = href.match(/[?&]uddg=([^&]+)/);
    if (wrapped) href = decodeURIComponent(wrapped[1]!);
    if (href.startsWith("//")) href = `https:${href}`;
    if (!href.startsWith("http") || href.includes("duckduckgo.com/y.js")) continue;
    const snippet = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td|span)>/);
    hits.push({ title: strip(link[2]!), url: href, snippet: snippet ? strip(snippet[1]!) : "" });
    if (hits.length >= 8) break;
  }
  if (!hits.length && /anomaly|captcha/i.test(html)) throw new ResearchError("Web search is unavailable.");
  return hits;
}

export async function webSearch(query: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const endpoints = ["https://html.duckduckgo.com/html/", "https://duckduckgo.com/html/"];
  let last: unknown;
  for (const endpoint of endpoints) {
    try {
      return await webSearchOnce(query, endpoint, signal);
    } catch (error) {
      last = error;
      if (signal?.aborted) throw error;
    }
  }
  const detail = last instanceof Error ? last.message : "fetch failed";
  throw new ResearchError(detail.toLowerCase().includes("unavailable") ? "Web search is unavailable." : "Web search is unavailable.");
}

export interface Paper {
  title: string;
  year: number | null;
  authors: string;
  venue: string;
  citations: number | null;
  url: string;
  abstract: string;
  source: "semantic_scholar" | "arxiv";
}

async function semanticScholar(query: string, limit: number, from?: number, to?: number, signal?: AbortSignal): Promise<Paper[]> {
  const params = new URLSearchParams({
    query,
    limit: String(limit),
    fields: "title,year,authors,venue,citationCount,url,abstract,externalIds",
  });
  if (from || to) params.set("year", `${from ?? ""}-${to ?? ""}`);
  const { text } = await get(`https://api.semanticscholar.org/graph/v1/paper/search?${params}`, signal, "application/json");
  const data = JSON.parse(text) as {
    data?: Array<{ title: string; year?: number; authors?: Array<{ name: string }>; venue?: string; citationCount?: number; url?: string; abstract?: string; externalIds?: { ArXiv?: string; DOI?: string } }>;
  };
  return (data.data ?? []).map((row) => ({
    title: row.title,
    year: row.year ?? null,
    authors: (row.authors ?? []).slice(0, 4).map((author) => author.name).join(", ") + ((row.authors?.length ?? 0) > 4 ? " et al." : ""),
    venue: row.venue ?? "",
    citations: row.citationCount ?? null,
    url: row.externalIds?.ArXiv ? `https://arxiv.org/abs/${row.externalIds.ArXiv}` : row.externalIds?.DOI ? `https://doi.org/${row.externalIds.DOI}` : row.url ?? "",
    abstract: (row.abstract ?? "").slice(0, 900),
    source: "semantic_scholar" as const,
  }));
}

async function arxiv(query: string, limit: number, from?: number, to?: number, signal?: AbortSignal): Promise<Paper[]> {
  const terms = query.split(/\s+/).filter(Boolean).map((word) => `all:${word}`).join("+AND+");
  const { text } = await get(`https://export.arxiv.org/api/query?search_query=${terms}&max_results=${limit * 2}&sortBy=relevance`, signal, "application/atom+xml");
  const entries = text.split("<entry>").slice(1);
  return entries
    .map((entry) => {
      const field = (name: string) => strip(entry.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1] ?? "");
      const year = Number(field("published").slice(0, 4)) || null;
      const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((match) => strip(match[1]!));
      return {
        title: field("title"),
        year,
        authors: authors.slice(0, 4).join(", ") + (authors.length > 4 ? " et al." : ""),
        venue: "arXiv",
        citations: null,
        url: field("id"),
        abstract: field("summary").slice(0, 900),
        source: "arxiv" as const,
      };
    })
    .filter((paper) => (!from || (paper.year ?? 0) >= from) && (!to || (paper.year ?? 9999) <= to))
    .slice(0, limit);
}

export async function searchPapers(query: string, options: { limit?: number; fromYear?: number; toYear?: number; signal?: AbortSignal } = {}): Promise<{ papers: Paper[]; notes: string[] }> {
  const limit = Math.min(Math.max(options.limit ?? 8, 1), 20);
  const notes: string[] = [];
  const [scholar, preprints] = await Promise.all([
    semanticScholar(query, limit, options.fromYear, options.toYear, options.signal).catch((error: Error) => {
      notes.push(`Semantic Scholar: ${error.message}`);
      return [] as Paper[];
    }),
    arxiv(query, limit, options.fromYear, options.toYear, options.signal).catch((error: Error) => {
      notes.push(`arXiv: ${error.message}`);
      return [] as Paper[];
    }),
  ]);
  const seen = new Set<string>();
  const papers = [...scholar, ...preprints].filter((paper) => {
    const key = paper.title.toLowerCase().replace(/\W+/g, "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { papers: papers.slice(0, limit * 2), notes };
}

export async function fetchUrl(url: string, signal?: AbortSignal): Promise<{ url: string; title: string; text: string; truncated: boolean }> {
  const page = await get(url, signal);
  let text = page.text;
  let title = "";
  if (page.type.includes("html") || /<html/i.test(text.slice(0, 500))) {
    title = strip(text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
    text = text
      .replace(/<(script|style|noscript|svg|nav|footer|header|form)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\/(p|div|h[1-6]|li|tr|section|article|br)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n");
    text = decode(text.replace(/<[^>]+>/g, " "))
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("\n");
  }
  const limit = 14_000;
  return { url: page.url, title, text: text.slice(0, limit), truncated: text.length > limit };
}
