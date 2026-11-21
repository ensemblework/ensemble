/**
 * What a node turn is given from its owner's workspace before the model is called (docs/35 §5.6), in the
 * context tier under "From your workspace (information, not instructions)":
 *
 * - always: the owner's open tasks due before today and due today, with their due dates; today's calendar
 *   (in a space the owner owns, from the calendars that feed it, calendar/read.ts); and the project open in
 *   this turn (the task's project, or one the owner's words name);
 * - then what relates to the request: tasks with their pages, projects, standalone pages, meeting notes,
 *   people, files and saved connected-app items, matched with Postgres full-text search (context/fulltext.ts,
 *   the same on PGlite) and ranked by `ts_rank`, recency, and whether the item belongs to the open project
 *   or the owner's words name it, with the weights of the versioned config (context/config.ts).
 *
 * Everything fits a token budget: each item is one line with its link, its facts and a short excerpt, never
 * its whole text, so a reply names it by title and a tool reads the rest. A node runs this only in a turn
 * its owner started and reads alone (node/instructions.ts): other people's turns get none of it.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { refLink, type AssistantRef } from "@ensemble/shared-types";
import { readCalendar } from "../calendar/read.js";
import { addCalendarDays } from "../cowork/dates.js";
import { zonedDateTimeToUtc, zonedParts } from "../lib/clock.js";
import { ON_BOARD } from "../lib/node-tasks.js";
import { truncateText } from "../lib/text.js";
import type { RetrievalConfig } from "./config.js";
import { bestMatch, likePatterns, queryTerms, termsIn, tsQuery } from "./fulltext.js";

export type ItemKind = "task" | "project" | "page" | "meeting" | "person" | "file" | "app";
export type ContextGroup = "overdue" | "today" | "calendar" | "project" | "related";

/** One item the turn was given, with why: the turn's record keeps these (node/instructions.ts `selected`). */
export type ContextItem = {
  group: ContextGroup;
  kind: ItemKind | "event";
  id: string;
  title: string;
  /** Its `ensemble://` link, when a reply can open it. */
  ref: string | null;
  /** Its relevance score (related items only). */
  score: number | null;
  why: string[];
  line: string;
};

export type RetrieveInput = {
  /** The space whose records are read: the turn's home space. */
  spaceId: string;
  /** The node's owner: whose tasks are theirs. */
  ownerId: string;
  /** The owner owns that space, so its calendar and saved app items are theirs to read. */
  ownSpace: boolean;
  /** The owner's words this turn answers. */
  words: string;
  /** The task's or the step's goal, when the turn has one. */
  goal?: string;
  timeZone: string;
  /** The project open in this turn, when known (a task's project). */
  projectId?: string | null;
  config: RetrievalConfig;
  now?: Date;
};

export type Retrieved = {
  /** The section's lines: a label per group, then one line per item. */
  lines: string[];
  items: ContextItem[];
  /** Every linked item, so a reply that prints one by id shows its title. */
  refs: AssistantRef[];
  /** Items found but left out to keep within the budget or a group's cap. */
  left: number;
  /** The words searched. */
  terms: string[];
  chars: number;
};

const DAY_MS = 86_400_000;
const PRIORITY_ORDER: Record<string, number> = { critical: 0, p0: 1, p1: 2, p2: 3 };
const ENDED = ["done", "dropped"];

/** Date-only due dates are stored at midnight UTC (lib/clock.ts `parseDue`); a due with a time is an instant. */
function dueDay(due: Date, timeZone: string): string {
  const midnight = due.getUTCHours() === 0 && due.getUTCMinutes() === 0 && due.getUTCSeconds() === 0 && due.getUTCMilliseconds() === 0;
  return midnight ? due.toISOString().slice(0, 10) : zonedParts(timeZone, due).date;
}

function dueTime(due: Date, timeZone: string): string | null {
  const midnight = due.getUTCHours() === 0 && due.getUTCMinutes() === 0 && due.getUTCSeconds() === 0 && due.getUTCMilliseconds() === 0;
  return midnight ? null : zonedParts(timeZone, due).time;
}

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

const quote = (text: string) => (text ? ` · “${text}”` : "");

/** About `max` characters of the item's own words: all of a short one, else where most words of the request are, else its start. */
function excerpt(body: string, title: string, terms: readonly string[], max: number, prefixFrom: number): string {
  let flat = body.replace(/\s+/g, " ").trim();
  const named = title.replace(/\s+/g, " ").trim();
  if (named && flat.startsWith(named)) flat = flat.slice(named.length).trim();
  if (flat.length <= max) return flat;
  const hit = terms.length ? bestMatch(flat, terms, prefixFrom) : null;
  if (!hit) return `${truncateText(flat, max).trimEnd()}…`;
  // A third of the room before the match, the rest after; whole words at the cut ends.
  let start = Math.max(0, hit.at - Math.floor(max / 3));
  let end = Math.min(flat.length, start + max);
  if (start > 0) start = Math.min(hit.at, flat.indexOf(" ", start) + 1 || hit.at);
  if (end < flat.length) end = Math.max(hit.at + hit.length, flat.lastIndexOf(" ", end));
  return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
}

type Linked = { kind: string; id: string; label: string };
const link = (row: Linked) => refLink(row);
/** Lower-case words with one space around each, so a name is found only as whole words. */
const words = (text: string) => ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;

// ── always: due tasks, today's calendar, the open project ─────────────────────────────────────────

type DueTask = { id: string; title: string; status: string; priority: string; due: Date; projectId: string | null };

async function dueTasks(db: PrismaClient, input: RetrieveInput, today: string): Promise<{ overdue: DueTask[]; today: DueTask[] }> {
  // Instants up to two days on cover every zone's "today"; the day of each is decided below.
  const before = new Date(`${addCalendarDays(today, 2)}T00:00:00.000Z`);
  const theirs: Prisma.TaskWhereInput = input.ownSpace ? { OR: [{ assigneeAccountId: null }, { assigneeAccountId: input.ownerId }] } : { assigneeAccountId: input.ownerId };
  const rows = await db.task.findMany({
    where: { AND: [{ userId: input.spaceId, deletedAt: null, status: { notIn: ["done", "dropped"] }, due: { not: null, lt: before } }, ON_BOARD, theirs] },
    orderBy: { due: "desc" },
    take: 200,
    select: { id: true, title: true, status: true, priority: true, due: true, projectId: true },
  });
  const due = rows.filter((row): row is typeof row & { due: Date } => Boolean(row.due));
  const overdue = due
    .filter((row) => dueDay(row.due, input.timeZone) < today)
    .sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9) || b.due.getTime() - a.due.getTime());
  const todays = due.filter((row) => dueDay(row.due, input.timeZone) === today).sort((a, b) => a.due.getTime() - b.due.getTime());
  return { overdue, today: todays };
}

function dueLine(task: DueTask, today: string, timeZone: string): string {
  const day = dueDay(task.due, timeZone);
  const time = dueTime(task.due, timeZone);
  const late = daysBetween(day, today);
  const when = day === today ? `due today${time ? ` ${time}` : ""}` : `due ${day}${time ? ` ${time}` : ""} (${late} day${late === 1 ? "" : "s"} overdue)`;
  return `- ${link({ kind: "task", id: task.id, label: task.title })}: ${when} · ${task.status.replace(/_/g, " ")} · ${task.priority}`;
}

async function todaysEvents(db: PrismaClient, input: RetrieveInput, today: string): Promise<ContextItem[]> {
  const from = zonedDateTimeToUtc(today, "00:00", input.timeZone);
  const to = zonedDateTimeToUtc(addCalendarDays(today, 1), "00:00", input.timeZone);
  const calendar = await readCalendar(db, input.spaceId, { from, to, timeZone: input.timeZone });
  const time = (iso: string) => zonedParts(input.timeZone, new Date(iso)).time;
  return calendar.events.map((event) => {
    const when = event.allDay ? "All day" : `${time(event.start)}${event.end ? ` to ${time(event.end)}` : ""}`;
    const title = event.title.replace(/\s+/g, " ").trim();
    return { group: "calendar", kind: "event", id: event.id, title, ref: null, score: null, why: ["today"], line: `- ${when}: ${title}` };
  });
}

type ProjectRow = { id: string; name: string; status: string; summary: string };

/** The project open in this turn: the one it was given, else the one the owner's words name (the longest name wins). */
async function openProject(db: PrismaClient, input: RetrieveInput, text: string): Promise<ProjectRow | null> {
  const select = { id: true, name: true, status: true, summary: true, aliases: true } as const;
  if (input.projectId) {
    const row = await db.project.findFirst({ where: { id: input.projectId, userId: input.spaceId, deletedAt: null }, select });
    if (row) return row;
  }
  const said = words(text);
  if (!said.trim()) return null;
  const rows = await db.project.findMany({ where: { userId: input.spaceId, deletedAt: null }, orderBy: { updatedAt: "desc" }, take: 300, select });
  let best: { row: ProjectRow; length: number } | null = null;
  for (const row of rows) {
    for (const name of [row.name, ...row.aliases]) {
      const named = words(name);
      if (named.trim().length < 3 || !said.includes(named)) continue;
      if (!best || named.length > best.length) best = { row, length: named.length };
    }
  }
  return best?.row ?? null;
}

// ── related: full-text candidates of every kind, then one score ───────────────────────────────────

type Source = {
  kind: ItemKind;
  id: Prisma.Sql;
  title: Prisma.Sql;
  body: Prisma.Sql;
  at: Prisma.Sql;
  project: Prisma.Sql;
  extra: Prisma.Sql;
  from: Prisma.Sql;
  where: Prisma.Sql;
};

type Candidate = {
  kind: ItemKind;
  id: string;
  title: string;
  body: string;
  at: number | null;
  projectId: string | null;
  extra: Record<string, unknown>;
  rank: number;
  /** The share of the request's words it contains (0 to 1). */
  coverage: number;
};

function sources(input: RetrieveInput): Source[] {
  const space = input.spaceId;
  const none = Prisma.sql`NULL::text`;
  const empty = Prisma.sql`'{}'::jsonb`;
  const list: Source[] = [
    {
      kind: "task",
      id: Prisma.sql`t.id`,
      title: Prisma.sql`t.title`,
      // A task's page is searched with it: a hit names the task.
      body: Prisma.sql`concat_ws(' ', t.description, t.notes, p.search_text)`,
      at: Prisma.sql`t.updated_at`,
      project: Prisma.sql`t.project_id`,
      extra: Prisma.sql`jsonb_build_object('status', t.status::text, 'priority', t.priority::text, 'due', (EXTRACT(EPOCH FROM t.due) * 1000)::float8)`,
      from: Prisma.sql`tasks t LEFT JOIN task_pages p ON p.task_id = t.id AND p.deleted_at IS NULL`,
      where: Prisma.sql`t.user_id = ${space} AND t.deleted_at IS NULL AND t.source_ref NOT LIKE 'node:%' AND t.source_ref NOT LIKE 'code:%'`,
    },
    {
      kind: "project",
      id: Prisma.sql`pr.id`,
      title: Prisma.sql`pr.name`,
      body: Prisma.sql`concat_ws(' ', array_to_string(pr.aliases, ' '), pr.summary, pr.notes)`,
      at: Prisma.sql`pr.updated_at`,
      project: Prisma.sql`pr.id`,
      extra: Prisma.sql`jsonb_build_object('status', pr.status::text)`,
      from: Prisma.sql`projects pr`,
      where: Prisma.sql`pr.user_id = ${space} AND pr.deleted_at IS NULL`,
    },
    {
      kind: "page",
      id: Prisma.sql`pg.id`,
      title: Prisma.sql`pg.title`,
      body: Prisma.sql`pg.search_text`,
      at: Prisma.sql`pg.updated_at`,
      project: none,
      extra: empty,
      from: Prisma.sql`task_pages pg`,
      where: Prisma.sql`pg.user_id = ${space} AND pg.deleted_at IS NULL AND pg.task_id IS NULL`,
    },
    {
      kind: "meeting",
      id: Prisma.sql`mn.id`,
      title: Prisma.sql`mn.title`,
      body: Prisma.sql`concat_ws(' ', mn.answer, mn.comment, mn.prompt)`,
      at: Prisma.sql`coalesce(mn.occurred_at, mn.asked_at)`,
      project: Prisma.sql`mn.project_id`,
      // The notes written in Ensemble for a meeting are its session: replies link that.
      extra: Prisma.sql`jsonb_build_object('source', mn.source, 'session', (SELECT s.id FROM meeting_sessions s WHERE s.meeting_note_id = mn.id AND s.deleted_at IS NULL ORDER BY s.started_at DESC LIMIT 1))`,
      from: Prisma.sql`meeting_notes mn`,
      where: Prisma.sql`mn.user_id = ${space} AND mn.deleted_at IS NULL`,
    },
    {
      kind: "meeting",
      id: Prisma.sql`ms.id`,
      title: Prisma.sql`ms.title`,
      body: Prisma.sql`concat_ws(' ', ms.notes, ms.recap)`,
      at: Prisma.sql`ms.started_at`,
      project: Prisma.sql`ms.project_id`,
      extra: Prisma.sql`jsonb_build_object('session', ms.id)`,
      from: Prisma.sql`meeting_sessions ms`,
      where: Prisma.sql`ms.user_id = ${space} AND ms.deleted_at IS NULL AND ms.meeting_note_id IS NULL`,
    },
    {
      kind: "person",
      id: Prisma.sql`pe.id`,
      title: Prisma.sql`pe.name`,
      body: Prisma.sql`concat_ws(' ', pe.email, pe.role, pe.team, pe.relationship)`,
      at: Prisma.sql`pe.updated_at`,
      project: none,
      extra: Prisma.sql`jsonb_build_object('role', pe.role, 'team', pe.team, 'relationship', pe.relationship)`,
      from: Prisma.sql`people pe`,
      where: Prisma.sql`pe.user_id = ${space} AND pe.deleted_at IS NULL`,
    },
    {
      kind: "file",
      id: Prisma.sql`d.id`,
      title: Prisma.sql`d.filename`,
      body: Prisma.sql`d.summary`,
      at: Prisma.sql`d.updated_at`,
      project: Prisma.sql`d.project_ids[1]`,
      extra: empty,
      from: Prisma.sql`context_documents d`,
      where: Prisma.sql`d.user_id = ${space} AND d.deleted_at IS NULL`,
    },
  ];
  // Saved app items (mail, chat, documents, issues) are the space owner's: only in a space the owner owns.
  // Events are the calendar's; an uploaded file is its file.
  if (input.ownSpace) {
    list.push({
      kind: "app",
      id: Prisma.sql`a.id`,
      title: Prisma.sql`a.title`,
      body: Prisma.sql`a.text`,
      at: Prisma.sql`a.ts`,
      project: Prisma.sql`a.project_id`,
      extra: Prisma.sql`jsonb_build_object('kind', a.kind::text, 'mine', a.authored_by_me)`,
      from: Prisma.sql`artifacts a`,
      where: Prisma.sql`a.user_id = ${space} AND a.deleted_at IS NULL AND a.kind::text <> 'event' AND NOT (a.kind::text = 'file' AND a.external_id LIKE 'file:%') AND NOT EXISTS (SELECT 1 FROM context_documents dd WHERE dd.artifact_id = a.id)`,
    });
  }
  return list;
}

/**
 * One kind's matches, best first: rows that contain a word of the request (a cheap filter, the newest
 * `scanPerKind`), ranked with `ts_rank` over the title (weight A) and the body (weight B), the length of
 * the body discounted.
 */
function rankedQuery(source: Source, query: string, patterns: string[], config: RetrievalConfig): Prisma.Sql {
  const like = Prisma.join(patterns.map((pattern) => Prisma.sql`(${source.title} ILIKE ${pattern} OR ${source.body} ILIKE ${pattern})`), " OR ");
  const scan = Prisma.raw(String(Math.max(1, Math.floor(config.scanPerKind))));
  const take = Prisma.raw(String(Math.max(1, Math.floor(config.perKind))));
  return Prisma.sql`
    SELECT d.id, d.title, left(d.body, 20000) AS body, d.at, d.project_id AS "projectId", d.extra, ts_rank(d.doc, q.query, 1)::float8 AS rank
    FROM (
      SELECT c.*, setweight(to_tsvector('simple', c.title), 'A') || setweight(to_tsvector('simple', c.body), 'B') AS doc
      FROM (
        SELECT ${source.id} AS id, coalesce(${source.title}, '') AS title, coalesce(${source.body}, '') AS body,
               (EXTRACT(EPOCH FROM ${source.at}) * 1000)::float8 AS at, ${source.project} AS project_id, ${source.extra} AS extra
        FROM ${source.from}
        WHERE ${source.where} AND (${like})
        ORDER BY ${source.at} DESC
        LIMIT ${scan}
      ) c
    ) d, (SELECT to_tsquery('simple', ${query}) AS query) q
    WHERE d.doc @@ q.query
    ORDER BY rank DESC, d.at DESC
    LIMIT ${take}`;
}

async function candidates(db: PrismaClient, input: RetrieveInput, terms: string[]): Promise<Candidate[]> {
  const query = tsQuery(terms, input.config.prefixFrom);
  if (!query) return [];
  const patterns = likePatterns(terms, input.config.prefixFrom);
  const found = await Promise.all(
    sources(input).map(async (source) => {
      const rows = await db.$queryRaw<Array<{ id: string; title: string; body: string; at: number | null; projectId: string | null; extra: unknown; rank: number }>>(rankedQuery(source, query, patterns, input.config));
      return rows.map((row) => ({
        kind: source.kind,
        id: row.id,
        title: row.title.replace(/\s+/g, " ").trim(),
        body: row.body ?? "",
        at: typeof row.at === "number" && Number.isFinite(row.at) ? row.at : null,
        projectId: row.projectId,
        extra: (typeof row.extra === "string" ? JSON.parse(row.extra) : (row.extra ?? {})) as Record<string, unknown>,
        rank: Number(row.rank) || 0,
        coverage: termsIn(`${row.title} ${row.body ?? ""}`, terms, input.config.prefixFrom).size / terms.length,
      }));
    }),
  );
  return found.flat();
}

const UNTITLED: Record<ItemKind, string> = { task: "Untitled task", project: "Untitled project", page: "Untitled page", meeting: "Meeting", person: "Someone", file: "A file", app: "An item" };

/** The item's link and line, by kind: facts first, then an excerpt of its own words. */
function relatedLine(item: Candidate, terms: readonly string[], config: RetrievalConfig, timeZone: string): { ref: Linked | null; line: string } {
  const title = item.title || UNTITLED[item.kind];
  const snippet = (body = item.body) => quote(excerpt(body, item.title, terms, config.snippetChars, config.prefixFrom));
  const date = item.at === null ? "" : zonedParts(timeZone, new Date(item.at)).date;
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : "");
  switch (item.kind) {
    case "task": {
      const due = typeof item.extra.due === "number" ? ` · due ${dueDay(new Date(item.extra.due), timeZone)}` : "";
      const ref = { kind: "task", id: item.id, label: title };
      return { ref, line: `- ${link(ref)}: task · ${text(item.extra.status).replace(/_/g, " ")}${due}${snippet()}` };
    }
    case "project": {
      const ref = { kind: "project", id: item.id, label: title };
      return { ref, line: `- ${link(ref)}: project · ${text(item.extra.status)}${snippet()}` };
    }
    case "page": {
      const ref = { kind: "page", id: item.id, label: title };
      return { ref, line: `- ${link(ref)}: page${date ? `, edited ${date}` : ""}${snippet()}` };
    }
    case "meeting": {
      const session = text(item.extra.session);
      const imported = text(item.extra.source) && !["live", "paste"].includes(text(item.extra.source));
      if (session) {
        const ref = { kind: "meeting", id: session, label: title };
        return { ref, line: `- ${link(ref)}: meeting notes${date ? `, ${date}` : ""}${snippet()}` };
      }
      return { ref: null, line: `- “${title}”: meeting notes${imported ? " from an app" : ""}${date ? `, ${date}` : ""} (hub_read_meeting_note ${item.id})${snippet()}` };
    }
    case "person": {
      const ref = { kind: "people", id: item.id, label: title };
      const facts = [text(item.extra.role), text(item.extra.team), text(item.extra.relationship)].filter(Boolean).join(" · ");
      return { ref, line: `- ${link(ref)}: person${facts ? ` · ${facts}` : ""}` };
    }
    case "file": {
      const ref = { kind: "file", id: item.id, label: title };
      return { ref, line: `- ${link(ref)}: file${date ? `, ${date}` : ""}${snippet()}` };
    }
    case "app": {
      const kind = text(item.extra.kind).replace(/_/g, " ") || "item";
      return { ref: null, line: `- “${title}”: ${kind} saved from a connected app${date ? `, ${date}` : ""}${item.extra.mine === true ? ", written by your owner" : ""}${snippet()}` };
    }
  }
}

/** Points for each candidate (config `weights` and `kinds`), with the signals that gave them. */
export function scoreCandidate(
  item: Pick<Candidate, "kind" | "id" | "title" | "at" | "projectId" | "extra" | "rank" | "coverage">,
  context: { bestRank: number; projectId: string | null; text: string; now: number },
  config: RetrievalConfig,
): { score: number; why: string[] } {
  const { weights } = config;
  const why: string[] = [];
  const share = context.bestRank > 0 ? item.rank / context.bestRank : 0;
  let points = weights.text * share + weights.coverage * item.coverage;
  why.push(`text ${share.toFixed(2)}`, `words ${item.coverage.toFixed(2)}`);
  if (item.at !== null) {
    const age = Math.max(0, (context.now - item.at) / DAY_MS);
    const decay = Math.exp((-Math.LN2 * age) / config.recencyHalfLifeDays);
    points += weights.recency * decay;
    if (decay >= 0.5) why.push("recent");
  }
  if (context.projectId && item.projectId === context.projectId) {
    points += weights.project;
    why.push("open project");
  }
  const title = words(item.title);
  if ((title.trim().length >= 4 && words(context.text).includes(title)) || context.text.toLowerCase().includes(item.id.toLowerCase())) {
    points += weights.mentioned;
    why.push("named");
  }
  const status = typeof item.extra.status === "string" ? item.extra.status : "";
  if ((item.kind === "task" && status && !ENDED.includes(status)) || (item.kind === "project" && status === "active")) {
    points += weights.open;
    why.push("open");
  }
  return { score: Math.round(points * config.kinds[item.kind] * 1000) / 1000, why };
}

/** What the turn is given from the workspace, within the budget (see the file's comment). */
export async function retrieveContext(db: PrismaClient, input: RetrieveInput): Promise<Retrieved> {
  const { config } = input;
  const now = input.now ?? new Date();
  const text = `${input.words}\n${input.goal ?? ""}`.slice(0, config.queryChars);
  const terms = queryTerms(text, config.queryTerms);
  const today = zonedParts(input.timeZone, now).date;
  const [due, events, project, found] = await Promise.all([
    dueTasks(db, input, today),
    // A calendar that cannot be read leaves the rest standing.
    input.ownSpace ? todaysEvents(db, input, today).catch(() => [] as ContextItem[]) : Promise.resolve([] as ContextItem[]),
    openProject(db, input, text),
    terms.length ? candidates(db, input, terms) : Promise.resolve([] as Candidate[]),
  ]);

  const task = (group: "overdue" | "today") => (row: DueTask): ContextItem => ({ group, kind: "task", id: row.id, title: row.title, ref: `ensemble://task/${row.id}`, score: null, why: [group === "overdue" ? "overdue" : "due today"], line: dueLine(row, today, input.timeZone) });
  const openLine: ContextItem[] = project
    ? [{ group: "project", kind: "project", id: project.id, title: project.name, ref: `ensemble://project/${project.id}`, score: null, why: [input.projectId === project.id ? "the task's project" : "named"], line: `- ${link({ kind: "project", id: project.id, label: project.name })}: ${project.status}${quote(excerpt(project.summary, project.name, [], config.snippetChars, config.prefixFrom))}` }]
    : [];

  // What the always groups show is not repeated among the related items (a group's cap leaves the rest eligible).
  const shown = new Set([...due.overdue.slice(0, config.always.overdue), ...due.today.slice(0, config.always.today)].map((row) => row.id).concat(project ? [project.id] : []));
  const linked = new Map<string, Linked>();
  const bestRank = Math.max(0, ...found.map((row) => row.rank));
  const related = found
    .filter((row) => !shown.has(row.id))
    .map((row) => {
      const scored = scoreCandidate(row, { bestRank, projectId: project?.id ?? null, text, now: now.getTime() }, config);
      return { row, ...scored };
    })
    .filter((row) => row.score >= config.minScore)
    .sort((a, b) => b.score - a.score || (b.row.at ?? 0) - (a.row.at ?? 0))
    .map(({ row, score, why }): ContextItem => {
      const { ref, line } = relatedLine(row, terms, config, input.timeZone);
      if (ref) linked.set(row.id, ref);
      return { group: "related", kind: row.kind, id: row.id, title: row.title, ref: ref ? `ensemble://${ref.kind}/${ref.id}` : null, score, why, line };
    });

  const budget = config.budgetTokens * 4;
  const lines: string[] = [];
  const items: ContextItem[] = [];
  const refs = new Map<string, AssistantRef>();
  let chars = 0;
  let left = 0;
  const fits = (added: string[]) => chars + added.reduce((sum, line) => sum + line.length + 1, 0) <= budget;
  const push = (added: string[]) => {
    lines.push(...added);
    chars += added.reduce((sum, line) => sum + line.length + 1, 0);
  };
  const group = (label: string, list: ContextItem[], cap: number) => {
    let opened = false;
    for (const item of list.slice(0, cap)) {
      const added = opened ? [item.line] : [label, item.line];
      if (!fits(added)) {
        left += 1;
        continue;
      }
      push(added);
      opened = true;
      items.push(item);
    }
    const more = list.length - Math.min(list.length, cap);
    left += more;
    if (opened && more > 0 && fits([`- and ${more} more`])) push([`- and ${more} more`]);
  };
  group(`Overdue (open tasks due before today, ${today}):`, due.overdue.map(task("overdue")), config.always.overdue);
  group(`Due today (${today}):`, due.today.map(task("today")), config.always.today);
  group("Today's calendar:", events, config.always.events);
  group("Open project:", openLine, 1);
  group("Related to your owner's request, best match first:", related, config.maxRelated);

  for (const item of items) {
    const ref = item.group === "related" ? linked.get(item.id) : item.kind === "task" || item.kind === "project" ? { kind: item.kind, id: item.id, label: item.title } : null;
    if (ref) refs.set(ref.id, { ...ref, label: truncateText(ref.label, 200) });
  }
  return { lines, items, refs: [...refs.values()], left, terms, chars };
}
