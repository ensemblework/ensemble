/**
 * Mentions in Ensemble Node rooms: `@handle`, and `@everyone` / `@nodes` for every node in the
 * room. Email addresses, text in backticks or code fences, and a bare `@` are not mentions.
 * Pure: no database.
 */
export const SPECIAL_MENTIONS = ["everyone", "nodes"] as const;
export type SpecialMention = (typeof SPECIAL_MENTIONS)[number];

export type ParsedMention = { handle: string; special: SpecialMention | null };

const HANDLE = /[a-z0-9][a-z0-9_-]*/iy;
const BEFORE_OK = /[\s([{"'>,;]/;

export function parseMentions(text: string): ParsedMention[] {
  const out: ParsedMention[] = [];
  let i = 0;
  let fence = false;
  while (i < text.length) {
    if (text.startsWith("```", i)) {
      fence = !fence;
      i += 3;
      continue;
    }
    const ch = text[i];
    if (fence) {
      i += 1;
      continue;
    }
    if (ch === "`") {
      const close = text.indexOf("`", i + 1);
      i = close === -1 ? text.length : close + 1;
      continue;
    }
    if (ch === "@" && (i === 0 || BEFORE_OK.test(text[i - 1] ?? ""))) {
      HANDLE.lastIndex = i + 1;
      const match = HANDLE.exec(text);
      if (match) {
        let raw = match[0];
        while (/[_-]$/.test(raw)) raw = raw.slice(0, -1);
        const handle = raw.toLowerCase();
        const special = (SPECIAL_MENTIONS as readonly string[]).includes(handle) ? (handle as SpecialMention) : null;
        if (!out.some((row) => row.handle === handle)) out.push({ handle, special });
        i += 1 + raw.length;
        continue;
      }
    }
    i += 1;
  }
  return out;
}

export type DirectoryEntry = { handle: string; kind: "human" | "node"; id: string };
export type Mention = { kind: "human" | "node"; id: string };
export type ResolvedMentions = { mentions: Mention[]; allNodes: boolean };

/** Resolves handles against the room (handles are unique in a room). `@everyone` and `@nodes` wake every node. */
export function resolveMentions(text: string, directory: readonly DirectoryEntry[]): ResolvedMentions {
  const byHandle = new Map(directory.map((entry) => [entry.handle.toLowerCase(), entry]));
  const mentions: Mention[] = [];
  let allNodes = false;
  for (const parsed of parseMentions(text)) {
    if (parsed.special) {
      allNodes = true;
      continue;
    }
    const hit = byHandle.get(parsed.handle);
    if (hit && !mentions.some((row) => row.kind === hit.kind && row.id === hit.id)) mentions.push({ kind: hit.kind, id: hit.id });
  }
  return { mentions, allNodes };
}

/** A handle from a name or email: lowercase letters, digits and dashes, at most 24 characters. */
export function handleFrom(value: string): string {
  const base = value
    .split("@")[0]!
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/g, "");
  return base || "member";
}

/** `base`, or `base-2`, `base-3`… when taken. Specials are never handles. */
export function uniqueHandle(base: string, taken: ReadonlySet<string>): string {
  const clean = handleFrom(base);
  const reserved = (handle: string) => taken.has(handle) || (SPECIAL_MENTIONS as readonly string[]).includes(handle);
  if (!reserved(clean)) return clean;
  for (let n = 2; ; n += 1) {
    const next = `${clean.slice(0, 21)}-${n}`;
    if (!reserved(next)) return next;
  }
}
