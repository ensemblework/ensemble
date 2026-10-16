/**
 * Page document helpers used by the store (docs/02).
 *
 * TipTap serialises mentions as `ensemble:` links. Restore them before save so
 * the mention index stays a lookup of nodes, not a scrape of hrefs.
 */
export { restoreMentionLinks, mentionHref, mentionQuery, dateMention, isEntityKind } from "@ensemble/shared-types";

/** Half of a character (a UTF-16 surrogate without its pair). */
export const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const LONE_SURROGATES = new RegExp(LONE_SURROGATE.source, "g");

/**
 * The value with every string one Postgres can store as JSON: no U+0000, and half characters
 * replaced by U+FFFD. Page saves pass content through it so one bad character never fails a save.
 */
export function storable<T>(value: T): T {
  if (typeof value === "string") return value.replace(/\u0000/g, "").replace(LONE_SURROGATES, "\uFFFD") as T;
  if (Array.isArray(value)) return value.map(storable) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, storable(item)])) as T;
  return value;
}
