/**
 * Mentions written as text in a message: `@people:Mira Chen`, `@diagram:Pipeline`.
 * The Hub's @ menu sends ids for the ones it picked. These are the rest: typed
 * by hand, pasted, or sent from the terminal app. A token resolves only to a
 * record in this space with exactly that name, and only when one record has it.
 */
import type { Prisma } from "@prisma/client";
import { dateMention, hasModule, mentionAlias, type MentionKind, type PageMention } from "@ensemble/shared-types";

const TOKEN = /(^|[\s([{"'“‘])@([A-Za-z]+):/g;
const MAX_TOKENS = 20;
const MAX_WORDS = 8;
const MAX_MENTIONS = 40;
const TRAILING = /[.,;:!?)\]}"'”’]+$/;

export type TypedMention = { kind: MentionKind; names: string[] };

/** Each `@alias:` token with the names it could mean, longest first: `Mira Chen about`, `Mira Chen`, `Mira`. */
export function typedMentionTokens(message: string): TypedMention[] {
  const tokens: TypedMention[] = [];
  for (const match of message.matchAll(TOKEN)) {
    const kind = mentionAlias(match[2]!);
    if (!kind) continue;
    const rest = message.slice(match.index! + match[0].length).split(/[\r\n]/, 1)[0]!.trimStart().slice(0, 200);
    const words: string[] = [];
    for (const word of rest.split(/\s+/)) {
      if (!word || word.startsWith("@") || words.length >= MAX_WORDS) break;
      words.push(word);
    }
    const names: string[] = [];
    for (let count = words.length; count > 0; count -= 1) {
      const name = words.slice(0, count).join(" ");
      for (const candidate of [name, name.replace(TRAILING, "")]) {
        if (candidate && !names.some((have) => have.toLowerCase() === candidate.toLowerCase())) names.push(candidate);
      }
    }
    if (names.length) tokens.push({ kind, names });
    if (tokens.length >= MAX_TOKENS) break;
  }
  return tokens;
}

type Row = { id: string; label: string; keys: string[] };

function named<F extends string>(field: F, names: string[]) {
  return names.map((name) => ({ [field]: { equals: name, mode: "insensitive" as const } }) as Record<F, { equals: string; mode: "insensitive" }>);
}

/** Records of one kind whose name is one of `names`, ignoring case. Off modules have none. */
async function rowsNamed(db: Prisma.TransactionClient, userId: string, modules: string | null | undefined, kind: MentionKind, names: string[]): Promise<Row[]> {
  const take = 100;
  const keyed = (rows: Array<{ id: string; label: string }>) => rows.map((row) => ({ ...row, keys: [row.label.toLowerCase()] }));
  switch (kind) {
    case "people": {
      const rows = await db.person.findMany({ where: { userId, deletedAt: null, OR: [...named("name", names), ...named("email", names)] }, select: { id: true, name: true, email: true }, take });
      return rows.map((row) => ({ id: row.id, label: row.name, keys: [row.name.toLowerCase(), ...(row.email ? [row.email.toLowerCase()] : [])] }));
    }
    case "project":
      return keyed((await db.project.findMany({ where: { userId, deletedAt: null, OR: named("name", names) }, select: { id: true, name: true }, take })).map((row) => ({ id: row.id, label: row.name })));
    case "repo":
      return keyed((await db.repo.findMany({ where: { userId, deletedAt: null, OR: named("fullName", names) }, select: { id: true, fullName: true }, take })).map((row) => ({ id: row.id, label: row.fullName })));
    case "task":
      return keyed((await db.task.findMany({ where: { userId, deletedAt: null, status: { not: "dropped" }, OR: named("title", names) }, select: { id: true, title: true }, take })).map((row) => ({ id: row.id, label: row.title })));
    case "deliverable":
      return keyed((await db.deliverable.findMany({ where: { userId, deletedAt: null, OR: named("title", names) }, select: { id: true, title: true }, take })).map((row) => ({ id: row.id, label: row.title })));
    case "skill":
      if (!hasModule(modules, "skills")) return [];
      return keyed((await db.skill.findMany({ where: { userId, deletedAt: null, OR: named("name", names) }, select: { id: true, name: true }, take })).map((row) => ({ id: row.id, label: row.name })));
    case "diagram":
      if (!hasModule(modules, "diagrams")) return [];
      return keyed((await db.blockDiagram.findMany({ where: { userId, deletedAt: null, OR: named("title", names) }, select: { id: true, title: true }, take })).map((row) => ({ id: row.id, label: row.title })));
    case "plot":
      if (!hasModule(modules, "plots")) return [];
      return keyed((await db.plot.findMany({ where: { userId, deletedAt: null, OR: named("title", names) }, select: { id: true, title: true }, take })).map((row) => ({ id: row.id, label: row.title })));
    case "dataset":
      if (!hasModule(modules, "plots")) return [];
      return keyed((await db.plotDataset.findMany({ where: { userId, deletedAt: null, OR: named("name", names) }, select: { id: true, name: true }, take })).map((row) => ({ id: row.id, label: row.name })));
    case "file":
      return keyed((await db.document.findMany({ where: { userId, deletedAt: null, OR: named("filename", names) }, select: { id: true, filename: true }, take })).map((row) => ({ id: row.id, label: row.filename })));
    case "date":
      return [];
  }
}

const mentionKey = (mention: PageMention) => JSON.stringify([mention.kind, mention.id]);

/**
 * The client's mentions plus the typed tokens it sent no id for. The client's
 * win: a token whose name the client already sent for that kind is skipped.
 * Lookups are best effort; if one fails, the client's mentions still go.
 */
export async function resolveTypedMentions(
  db: Prisma.TransactionClient,
  userId: string,
  modules: string | null | undefined,
  message: string,
  sent: PageMention[] = [],
): Promise<PageMention[]> {
  const merged = new Map(sent.map((mention) => [mentionKey(mention), mention]));
  const known = new Set(sent.map((mention) => `${mention.kind}:${mention.label.toLowerCase()}`));
  const tokens = typedMentionTokens(message).filter((token) => !token.names.some((name) => known.has(`${token.kind}:${name.toLowerCase()}`)));
  try {
    const kinds = [...new Set(tokens.map((token) => token.kind))];
    const found = new Map<MentionKind, Row[]>();
    await Promise.all(
      kinds.map(async (kind) => {
        const names = [...new Set(tokens.filter((token) => token.kind === kind).flatMap((token) => token.names))];
        found.set(kind, await rowsNamed(db, userId, modules, kind, names));
      }),
    );
    for (const token of tokens) {
      if (token.kind === "date") {
        const date = token.names.map((name) => dateMention(name)).find(Boolean);
        if (date) merged.set(mentionKey(date), date);
        continue;
      }
      const rows = found.get(token.kind) ?? [];
      for (const name of token.names) {
        const lower = name.toLowerCase();
        const hits = new Map(rows.filter((row) => row.keys.includes(lower)).map((row) => [row.id, row]));
        if (!hits.size) continue;
        if (hits.size === 1) {
          const row = [...hits.values()][0]!;
          const mention: PageMention = { kind: token.kind, id: row.id, label: row.label };
          if (!merged.has(mentionKey(mention))) merged.set(mentionKey(mention), mention);
        }
        break;
      }
    }
  } catch {
    // Context only: a failed lookup must not stop the turn.
  }
  return [...merged.values()].slice(0, MAX_MENTIONS);
}
