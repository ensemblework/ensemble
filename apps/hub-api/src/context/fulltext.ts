/**
 * Full-text matching for a node turn's context (docs/35 §5.6): the words of a request as Postgres text
 * search terms, the same on the server's Postgres and the desktop's PGlite. Each word is an exact lexeme
 * under the `simple` configuration (lower case, no stemming, any language); a word of `prefixFrom`
 * letters or more also matches by its first letters (`deployment` adds `deploym:*`), so plurals and
 * other endings still match. Ranks come from `ts_rank` in the queries that use these.
 */
import { STOPWORDS } from "../workspace/session-choice/text.js";

const WORD = /[\p{L}\p{N}]+/gu;

/** The request's distinct meaningful words, lower case, in the order written, at most `max`. */
export function queryTerms(text: string, max = 16): string[] {
  const words = (text.toLowerCase().replace(/['’]/g, "").match(WORD) ?? []).filter((word) => [...word].length > 1 && [...word].length <= 40);
  const kept = words.filter((word) => !STOPWORDS.has(word) && !/^\d{1,2}$/.test(word));
  return [...new Set(kept)].slice(0, max);
}

/** The letters a long word also matches by: its first max(4, length − 3) letters. */
export function prefixOf(term: string, prefixFrom = 6): string | null {
  const letters = [...term];
  return letters.length >= prefixFrom ? letters.slice(0, Math.max(4, letters.length - 3)).join("") : null;
}

/** `to_tsquery('simple', …)` text matching any of the terms (OR), or null when there are none. */
export function tsQuery(terms: readonly string[], prefixFrom = 6): string | null {
  const parts = new Set<string>();
  for (const term of terms) {
    parts.add(term);
    const prefix = prefixOf(term, prefixFrom);
    if (prefix) parts.add(`${prefix}:*`);
  }
  return parts.size ? [...parts].join(" | ") : null;
}

/** ILIKE patterns that every match of the query also matches: a cheap filter before ranking. */
export function likePatterns(terms: readonly string[], prefixFrom = 6): string[] {
  return [...new Set(terms.map((term) => `%${prefixOf(term, prefixFrom) ?? term}%`))];
}

type Wanted = { term: string; prefix: string | null };
const wanted = (terms: readonly string[], prefixFrom: number): Wanted[] => terms.map((term) => ({ term, prefix: prefixOf(term, prefixFrom) }));
/** The term a word matches as `to_tsquery` does: the word itself, or a word that starts with the term's prefix. */
const matching = (word: string, list: readonly Wanted[]) => list.find(({ term, prefix }) => word === term || (prefix !== null && word.startsWith(prefix)))?.term;

/** The terms `text` contains (as the query matches them): an item's share of the request's words. */
export function termsIn(text: string, terms: readonly string[], prefixFrom = 6): Set<string> {
  const list = wanted(terms, prefixFrom);
  const found = new Set<string>();
  for (const word of new Set(text.toLowerCase().match(WORD) ?? [])) {
    for (const { term, prefix } of list) if (word === term || (prefix !== null && word.startsWith(prefix))) found.add(term);
    if (found.size === list.length) break;
  }
  return found;
}

/**
 * Where in `text` the most different terms come together within `width` characters (the closest together
 * first, then the first such place), and the length of the word there; null when no term is there.
 */
export function bestMatch(text: string, terms: readonly string[], prefixFrom = 6, width = 120): { at: number; length: number } | null {
  const list = wanted(terms, prefixFrom);
  const hits: Array<{ at: number; length: number; term: string }> = [];
  for (const match of text.matchAll(WORD)) {
    const term = matching(match[0].toLowerCase(), list);
    if (term) hits.push({ at: match.index ?? 0, length: match[0].length, term });
    if (hits.length >= 2_000) break;
  }
  let best: { at: number; length: number; count: number; span: number } | null = null;
  for (let first = 0; first < hits.length; first += 1) {
    const seen = new Set<string>();
    let span = 0;
    for (let next = first; next < hits.length && hits[next]!.at - hits[first]!.at <= width; next += 1) {
      if (seen.has(hits[next]!.term)) continue;
      seen.add(hits[next]!.term);
      span = hits[next]!.at - hits[first]!.at;
    }
    if (!best || seen.size > best.count || (seen.size === best.count && span < best.span)) best = { at: hits[first]!.at, length: hits[first]!.length, count: seen.size, span };
  }
  return best && { at: best.at, length: best.length };
}
