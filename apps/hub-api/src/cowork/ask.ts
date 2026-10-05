/** Ask Ensemble composes a short answer from search hits. The hits are the sources. */

const STOP = new Set(
  "a an the what who when where why how did do does is are was were said say summarize about me my to of for in on with and or still this that from your".split(
    " ",
  ),
);

export interface AskSource {
  id: string;
  kind: string;
  label: string;
  excerpt: string;
  url: string;
  path: string;
}

export function searchTerms(question: string): string[] {
  const quoted = [...question.matchAll(/"([^"]+)"/g)].map((match) => match[1]!.trim()).filter(Boolean);
  const words = question
    .replace(/"[^"]+"/g, " ")
    .split(/[^\p{L}\p{N}]+/u)
    .map((word) => word.trim())
    .filter((word) => word.length >= 3 && !STOP.has(word.toLowerCase()));
  const terms: string[] = [];
  for (const term of [...quoted, ...words]) {
    if (!terms.some((have) => have.toLowerCase() === term.toLowerCase())) terms.push(term);
  }
  return terms.slice(0, 5);
}

export function pathFromHubUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url.startsWith("/") ? url : `/${url}`;
  }
}

export function composeAskAnswer(question: string, sources: AskSource[]): { answer: string; sources: AskSource[] } {
  const unique: AskSource[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const key = `${source.kind}:${source.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(source);
  }
  const top = unique.slice(0, 8);
  const asked = question.trim();
  if (!top.length) return { answer: `I couldn't find “${asked}” in your Ensemble data.`, sources: [] };
  const first = top[0]!;
  const lead = top.length === 1 ? `The closest match is “${first.label}”.` : `I found ${top.length} matches. The closest is “${first.label}”.`;
  const extra = first.excerpt && first.excerpt !== first.label ? ` ${first.excerpt}` : "";
  return { answer: `${lead}${extra}`.trim(), sources: top };
}
