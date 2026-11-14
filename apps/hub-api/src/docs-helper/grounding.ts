import { DOCS_HOME, type DocsIndex } from "@ensemble/docs/search";
import { z } from "zod";

const publishedUrl = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.origin === new URL(DOCS_HOME).origin && !url.username && !url.password;
});
const Index = z.object({ version: z.literal(1), pages: z.array(z.object({
  title: z.string().max(500), path: z.string().max(500),
  sections: z.array(z.object({ heading: z.string().max(500), url: publishedUrl, text: z.string().max(200_000) })).max(500),
})).min(1).max(200) });
export type Passage = { title: string; heading: string; url: string; text: string };
const STOP = new Set("a an the to of in on is are do does can could would should how what where when why i my me you your it this that with for and or from ensemble please tell about use using help want need have has".split(" "));
const words = (text: string) => [...new Set(text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])].filter((word) => !STOP.has(word));

/** Retrieve sentences around the question's terms, never a repository or caller-supplied context. */
export function retrieve(index: DocsIndex, question: string, minimumCoverage = 0.5): Passage[] {
  const terms = words(question);
  if (!terms.length) return [];
  const ranked = index.pages.flatMap((page) => page.sections.map((section) => {
    const heading = `${page.title} ${section.heading}`.toLowerCase();
    const body = section.text.toLowerCase();
    const matches = terms.filter((word) => `${heading} ${body}`.includes(word));
    const score = matches.reduce((n, word) => n + (heading.includes(word) ? 8 : 1), 0);
    const position = Math.max(0, body.indexOf(matches[0] ?? "") - 300);
    const relevant = matches.some((word) => `${section.heading.toLowerCase()} ${body}`.includes(word));
    return { ...section, title: page.title, relevant, text: section.text.slice(position, position + 2400), score, coverage: matches.length / terms.length };
  })).filter((hit) => hit.score && hit.relevant && hit.coverage >= minimumCoverage);
  ranked.sort((a, b) => b.coverage - a.coverage || b.score - a.score || a.url.localeCompare(b.url));
  return ranked.slice(0, 4).map(({ score, coverage, relevant, ...hit }) => hit);
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
