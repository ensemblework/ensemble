/**
 * The pages, tasks and projects a tool call names by id (pageId, taskId, projectId and their parent fields),
 * found by what the model gave: the id, its ensemble:// link, or the record's exact title (one match, case and
 * spacing aside). When an id or a title names nothing, the error names the closest records with their ids, so
 * the next call can use one. Deterministic: no model, the same records in the same order every time.
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";

export type RefKind = "page" | "task" | "project";

/** The fields that hold a record's id, at the top level of a tool's input. */
export const REF_FIELDS: Readonly<Record<string, RefKind>> = { pageId: "page", parentPageId: "page", taskId: "task", parentTaskId: "task", projectId: "project" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LINK = /^ensemble:\/\/(page|task|project)s?\/([0-9a-f-]{36})$/i;
const CANDIDATES = 2_000;
const CLOSEST = 3;
/** Longer than any title: such a value is matched to nothing, and no closest records are looked for. */
const MAX_GIVEN = 200;
/** Cells of edit distance one lookup may fill across all its candidates, so a long value or many records never stall the server. */
const WORK = 2_000_000;

type Row = { id: string; title: string };
type Db = Pick<PrismaClient, "taskPage" | "task" | "project">;

const WORD: Record<RefKind, string> = { page: "page", task: "task", project: "project" };

/** A title as two people would compare it: without quotes around it, case or extra spaces. */
export const titleKey = (text: string): string =>
  text
    .trim()
    .replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();

async function rows(db: Db, userId: string, kind: RefKind): Promise<Row[]> {
  const order = [{ updatedAt: "desc" as const }, { id: "asc" as const }];
  if (kind === "page") return (await db.taskPage.findMany({ where: { userId, deletedAt: null, taskId: null }, select: { id: true, title: true }, orderBy: order, take: CANDIDATES })).map((row) => ({ id: row.id, title: row.title || "Untitled" }));
  if (kind === "task") return db.task.findMany({ where: { userId, deletedAt: null }, select: { id: true, title: true }, orderBy: order, take: CANDIDATES });
  return (await db.project.findMany({ where: { userId, deletedAt: null }, select: { id: true, name: true }, orderBy: order, take: CANDIDATES })).map((row) => ({ id: row.id, title: row.name }));
}

/**
 * The edit distance of `a` and `b` when it is at most `max`, else `max + 1`: only the cells within `max` of the
 * diagonal are filled (`a.length × (2·max + 1)` at most), and it stops once a whole row is past `max`.
 */
function within(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array<number>(b.length + 1).fill(max + 1);
    current[0] = i;
    let best = i;
    for (let j = Math.max(1, i - max); j <= Math.min(b.length, i + max); j += 1) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, current[j]!);
    }
    if (best > max) return max + 1;
    previous = current;
  }
  return Math.min(previous[b.length]!, max + 1);
}

/**
 * The records closest to what was given: by id when it was an id (only a few characters apart), else by title (one
 * holding the other first, then titles a few edits away). A value longer than any title gets none; the work is bounded.
 */
function closest(candidates: readonly Row[], given: string): Row[] {
  if (given.length > MAX_GIVEN) return [];
  const byId = UUID.test(given);
  const key = byId ? given.toLowerCase() : titleKey(given);
  const cutoff = byId ? 12 : Math.max(3, Math.floor(key.length / 2));
  let budget = WORK;
  const ranked: Array<{ row: Row; order: number; rank: number }> = [];
  for (const [order, row] of candidates.entries()) {
    if (budget <= 0) break;
    const other = byId ? row.id.toLowerCase() : titleKey(row.title).slice(0, MAX_GIVEN);
    if (!byId && (other.includes(key) || (other.length >= 3 && key.includes(other)))) {
      ranked.push({ row, order, rank: Math.abs(other.length - key.length) });
      continue;
    }
    if (Math.abs(other.length - key.length) > cutoff) continue;
    budget -= other.length * (2 * cutoff + 1);
    const apart = within(other, key, cutoff);
    if (apart <= cutoff) ranked.push({ row, order, rank: (byId ? 0 : 1_000) + apart });
  }
  return ranked
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, CLOSEST)
    .map((item) => item.row);
}

const named = (rows: readonly Row[]) => rows.map((row) => `“${row.title.slice(0, 80)}” (${row.id})`).join(", ");

/** What to say when nothing has that id or title: the closest records by title with their ids, or how to find one. */
async function notFound(db: Db, userId: string, kind: RefKind, given: string, candidates?: readonly Row[]): Promise<string> {
  const near = closest(candidates ?? (await rows(db, userId, kind)), given);
  const what = UUID.test(given) ? `No ${WORD[kind]} has the id ${given}.` : `No ${WORD[kind]} is called “${given.length > 120 ? `${given.slice(0, 120)}…` : given}”.`;
  return near.length ? `${what} Closest: ${named(near)}. Pass one of these ids, or a ${WORD[kind]}'s exact title.` : `${what} List them to find its id, or pass its exact title.`;
}

export class RefLookupError extends Error {
  readonly statusCode = 404;
}

/** The schema inside optional, default, nullable and refined wrappers. */
function bare(schema: z.ZodTypeAny): z.ZodTypeAny {
  let inner = schema;
  for (let depth = 0; depth < 8; depth += 1) {
    if (inner instanceof z.ZodOptional || inner instanceof z.ZodNullable) inner = inner.unwrap();
    else if (inner instanceof z.ZodDefault) inner = inner.removeDefault();
    else if (inner instanceof z.ZodEffects) inner = inner.innerType();
    else break;
  }
  return inner;
}

/** The id fields a tool's input takes as Ensemble record ids (a uuid string): another app's task or project id is left alone. */
export function refFields(input: z.ZodTypeAny): Array<[string, RefKind]> {
  const object = bare(input);
  if (!(object instanceof z.ZodObject)) return [];
  const shape = object.shape as Record<string, z.ZodTypeAny>;
  return Object.entries(REF_FIELDS).filter(([field]) => {
    const value = shape[field] ? bare(shape[field]!) : null;
    return value instanceof z.ZodString && value._def.checks.some((check) => check.kind === "uuid");
  });
}

/**
 * The input with each id field (`fields`, from `refFields`) that holds a link or a title holding the record's id instead. A
 * title that matches no record, or more than one, throws with the closest records or the matching ones and their ids.
 */
export async function resolveRefs(db: Db, userId: string, input: unknown, fields: ReadonlyArray<[string, RefKind]>): Promise<unknown> {
  if (!fields.length || !input || typeof input !== "object" || Array.isArray(input)) return input;
  const given = input as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  for (const [field, kind] of fields) {
    const value = given[field];
    if (typeof value !== "string" || !value.trim() || UUID.test(value.trim())) continue;
    const link = LINK.exec(value.trim());
    let id: string;
    if (link && link[1]!.toLowerCase() === kind) id = link[2]!.toLowerCase();
    else if (value.trim().length > MAX_GIVEN) throw new RefLookupError(await notFound(db, userId, kind, value.trim(), []));
    else {
      const candidates = await rows(db, userId, kind);
      const key = titleKey(value);
      const same = candidates.filter((row) => titleKey(row.title) === key);
      if (same.length > 1) throw new RefLookupError(`${same.length} ${WORD[kind]}s are called “${value.trim().slice(0, 120)}”: ${named(same.slice(0, 5))}. Pass the id of the one you mean.`);
      if (!same.length) throw new RefLookupError(await notFound(db, userId, kind, value.trim(), candidates));
      id = same[0]!.id;
    }
    out ??= { ...given };
    out[field] = id;
  }
  return out ?? input;
}

/** For a call that failed because a record was not found: each id it gave that names nothing, with the closest records. Null when every id exists. */
export async function missingRefs(db: Db, userId: string, input: unknown, fields: ReadonlyArray<[string, RefKind]>): Promise<string | null> {
  if (!fields.length || !input || typeof input !== "object" || Array.isArray(input)) return null;
  const lines: string[] = [];
  for (const [field, kind] of fields) {
    const value = (input as Record<string, unknown>)[field];
    if (typeof value !== "string" || !UUID.test(value)) continue;
    const exists =
      kind === "page"
        ? await db.taskPage.findFirst({ where: { id: value, userId, deletedAt: null }, select: { id: true } })
        : kind === "task"
          ? await db.task.findFirst({ where: { id: value, userId, deletedAt: null }, select: { id: true } })
          : await db.project.findFirst({ where: { id: value, userId, deletedAt: null }, select: { id: true } });
    if (!exists) lines.push(await notFound(db, userId, kind, value));
  }
  return lines.length ? lines.join(" ") : null;
}

/** For a record named by kind and id that is not there: the closest pages, tasks or projects with their ids; null for other kinds. */
export async function closestTo(db: Db, userId: string, kind: string, given: string): Promise<string | null> {
  return kind === "page" || kind === "task" || kind === "project" ? notFound(db, userId, kind, given) : null;
}
