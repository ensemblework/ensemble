/**
 * Spelling suggestions at the top of Ensemble's right-click menu (in the page editor and in titles).
 *
 * A web page cannot read the browser's own spell checker, so this uses the same kind of dictionary the
 * browsers ship: Hunspell's English one from SCOWL (public/spelling, en-US or en-GB by the browser's
 * language), read by nspell. It loads once per visit, when a page you can edit opens or a title is
 * focused, so a right-click has the answer at once and the menu never jumps. Only for English; other
 * languages keep the browser's menu one row away ("Browser menu"). Words someone ignores are kept on
 * this device.
 */
import { SpellCheck } from "lucide-react";
import type { MenuAction, MenuSection } from "./menu-store";

export type SpellChecker = { correct: (word: string) => boolean; suggest: (word: string) => string[]; add: (word: string) => unknown };
export type Dictionary = "en-us" | "en-gb";

const IGNORED_KEY = "ensemble.spelling.ignored";
const MAX_SUGGESTIONS = 5;
const RETRY_MS = 5 * 60_000;

let checker: SpellChecker | null = null;
let loading: Promise<void> | null = null;
let failedAt = 0;

/** The dictionary for the browser's language: US spelling for en-US (and plain en, Canada, the Philippines), British for the other English locales, none otherwise. */
export function spellingDictionary(languages: readonly string[] = typeof navigator === "undefined" ? [] : navigator.languages?.length ? navigator.languages : [navigator.language]): Dictionary | null {
  const first = (languages[0] ?? "").toLowerCase();
  if (first !== "en" && !first.startsWith("en-")) return null;
  return first === "en" || /^en-(us|ca|ph|pr|as|gu|um|vi|mp)\b/.test(first) ? "en-us" : "en-gb";
}

/** For tests, or once the dictionary has loaded. */
export function setSpellChecker(next: SpellChecker | null): void {
  checker = next;
  if (next) for (const word of ignoredWords()) next.add(word);
}

export const spellingReady = () => Boolean(checker);

/** Loads the dictionary in the background (once). Safe to call on every focus. */
export function warmSpelling(): void {
  if (checker || loading || typeof window === "undefined" || Date.now() - failedAt < RETRY_MS) return;
  const dictionary = spellingDictionary();
  if (!dictionary) return;
  const text = async (path: string) => {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return response.text();
  };
  loading = Promise.all([text(`/spelling/${dictionary}.aff`), text(`/spelling/${dictionary}.dic`), import("nspell")])
    .then(async ([aff, dic, module]) => {
      // Reading the word list takes a moment: do it while the page is idle.
      await new Promise<void>((resolve) => (window.requestIdleCallback ? window.requestIdleCallback(() => resolve(), { timeout: 3000 }) : window.setTimeout(resolve, 200)));
      setSpellChecker(module.default(aff, dic));
    })
    .catch(() => {
      failedAt = Date.now();
    })
    .finally(() => {
      loading = null;
    });
}

const LETTER = /[\p{L}\p{M}'’]/u;
const QUOTE = /['’]/;

/** The word at `offset` in `text` (a caret just after a word counts), or null where there is none to check. */
export function wordAt(text: string, offset: number): { start: number; end: number; word: string } | null {
  let start = Math.min(Math.max(offset, 0), text.length);
  let end = start;
  while (start > 0 && LETTER.test(text[start - 1]!)) start -= 1;
  while (end < text.length && LETTER.test(text[end]!)) end += 1;
  // Quotes around a word are not part of it; an apostrophe inside one is (don't).
  while (start < end && QUOTE.test(text[start]!)) start += 1;
  while (end > start && QUOTE.test(text[end - 1]!)) end -= 1;
  if (end - start < 2) return null;
  // Part of an address, a path, a handle, a file name or a code-like name: not a word.
  let tokenStart = start;
  let tokenEnd = end;
  while (tokenStart > 0 && !/\s/.test(text[tokenStart - 1]!)) tokenStart -= 1;
  while (tokenEnd < text.length && !/\s/.test(text[tokenEnd]!)) tokenEnd += 1;
  if (/[@/\\_#=<>{}[\]|~`\d]|:\/\/|\p{L}\.\p{L}/u.test(text.slice(tokenStart, tokenEnd))) return null;
  return { start, end, word: text.slice(start, end) };
}

/** Names with capitals inside (iPhone, APIs, McKinsey) and very long tokens are left alone, as browsers mostly do. */
export function checkable(word: string): boolean {
  return word.length >= 2 && word.length <= 40 && !/\p{Lu}/u.test(word.slice(1)) && /^[\p{L}\p{M}'’]+$/u.test(word);
}

/** Suggestions for a misspelled word (maybe none), or null when it is spelled right, ignored, or not checked. */
export function suggestionsFor(word: string): string[] | null {
  if (!checker || !checkable(word)) return null;
  const plain = word.replace(/’/g, "'");
  if (checker.correct(plain)) return null;
  const curly = word.includes("’");
  return checker
    .suggest(plain)
    .slice(0, MAX_SUGGESTIONS)
    .map((suggestion) => (curly ? suggestion.replace(/'/g, "’") : suggestion));
}

function ignoredWords(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(IGNORED_KEY) || "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

/** Stops suggesting for this word here, now and on later visits. */
export function ignoreSpelling(word: string): void {
  const plain = word.replace(/’/g, "'");
  checker?.add(plain);
  try {
    localStorage.setItem(IGNORED_KEY, JSON.stringify([plain, ...ignoredWords().filter((value) => value !== plain)].slice(0, 500)));
  } catch {
    // Private mode: ignored for this visit only.
  }
}

/** The menu's first section for a misspelled word: its suggestions (each replaces it) and Ignore. Null when there is nothing to say. */
export function spellingSection(word: string, replace: (next: string) => void): MenuSection | null {
  const suggestions = suggestionsFor(word);
  if (!suggestions) return null;
  const items: MenuAction[] = suggestions.length
    ? suggestions.map((suggestion, index) => ({ id: `spelling-${index}`, label: suggestion, keywords: word, strong: true, run: () => replace(suggestion) }))
    : [{ id: "spelling-none", label: "No suggestions", disabled: true }];
  items.push({ id: "spelling-ignore", label: "Ignore spelling", icon: SpellCheck, run: () => ignoreSpelling(word) });
  return { label: "Spelling", items };
}
