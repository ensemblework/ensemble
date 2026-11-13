import { DOCS_HOME, searchDocs, type DocsIndex } from "@ensemble/docs/search";
import { z } from "zod";

const publishedUrl = z.string().url().refine((value) => new URL(value).origin === new URL(DOCS_HOME).origin);
const Index = z.object({
  version: z.literal(1),
  pages: z.array(z.object({
    title: z.string(),
    path: z.string(),
    sections: z.array(z.object({ heading: z.string(), url: publishedUrl, text: z.string() })),
  })).min(1),
});

export function publishedDocs(fetcher: typeof fetch = (input, init) => fetch(input, init)) {
  let cached: { index: DocsIndex; expires: number } | undefined;
  let pending: Promise<DocsIndex> | undefined;
  const load = async () => {
    try {
      const response = await fetcher(`${DOCS_HOME}search-index.json`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
      if (!response.ok) throw new Error(`Documentation index returned HTTP ${response.status}.`);
      const index = Index.parse(await response.json());
      cached = { index, expires: Date.now() + 60_000 };
      return index;
    } catch (cause) {
      throw Object.assign(new Error(`Published documentation could not be loaded. Open ${DOCS_HOME} or try again.`, { cause }), { statusCode: 503, expose: true });
    }
  };
  return async (query: string, limit?: number) => {
    if (cached && cached.expires > Date.now()) return searchDocs(cached.index, query, limit);
    pending ??= load().finally(() => { pending = undefined; });
    return searchDocs(await pending, query, limit);
  };
}
