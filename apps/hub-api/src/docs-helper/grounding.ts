import { DOCS_HOME, type DocsIndex } from "@ensemble/docs/search";
import { z } from "zod";

const publishedUrl = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.origin === new URL(DOCS_HOME).origin && !url.username && !url.password;
});
const Index = z.object({ version: z.literal(1), audience: z.literal("public"), pages: z.array(z.object({
  title: z.string().max(500), path: z.string().max(500),
  sections: z.array(z.object({ heading: z.string().max(500), url: publishedUrl, text: z.string().max(200_000) })).max(500),
})).min(1).max(2000) });
export type Passage = { title: string; heading: string; url: string; text: string };
const STOP = new Set("a an the to of in on is are do does can could would should how what where when why i my me you your it this that with for and or from ensemble please tell about use using help want need have has get each many much".split(" "));
const forms: Record<string, string> = {
  maximum: "limit", max: "limit", largest: "limit", caps: "limit", cap: "limit", limits: "limit", limited: "limit",
  connecting: "connect", connections: "connect", connection: "connect", connected: "connect", connects: "connect",
  sharing: "share", shared: "share", shares: "share", creating: "create", creation: "create", created: "create",
  files: "file", apps: "app", connectors: "connect", connector: "connect", tasks: "task", pages: "page", spaces: "space", credits: "credit", models: "model",
};
function words(text: string): string[] {
  return (text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((word) => !STOP.has(word)).map((word) => forms[word] ?? word);
}

type Chunk = Passage & { body: string[]; headingWords: Set<string>; titleWords: Set<string> };
const prepared = new WeakMap<DocsIndex, { chunks: Chunk[]; frequency: Map<string, number> }>();
function prepare(index: DocsIndex) {
  const cached = prepared.get(index);
  if (cached) return cached;
  const chunks: Chunk[] = [];
  const frequency = new Map<string, number>();
  for (const page of index.pages) {
    const pageWords = new Set<string>();
    for (const section of page.sections) {
      const headingWords = new Set(words(section.heading));
      const titleWords = new Set(words(page.title));
      // Rank the text we can actually send. Overlapping windows preserve surrounding table values.
      for (let start = 0; start < section.text.length;) {
        let end = Math.min(section.text.length, start + 2200);
        if (end < section.text.length) end = section.text.lastIndexOf(" ", end);
        const text = section.text.slice(start, end);
        const body = words(text);
        for (const word of [...body, ...headingWords, ...titleWords]) pageWords.add(word);
        chunks.push({ title: page.title, heading: section.heading, url: section.url, text, body, headingWords, titleWords });
        if (end >= section.text.length) break;
        start = Math.max(start + 1, section.text.indexOf(" ", Math.max(start + 1, end - 350)) + 1);
      }
    }
    for (const word of pageWords) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  }
  const result = { chunks, frequency };
  prepared.set(index, result);
  return result;
}

/** Word and phrase retrieval over published chunks; no source-code or external-page lookup. */
export function retrieve(index: DocsIndex, question: string, minimumCoverage = 0.5): Passage[] {
  const terms = [...new Set(words(question))];
  if (!terms.length) return [];
  const { chunks, frequency } = prepare(index);
  const phrase = terms.join(" ");
  const literalTerms = question.toLowerCase().match(/[\p{L}\p{N}_]+/gu)?.filter((word) => !STOP.has(word)) ?? [];
  const ranked = chunks.map((chunk) => {
    const counts = new Map<string, number>();
    for (const word of chunk.body) counts.set(word, (counts.get(word) ?? 0) + 1);
    const matches = terms.filter((word) => counts.has(word) || chunk.headingWords.has(word) || chunk.titleWords.has(word));
    const relevant = terms.some((word) => counts.has(word) || chunk.headingWords.has(word));
    let score = matches.reduce((sum, word) => {
      const idf = 1 + Math.log(1 + index.pages.length / (1 + (frequency.get(word) ?? 0)));
      const tf = counts.get(word) ?? 0;
      const body = tf ? tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * chunk.body.length / 250)) : 0;
      return sum + idf * (body + (chunk.headingWords.has(word) ? 5 : 0) + (chunk.titleWords.has(word) ? 1 : 0));
    }, 0);
    if (words(chunk.heading).join(" ") === phrase) score += 50;
    const literalHeading = chunk.heading.toLowerCase().match(/[\p{L}\p{N}_]+/gu)?.filter((word) => !STOP.has(word)) ?? [];
    if (literalTerms.join(" ") === literalHeading.join(" ")) score += 30;
    if (terms.length > 1 && chunk.body.join(" ").includes(phrase)) score += 8;
    return { chunk, score, coverage: matches.length / terms.length, relevant };
  }).filter((hit) => hit.relevant && hit.coverage >= minimumCoverage);
  ranked.sort((a, b) => b.score - a.score || b.coverage - a.coverage || a.chunk.url.localeCompare(b.chunk.url));
  const seen = new Set<string>();
  const results: Passage[] = [];
  for (const { chunk } of ranked) {
    if (seen.has(chunk.url)) continue;
    seen.add(chunk.url);
    const { body, headingWords, titleWords, ...passage } = chunk;
    results.push(passage);
    if (results.length === 4) break;
  }
  return results;
}

export function documentationIndex(fetcher: typeof fetch = fetch) {
  let cached: { index: DocsIndex; until: number } | undefined;
  let pending: Promise<DocsIndex> | undefined;
  return async (): Promise<DocsIndex> => {
    if (cached && cached.until > Date.now()) return cached.index;
    pending ??= (async () => {
      const response = await fetcher(`${DOCS_HOME}search-index.json`, { redirect: "error", signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
      if (!response.ok) throw new Error("Documentation unavailable");
      // Bound decompressed bytes too; content-length alone does not bound a compressed index.
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Documentation unavailable");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 8_000_000) throw new Error("Documentation too large");
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      const index = Index.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      cached = { index, until: Date.now() + 60_000 };
      return index;
    })().finally(() => { pending = undefined; });
    return pending;
  };
}
