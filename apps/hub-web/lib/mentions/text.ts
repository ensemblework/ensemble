/**
 * Mentions in plain text boxes: find the `@token` at the caret, write the picked
 * mention back as text, and keep the ids of the mentions still in the text.
 */
import { mentionAlias, mentionQuery, mentionToken, type MentionKind, type PageMention } from "@ensemble/shared-types";

/** Characters that may come right before `@`. Anything else (`mira@fieldnote.example`) is not a mention. */
const BEFORE_AT = /[\s([{"'“‘]/;

export type MentionToken = {
  /** Index of the `@`. */
  at: number;
  /** What follows the `@` up to the caret. */
  query: string;
  /** The query has a space. Only a scoped one (`people:Anika R`) can, and only while its menu stays open. */
  spaced: boolean;
};

export function mentionAt(value: string, caret: number): MentionToken | null {
  const end = Math.min(Math.max(caret, 0), value.length);
  const at = value.lastIndexOf("@", end - 1);
  if (at < 0) return null;
  if (at > 0 && !BEFORE_AT.test(value[at - 1]!)) return null;
  const query = value.slice(at + 1, end);
  if (/[\n\r]/.test(query)) return null;
  if (!/\s/.test(query)) return { at, query, spaced: false };
  const colon = query.indexOf(":");
  if (colon < 0 || /\s/.test(query.slice(0, colon)) || !mentionQuery(query)) return null;
  return { at, query, spaced: true };
}

/**
 * Puts `text` where the token is. An unspaced token also loses the rest of its
 * word after the caret, so picking inside `@anu|reet` does not leave `reet`.
 */
export function replaceMention(value: string, token: MentionToken, caret: number, text: string): { value: string; caret: number } {
  let end = Math.min(Math.max(caret, token.at), value.length);
  if (!token.spaced) while (end < value.length && !/\s/.test(value[end]!)) end += 1;
  const rest = value.slice(end);
  if (text.endsWith(" ") && /^\s/.test(rest)) {
    const head = value.slice(0, token.at) + text.slice(0, -1);
    return { value: head + rest, caret: head.length + 1 };
  }
  const head = value.slice(0, token.at) + text;
  return { value: head + rest, caret: head.length };
}

/** The picked mentions whose `@kind:label` is still in the text, once each. */
export function keptMentions(text: string, picked: PageMention[]): PageMention[] {
  const kept = new Map<string, PageMention>();
  for (const mention of picked) {
    if (!text.includes(mentionToken(mention.kind, mention.label))) continue;
    kept.set(JSON.stringify([mention.kind, mention.id]), mention);
  }
  return [...kept.values()];
}

/** `@people:Priya Shah` becomes `Priya Shah`, for boxes that read names from plain text. */
export function plainMentions(text: string): string {
  return text.replace(/(^|[\s([{"'“‘])@([A-Za-z]+):/g, (whole, before: string, alias: string) => (mentionAlias(alias) ? before : whole));
}

/** A highlighted stretch of text: a picked mention, a bare `@people:` prefix, or the token being typed. */
export type MentionRange = { from: number; to: number; kind: MentionKind | null; mention?: PageMention };

const TOKEN = /(^|[\s([{"'“‘])@([A-Za-z]+):/g;
const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** The longest mention of `kind` written right at `start`, ignoring case; a date also matches its ISO day. */
function labelAt(text: string, start: number, kind: MentionKind, mentions: PageMention[]): { mention: PageMention; length: number } | null {
  let best: { mention: PageMention; length: number } | null = null;
  for (const mention of mentions) {
    if (mention.kind !== kind) continue;
    for (const name of kind === "date" ? [mention.label, mention.id] : [mention.label]) {
      if (!name || (best && best.length >= name.length)) continue;
      if (text.slice(start, start + name.length).toLowerCase() !== name.toLowerCase()) continue;
      if (WORD_CHAR.test(text[start + name.length] ?? "")) continue;
      best = { mention, length: name.length };
    }
  }
  return best;
}

/**
 * Where `@kind:Label` is written for one of `mentions`. Only exact labels count,
 * so an old message without saved mentions has none. `prefixes` also marks a
 * bare `@people:` whose label is not known, for a box being typed in.
 */
export function mentionRanges(text: string, mentions: PageMention[], options: { prefixes?: boolean } = {}): MentionRange[] {
  const ranges: MentionRange[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    const at = match.index! + match[1]!.length;
    const kind = at >= last ? mentionAlias(match[2]!) : null;
    if (!kind) continue;
    const start = at + match[2]!.length + 2;
    const found = labelAt(text, start, kind, mentions);
    if (found) ranges.push({ from: at, to: start + found.length, kind, mention: found.mention });
    else if (options.prefixes) ranges.push({ from: at, to: start, kind });
    else continue;
    last = ranges[ranges.length - 1]!.to;
  }
  return ranges;
}

/** A text box's highlights: picked mentions, bare prefixes, and the token being typed (`typing`, from its `@` to the caret). */
export function composerRanges(text: string, mentions: PageMention[], typing: { from: number; to: number } | null): MentionRange[] {
  const ranges = mentionRanges(text, mentions, { prefixes: true });
  if (!typing || typing.to <= typing.from) return ranges;
  const kind = mentionQuery(text.slice(typing.from + 1, typing.to))?.kind ?? mentionAlias(text.slice(typing.from + 1, typing.to));
  return [...ranges.filter((range) => range.to <= typing.from || range.from >= typing.to), { from: typing.from, to: typing.to, kind }].sort((a, b) => a.from - b.from);
}

/** `text` cut at the ranges, in order. */
export function splitAtRanges(text: string, ranges: MentionRange[]): Array<{ text: string; range: MentionRange | null }> {
  const pieces: Array<{ text: string; range: MentionRange | null }> = [];
  let last = 0;
  for (const range of ranges) {
    if (range.from < last) continue;
    if (range.from > last) pieces.push({ text: text.slice(last, range.from), range: null });
    pieces.push({ text: text.slice(range.from, range.to), range });
    last = range.to;
  }
  if (last < text.length) pieces.push({ text: text.slice(last), range: null });
  return pieces;
}
