/**
 * Code's quick open (`components/code/quick-open.tsx`, docs/16 §1): what the typed text asks for, fuzzy
 * matching of file paths and command names as VS Code does it, and shortcuts written the way this
 * platform writes them (⇧⌘P on a Mac, Ctrl+Shift+P elsewhere).
 */

export type QuickInput =
  | { mode: "files"; query: string; line: number | null }
  | { mode: "commands"; query: string }
  | { mode: "line"; line: number | null };

/** `>` lists commands, `:` goes to a line, anything else finds a file (`name.ts:12` opens it at line 12). */
export function parseQuickInput(text: string): QuickInput {
  if (text.startsWith(">")) return { mode: "commands", query: text.slice(1).trim() };
  if (text.startsWith(":")) {
    const line = Number.parseInt(text.slice(1).trim(), 10);
    return { mode: "line", line: Number.isFinite(line) && line > 0 ? line : null };
  }
  const at = /^(.*?):(\d+)(?::\d+)?$/.exec(text.trim());
  if (at && at[1]) return { mode: "files", query: at[1].trim(), line: Number(at[2]) || null };
  return { mode: "files", query: text.trim(), line: null };
}

export type FuzzyMatch = { score: number; hits: number[] };

const BOUNDARY = new Set(["/", "\\", ".", "_", "-", " ", "(", "[", ":"]);

function isBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  const before = text[index - 1]!;
  if (BOUNDARY.has(before)) return true;
  const here = text[index]!;
  return before === before.toLowerCase() && here !== here.toLowerCase() && here === here.toUpperCase();
}

/** The query's characters in order, from `start`; null when they are not all there. */
function walk(lower: string, needle: string, start: number): number[] | null {
  const hits: number[] = [];
  let at = start;
  for (const char of needle) {
    const found = lower.indexOf(char, at);
    if (found < 0) return null;
    hits.push(found);
    at = found + 1;
  }
  return hits;
}

/**
 * Whether every character of `query` appears in `text` in order (case does not matter), and how well:
 * runs of characters, the start of a word or of the file name, and matching the name rather than its
 * folder score higher. `nameStart`: where the file name begins in a path.
 */
export function fuzzyMatch(query: string, text: string, nameStart = 0): FuzzyMatch | null {
  const needle = query.replace(/\s+/g, "").toLowerCase();
  if (!needle) return { score: 0, hits: [] };
  const lower = text.toLowerCase();
  let best: FuzzyMatch | null = null;
  // Try a few starting points so "ext" prefers "extensions.ts" over the first "e" in the path.
  const starts: number[] = [];
  for (let at = lower.indexOf(needle[0]!); at >= 0 && starts.length < 8; at = lower.indexOf(needle[0]!, at + 1)) starts.push(at);
  for (const start of starts) {
    const hits = walk(lower, needle, start);
    if (!hits) break;
    let score = 0;
    hits.forEach((index, n) => {
      score += 1;
      if (text[index] === query.replace(/\s+/g, "")[n]) score += 0.5;
      if (n > 0 && index === hits[n - 1]! + 1) score += 5;
      if (isBoundary(text, index)) score += 8;
      if (index === nameStart) score += 10;
    });
    if (hits[0]! >= nameStart) score += 20;
    const name = lower.slice(nameStart);
    if (name === needle) score += 100;
    else if (name.startsWith(needle)) score += 30;
    score -= (hits[hits.length - 1]! - hits[0]!) * 0.15;
    score -= text.length * 0.02;
    if (!best || score > best.score) best = { score, hits };
  }
  return best;
}

export type FileHit = { path: string; score: number; nameHits: number[]; folderHits: number[] };

/** Files whose path matches `query`, best first, at most `limit`. */
export function rankFiles(query: string, files: readonly string[], limit = 50): FileHit[] {
  if (!query.replace(/\s+/g, "")) return [];
  const rows: FileHit[] = [];
  for (const path of files) {
    const nameStart = path.lastIndexOf("/") + 1;
    const match = fuzzyMatch(query, path, nameStart);
    if (!match) continue;
    rows.push({
      path,
      score: match.score,
      nameHits: match.hits.filter((index) => index >= nameStart).map((index) => index - nameStart),
      folderHits: match.hits.filter((index) => index < nameStart),
    });
  }
  rows.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
  return rows.slice(0, limit);
}

/** Items whose label matches `query`, best first; all of them, in their own order, for an empty query. */
export function rankByLabel<T extends { label: string }>(query: string, items: readonly T[]): Array<T & { hits: number[] }> {
  if (!query.replace(/\s+/g, "")) return items.map((item) => ({ ...item, hits: [] }));
  return items
    .map((item, order) => ({ item, order, match: fuzzyMatch(query, item.label) }))
    .filter((row): row is { item: T; order: number; match: FuzzyMatch } => Boolean(row.match))
    .sort((a, b) => b.match.score - a.match.score || a.order - b.order)
    .map((row) => ({ ...row.item, hits: row.match.hits }));
}

const MAC_MODS: Record<string, string> = { ctrl: "⌃", alt: "⌥", shift: "⇧", mod: "⌘", meta: "⌘" };
const PC_MODS: Record<string, string> = { ctrl: "Ctrl", mod: "Ctrl", meta: "Win", alt: "Alt", shift: "Shift" };
const MOD_ORDER = ["ctrl", "mod", "meta", "alt", "shift"];
const MAC_ORDER = ["ctrl", "alt", "shift", "mod", "meta"];
const KEY_NAMES: Record<string, string> = {
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  arrowdown: "↓",
  escape: "Esc",
  pagedown: "PageDown",
  pageup: "PageUp",
  enter: "Enter",
  delete: "Del",
  backspace: "Backspace",
  space: "Space",
};

function oneChord(chord: string, apple: boolean): string {
  const parts = chord.toLowerCase().split("+");
  // "+" itself as the key: "mod+shift++" splits into an empty last part.
  const key = chord.endsWith("++") ? "+" : parts.pop()!;
  const mods = parts.filter(Boolean);
  const name = KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key.replace(/^f(\d+)$/, "F$1"));
  if (apple) return [...MAC_ORDER.filter((mod) => mods.includes(mod)).map((mod) => MAC_MODS[mod]), name].join("");
  return [...MOD_ORDER.filter((mod) => mods.includes(mod)).map((mod) => PC_MODS[mod]), name].join("+");
}

/**
 * A shortcut as this platform writes it. `chords` are `+`-joined tokens (`mod` is ⌘ on a Mac and Ctrl
 * elsewhere), several separated by ` / `: `keyLabel("mod+shift+p", true)` is `⇧⌘P`.
 */
export function keyLabel(chords: string, apple: boolean): string {
  return chords
    .split(" / ")
    .map((chord) => oneChord(chord.trim(), apple))
    .join(" / ");
}
