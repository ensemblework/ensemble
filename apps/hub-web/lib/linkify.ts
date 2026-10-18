/**
 * Addresses written as plain text: http(s) URLs, `www.` hosts and email
 * addresses. Only these become links, so `javascript:` or `data:` text stays text.
 */

export type TextPiece = { kind: "text"; text: string } | { kind: "link"; text: string; href: string };

const URL_CHAR = String.raw`[^\s<>"\x60\\]`;
const HOST = String.raw`[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}`;
const EMAIL = String.raw`[\w.%+-]+@${HOST}`;

/**
 * One address. The lookbehind keeps it to the start of a word, so `x@y.com` is
 * one email and not a `y.com` inside it. Needs the `u` flag.
 */
export const ADDRESS_SOURCE = String.raw`(?<![\p{L}\p{N}_/@.+%-])(?:https?:\/\/${URL_CHAR}+|www\.[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+${URL_CHAR}*|mailto:${EMAIL}|${EMAIL})`;

const TRAILING = /[.,;:!?'"”’»…。，、*_~]/;
const OPENER: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

const count = (text: string, char: string) => text.split(char).length - 1;

/** Drops sentence punctuation and an unbalanced closing bracket from the end: `(see https://a.com/x_(y)).` keeps `https://a.com/x_(y)`. */
export function trimAddress(raw: string): string {
  let text = raw;
  for (;;) {
    const last = text[text.length - 1];
    if (!last) return text;
    if (TRAILING.test(last)) {
      text = text.slice(0, -1);
      continue;
    }
    const opener = OPENER[last];
    if (opener && count(text, last) > count(text, opener)) {
      text = text.slice(0, -1);
      continue;
    }
    return text;
  }
}

/** The link for a matched address, trimmed, or null when nothing linkable is left. */
export function addressLink(raw: string): { text: string; href: string } | null {
  const text = trimAddress(raw);
  if (/^https?:\/\//i.test(text)) return /^https?:\/\/[\p{L}\p{N}[]/iu.test(text) ? { text, href: text } : null;
  if (/^www\./i.test(text)) return /^www\.[\p{L}\p{N}-]+\.[\p{L}\p{N}]/iu.test(text) ? { text, href: `https://${text}` } : null;
  if (/^mailto:/i.test(text)) return text.includes("@") ? { text, href: text } : null;
  return new RegExp(`^${EMAIL}$`, "u").test(text) ? { text, href: `mailto:${text}` } : null;
}

/** Text split into plain runs and links. */
export function linkPieces(text: string): TextPiece[] {
  const pieces: TextPiece[] = [];
  const pattern = new RegExp(ADDRESS_SOURCE, "giu");
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const link = addressLink(match[0]);
    if (!link) continue;
    if (match.index > last) pieces.push({ kind: "text", text: text.slice(last, match.index) });
    pieces.push({ kind: "link", ...link });
    last = match.index + link.text.length;
    pattern.lastIndex = last;
  }
  if (last < text.length) pieces.push({ kind: "text", text: text.slice(last) });
  return pieces;
}

/** An address that leaves the app: it opens in a new tab. In-app paths stay in this tab. */
export function isExternalHref(href: string): boolean {
  return !(href.startsWith("/") && !href.startsWith("//"));
}
