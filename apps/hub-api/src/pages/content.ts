/**
 * Page document helpers used by the store (docs/02).
 *
 * TipTap serialises mentions as `ensemble:` links. Restore them before save so
 * the mention index stays a lookup of nodes, not a scrape of hrefs.
 */
export { restoreMentionLinks, mentionHref, mentionQuery, dateMention, isEntityKind } from "@ensemble/shared-types";
