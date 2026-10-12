/**
 * Mentions in plain text boxes: find the `@token` at the caret, write the picked
 * mention back as text, and keep the ids of the mentions still in the text.
 */
import { mentionAlias, mentionQuery, mentionToken, type PageMention } from "@ensemble/shared-types";

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
