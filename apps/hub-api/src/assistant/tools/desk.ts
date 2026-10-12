/**
 * The profile's own lists for the assistant (the desk on Today: parts and tests on a bench,
 * timetable and attendance in a semester, matters and hearings in chambers…). Which lists a desk
 * shows follows the space's template (hub-web `components/desk/live-board.tsx` draws them); the
 * rows are written by desk/entries.ts, the same code as POST /api/desk/entries.
 */
import { z, ZodError } from "zod";
import { DESK_MARKET_ID, type TemplateDesk } from "@ensemble/shared-types/manifest";
import { createDeskEntry, deleteDeskEntry } from "../../desk/entries.js";
import { lastUndoId } from "../../lib/undo.js";
import { softDelete } from "../../services/records.js";
import { defineTool, inTransaction, toolOk, type ToolContext } from "../types.js";
import { DateField } from "./calendar.js";

type Desk = TemplateDesk | "default";
type Store = "task" | "slot" | "holiday" | "part" | "test" | "citation" | "grade" | "objective" | "deploy" | "person" | "attendance";

interface KindSpec {
  label: string;
  /** What hub_add_desk_item needs for this kind. */
  fields: string;
  store: Store;
}

const task = (label: string, fields = "title; day?; subject?; stage?"): KindSpec => ({ label, fields, store: "task" });

const KINDS = {
  deadline: task("Deadlines and dates", "title; day"),
  hearing: task("Hearings", "title (matter); day; court?; stage?"),
  matter: task("Matters with a limitation date", "title; orderDate; rule (30d|45d|90d|120d|3m|6m); court?; stage?"),
  filing: task("Filings"),
  draft: task("Drafts"),
  time: task("Logged time", "title; hours"),
  mock: task("Mock test scores", "score; outOf; subject?; day?"),
  paper: task("Papers", "title; stage? (To read…); words?"),
  reading: task("Reading"),
  exam: task("Exam date", "day"),
  phase: task("Syllabus and classes"),
  revision: task("Revision topics"),
  review: task("Reviews"),
  concept: task("What I'm learning", "title; subject? (where you left it)"),
  hold: task("On the bench", "title; day? (next check)"),
  slot: { label: "Timetable", fields: "title (class); weekday (0 Sun … 6 Sat); start HH:MM; end HH:MM; course?", store: "slot" },
  holiday: { label: "Court holidays", fields: "title (holiday name); day", store: "holiday" },
  part: { label: "Parts", fields: "title (part); qty?; status? out|ordered|in", store: "part" },
  test: { label: "Tests and checks", fields: "title (test); status? pass|fail|unknown; build?", store: "test" },
  citation: { label: "Citations", fields: "title (the citing work); cites (the cited work)", store: "citation" },
  grade: { label: "Marking", fields: "title (class); expected; marked", store: "grade" },
  objective: { label: "Objectives", fields: "title; progress? 0–100", store: "objective" },
  deploy: { label: "Deploys and builds", fields: "title (name); env? (prod, or a revision)", store: "deploy" },
  person: { label: "People", fields: "title (name); capacity? hours a week; cadence? 1:1 every N days", store: "person" },
  attendance: { label: "Attendance", fields: "title (person's name); present? true|false; day?", store: "attendance" },
} satisfies Record<string, KindSpec>;

type Kind = keyof typeof KINDS;
const KIND_NAMES = Object.keys(KINDS) as [Kind, ...Kind[]];

/** The lists each desk shows, most important first. */
const DESK_KINDS: Record<Desk, { name: string; kinds: Kind[] }> = {
  default: { name: "Your desk", kinds: ["deadline", "person"] },
  semester: { name: "Semester", kinds: ["slot", "deadline", "attendance", "reading", "person"] },
  exam: { name: "Exam season", kinds: ["exam", "revision", "mock", "phase", "reading", "time"] },
  literature: { name: "Literature desk", kinds: ["paper", "citation", "reading", "deadline", "person"] },
  chambers: { name: "Chambers", kinds: ["matter", "hearing", "filing", "draft", "time", "holiday"] },
  classes: { name: "Classes", kinds: ["slot", "grade", "phase", "attendance", "deadline", "person"] },
  staff: { name: "Staff week", kinds: ["person", "objective"] },
  branch: { name: "Branch desk", kinds: ["review", "test", "deploy"] },
  bench: { name: "Bench", kinds: ["part", "test", "deploy", "deadline"] },
};

const TEMPLATE_DESK: Record<string, Desk> = {
  default: "default",
  ...Object.fromEntries(Object.entries(DESK_MARKET_ID).map(([desk, market]) => [market, desk as Desk])),
  "mkt.exam-sprint": "exam",
  "mkt.prelims-season": "exam",
};

const taskType = (kind: Kind) => kind;

async function deskOf(ctx: ToolContext): Promise<{ id: Desk; name: string; kinds: Kind[] }> {
  const user = await ctx.prisma.user.findUnique({ where: { id: ctx.userId }, select: { activeTemplateId: true } });
  const id = TEMPLATE_DESK[user?.activeTemplateId ?? ""] ?? "default";
  return { id, ...DESK_KINDS[id] };
}

const iso = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : null);
const hm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type Item = { id: string; title: string; detail?: string };

/** Rows of one list, newest or soonest first. Every query is scoped to this space. */
async function itemsOf(ctx: ToolContext, kind: Kind, take: number): Promise<{ items: Item[]; total: number }> {
  const userId = ctx.userId;
  const db = ctx.prisma;
  const spec: KindSpec = KINDS[kind];
  const detail = (...parts: Array<string | number | null | undefined>) => parts.filter((part) => part !== null && part !== undefined && part !== "").join(" · ") || undefined;
  switch (spec.store) {
    case "task": {
      const where = { userId, deletedAt: null, taskType: taskType(kind) };
      const [rows, total] = await Promise.all([
        db.task.findMany({ where, orderBy: [{ due: { sort: "asc", nulls: "last" } }, { updatedAt: "desc" }], take, select: { id: true, title: true, status: true, due: true, court: true, subject: true, measure: true, weight: true, pipelineStage: true, wordCount: true, orderDate: true, limitationRule: true } }),
        db.task.count({ where }),
      ]);
      return {
        total,
        items: rows.map((row) => ({
          id: row.id,
          title: row.title,
          detail: detail(
            row.status,
            iso(row.due),
            row.court,
            row.subject,
            kind === "time" && row.measure !== null ? `${Math.round(row.measure / 6) / 10} h` : null,
            kind === "mock" && row.measure !== null && row.weight !== null ? `${row.measure}/${row.weight}` : null,
            row.pipelineStage,
            row.wordCount !== null ? `${row.wordCount} words` : null,
            row.orderDate ? `order ${iso(row.orderDate)} (${row.limitationRule ?? "?"})` : null,
          ),
        })),
      };
    }
    case "slot": {
      const [rows, total] = await Promise.all([db.timetableSlot.findMany({ where: { userId }, orderBy: [{ weekday: "asc" }, { startMin: "asc" }], take }), db.timetableSlot.count({ where: { userId } })]);
      return { total, items: rows.map((row) => ({ id: row.id, title: row.title, detail: detail(`${WEEKDAYS[row.weekday]} ${hm(row.startMin)}–${hm(row.endMin)}`, row.course) })) };
    }
    case "holiday": {
      const [rows, total] = await Promise.all([db.courtHoliday.findMany({ where: { userId }, orderBy: { day: "asc" }, take }), db.courtHoliday.count({ where: { userId } })]);
      return { total, items: rows.map((row) => ({ id: row.id, title: row.name, detail: iso(row.day) ?? undefined })) };
    }
    case "part": {
      const [rows, total] = await Promise.all([db.partRow.findMany({ where: { userId }, orderBy: { name: "asc" }, take }), db.partRow.count({ where: { userId } })]);
      return { total, items: rows.map((row) => ({ id: row.id, title: row.name, detail: detail(row.status, `qty ${row.qty}`) })) };
    }
    case "test": {
      const [rows, total] = await Promise.all([db.testResult.findMany({ where: { userId }, orderBy: { name: "asc" }, take }), db.testResult.count({ where: { userId } })]);
      return { total, items: rows.map((row) => ({ id: row.id, title: row.name, detail: detail(row.status, row.build) })) };
    }
    case "citation": {
      const [rows, total] = await Promise.all([db.citationLink.findMany({ where: { userId }, orderBy: { fromTitle: "asc" }, take }), db.citationLink.count({ where: { userId } })]);
      return { total, items: rows.map((row) => ({ id: row.id, title: row.fromTitle, detail: `cites ${row.toTitle}` })) };
    }
    case "grade": {
      const [rows, total] = await Promise.all([db.gradingRow.findMany({ where: { userId }, orderBy: { className: "asc" }, take }), db.gradingRow.count({ where: { userId } })]);
      return { total, items: rows.map((row) => ({ id: row.id, title: row.className, detail: `${row.marked}/${row.expected} marked` })) };
    }
    case "objective": {
      const [rows, total] = await Promise.all([db.objective.findMany({ where: { userId }, orderBy: { title: "asc" }, take }), db.objective.count({ where: { userId } })]);
      return { total, items: rows.map((row) => ({ id: row.id, title: row.title, detail: `${row.progress}%` })) };
    }
    case "deploy": {
      const [rows, total] = await Promise.all([db.deployEvent.findMany({ where: { userId }, orderBy: { at: "desc" }, take }), db.deployEvent.count({ where: { userId } })]);
      return { total, items: rows.map((row) => ({ id: row.id, title: row.name, detail: detail(row.env, iso(row.at)) })) };
    }
    case "person": {
      const where = { userId, deletedAt: null };
      const [rows, total] = await Promise.all([db.person.findMany({ where, orderBy: { name: "asc" }, take, select: { id: true, name: true, role: true, capacityHours: true, oneOnOneDays: true } }), db.person.count({ where })]);
      return {
        total,
        items: rows.map((row) => ({ id: row.id, title: row.name, detail: detail(row.role, row.capacityHours !== null ? `${row.capacityHours} h/week` : null, row.oneOnOneDays !== null ? `1:1 every ${row.oneOnOneDays} days` : null) })),
      };
    }
    case "attendance": {
      const [rows, total] = await Promise.all([db.attendanceMark.findMany({ where: { userId }, orderBy: { day: "desc" }, take }), db.attendanceMark.count({ where: { userId } })]);
      const people = await db.person.findMany({ where: { userId, id: { in: rows.map((row) => row.personId) } }, select: { id: true, name: true } });
      return { total, items: rows.map((row) => ({ id: row.id, title: people.find((person) => person.id === row.personId)?.name ?? "Someone", detail: detail(iso(row.day), row.present ? "present" : "absent") })) };
    }
  }
}

/** One row's name, for previews. Null when it is not in this space. */
async function itemLabel(ctx: ToolContext, kind: Kind, id: string): Promise<string | null> {
  const userId = ctx.userId;
  const db = ctx.prisma;
  switch (KINDS[kind].store as Store) {
    case "task":
      return (await db.task.findFirst({ where: { id, userId, deletedAt: null }, select: { title: true } }))?.title ?? null;
    case "person":
      return (await db.person.findFirst({ where: { id, userId, deletedAt: null }, select: { name: true } }))?.name ?? null;
    case "slot":
      return (await db.timetableSlot.findFirst({ where: { id, userId }, select: { title: true } }))?.title ?? null;
    case "holiday":
      return (await db.courtHoliday.findFirst({ where: { id, userId }, select: { name: true } }))?.name ?? null;
    case "part":
      return (await db.partRow.findFirst({ where: { id, userId }, select: { name: true } }))?.name ?? null;
    case "test":
      return (await db.testResult.findFirst({ where: { id, userId }, select: { name: true } }))?.name ?? null;
    case "citation":
      return (await db.citationLink.findFirst({ where: { id, userId }, select: { fromTitle: true } }))?.fromTitle ?? null;
    case "grade":
      return (await db.gradingRow.findFirst({ where: { id, userId }, select: { className: true } }))?.className ?? null;
    case "objective":
      return (await db.objective.findFirst({ where: { id, userId }, select: { title: true } }))?.title ?? null;
    case "deploy":
      return (await db.deployEvent.findFirst({ where: { id, userId }, select: { name: true } }))?.name ?? null;
    case "attendance": {
      const mark = await db.attendanceMark.findFirst({ where: { id, userId }, select: { personId: true, day: true } });
      if (!mark) return null;
      const person = await db.person.findFirst({ where: { id: mark.personId, userId }, select: { name: true } });
      return `${person?.name ?? "Someone"} on ${iso(mark.day)}`;
    }
  }
}

const AddInput = z.object({
  kind: z.enum(KIND_NAMES).describe("Which list. hub_list_desk_items says which this profile has and what each needs."),
  title: z.string().trim().min(1).max(200).optional().describe("The entry's name: a class, part, test, person, matter, paper… For a citation, the citing work."),
  day: DateField.optional(),
  court: z.string().trim().max(80).optional(),
  stage: z.string().trim().max(40).optional(),
  orderDate: DateField.optional().describe("matter: the order date the limitation counts from."),
  rule: z.enum(["30d", "45d", "90d", "120d", "3m", "6m"]).optional().describe("matter: the limitation period."),
  hours: z.number().min(0.25).max(24).optional(),
  score: z.number().int().min(0).max(10000).optional(),
  outOf: z.number().int().min(1).max(10000).optional(),
  subject: z.string().trim().max(80).optional(),
  words: z.number().int().min(0).max(200000).optional(),
  weekday: z.number().int().min(0).max(6).optional().describe("slot: 0 Sunday … 6 Saturday."),
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().describe("slot: HH:MM."),
  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().describe("slot: HH:MM."),
  course: z.string().trim().max(80).optional(),
  qty: z.number().int().min(1).max(10000).optional(),
  status: z.enum(["out", "ordered", "in", "pass", "fail", "unknown"]).optional().describe("part: out|ordered|in. test: pass|fail|unknown."),
  build: z.string().trim().max(40).optional(),
  cites: z.string().trim().min(1).max(200).optional().describe("citation: the cited work."),
  expected: z.number().int().min(0).max(1000).optional(),
  marked: z.number().int().min(0).max(1000).optional(),
  progress: z.number().int().min(0).max(100).optional(),
  env: z.string().trim().max(20).optional(),
  capacity: z.number().min(0).max(80).optional(),
  cadence: z.number().int().min(1).max(90).optional(),
  present: z.boolean().optional(),
});
type AddInput = z.infer<typeof AddInput>;

/** The fields desk/entries.ts reads for this kind. */
function entryFields(input: AddInput): Record<string, unknown> {
  const pick = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
  switch (input.kind) {
    case "slot":
      return pick({ title: input.title, weekday: input.weekday, start: input.start, end: input.end, course: input.course });
    case "holiday":
      return pick({ name: input.title, day: input.day });
    case "part":
      return pick({ name: input.title, qty: input.qty, status: input.status });
    case "test":
      return pick({ name: input.title, build: input.build, status: input.status });
    case "citation":
      return pick({ from: input.title, to: input.cites });
    case "grade":
      return pick({ className: input.title, expected: input.expected, marked: input.marked });
    case "objective":
      return pick({ title: input.title, progress: input.progress });
    case "deploy":
      return pick({ name: input.title, env: input.env });
    case "person":
      return pick({ name: input.title, capacity: input.capacity, cadence: input.cadence });
    case "attendance":
      return pick({ name: input.title, present: input.present === undefined ? undefined : input.present ? "yes" : "no", day: input.day });
    case "matter":
      return pick({ title: input.title, orderDate: input.orderDate, rule: input.rule, court: input.court, stage: input.stage });
    case "hearing":
      return pick({ title: input.title, day: input.day, court: input.court, stage: input.stage });
    case "time":
      return pick({ title: input.title, hours: input.hours });
    case "mock":
      return pick({ score: input.score, outOf: input.outOf, subject: input.subject, day: input.day });
    case "paper":
      return pick({ title: input.title, words: input.words, stage: input.stage });
    case "exam":
      return pick({ day: input.day });
    default:
      return pick({ title: input.title, day: input.day, subject: input.subject, stage: input.stage });
  }
}

function describeEntry(input: AddInput): string {
  const fields = entryFields(input);
  const name = String(fields.title ?? fields.name ?? fields.from ?? fields.className ?? (input.kind === "mock" ? `${input.score}/${input.outOf}` : input.kind === "exam" ? `Exam on ${input.day}` : input.kind));
  const extra = Object.entries(fields)
    .filter(([key]) => !["title", "name", "from", "className"].includes(key))
    .map(([key, value]) => `${key} ${String(value)}`)
    .join(", ");
  return `“${name}”${extra ? ` (${extra})` : ""}`;
}

export const deskTools = [
  defineTool({
    name: "hub_list_desk_items",
    area: "context",
    description:
      "List this profile's own lists on its desk (for example parts and tests on a bench, timetable and attendance in a semester, matters and hearings in chambers). Without kind: the desk's lists with what each needs and their first entries. With kind: that list's entries and ids. Ordinary tasks are hub_list_tasks.",
    input: z.object({
      kind: z.enum(KIND_NAMES).optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      const desk = await deskOf(ctx);
      if (input.kind) {
        const { items, total } = await itemsOf(ctx, input.kind, input.limit);
        const spec = KINDS[input.kind];
        return toolOk(`${spec.label}: ${items.length} of ${total}.`, {
          kind: input.kind,
          label: spec.label,
          needs: spec.fields,
          onThisDesk: desk.kinds.includes(input.kind),
          items,
          total,
        }, { href: "/today" });
      }
      const lists = [];
      for (const kind of desk.kinds) {
        const { items, total } = await itemsOf(ctx, kind, 5);
        lists.push({ kind, label: KINDS[kind].label, needs: KINDS[kind].fields, total, items });
      }
      return toolOk(`${desk.name}: ${lists.map((row) => `${row.label} (${row.total})`).join(", ")}.`, {
        desk: desk.name,
        lists,
        otherKinds: KIND_NAMES.filter((kind) => !desk.kinds.includes(kind)),
      }, { href: "/today" });
    },
  }),
  defineTool({
    name: "hub_add_desk_item",
    area: "context",
    description:
      "Add an entry to one of this profile's desk lists. kind picks the list; send only the fields that kind needs (hub_list_desk_items says which, for example part: title, qty, status). Dates are YYYY-MM-DD. Ordinary tasks are hub_create_tasks.",
    input: AddInput,
    isWrite: true,
    risk: "low",
    preview(_ctx, input) {
      return `Add to ${KINDS[input.kind].label}: ${describeEntry(input)}`;
    },
    async run(ctx, input) {
      const spec: KindSpec = KINDS[input.kind];
      const saved = await inTransaction(ctx, async (tx) => {
        try {
          const row = await createDeskEntry(tx, ctx.userId, input.kind, entryFields(input), "agent");
          return { ...row, undoEntryId: row.undoEntryId ?? lastUndoId(tx) ?? null };
        } catch (error) {
          if (error instanceof ZodError) {
            const fields = error.issues.map((issue) => issue.path.join(".") || "input").join(", ");
            throw Object.assign(new Error(`${spec.label} needs: ${spec.fields}. Missing or wrong: ${fields}.`), { statusCode: 400 });
          }
          throw error;
        }
      });
      return toolOk(`Added “${saved.title}” to ${spec.label}.`, { id: saved.id, kind: input.kind, title: saved.title }, {
        href: "/today",
        invalidate: ["desk-live"],
        ...(saved.undoEntryId ? { undoEntryId: saved.undoEntryId } : {}),
      });
    },
  }),
  defineTool({
    name: "hub_remove_desk_item",
    area: "context",
    description:
      "Remove an entry from one of this profile's desk lists by kind and id (from hub_list_desk_items). Dated entries and people go to Trash and can be restored; timetable, parts, tests, citations, marking, objectives, deploys, holidays and attendance marks are deleted for good.",
    input: z.object({ kind: z.enum(KIND_NAMES), id: z.string().uuid() }),
    isWrite: true,
    risk: "medium",
    undoable: false,
    async preview(ctx, input) {
      const spec: KindSpec = KINDS[input.kind];
      const label = await itemLabel(ctx, input.kind, input.id);
      if (!label) throw Object.assign(new Error(`No ${spec.label.toLowerCase()} entry with that id. Call hub_list_desk_items with kind ${input.kind}.`), { statusCode: 404 });
      return spec.store === "task" || spec.store === "person"
        ? `Move “${label}” (${spec.label}) to Trash`
        : `Delete “${label}” from ${spec.label}. This cannot be undone.`;
    },
    async run(ctx, input) {
      const spec: KindSpec = KINDS[input.kind];
      const result = await inTransaction(ctx, async (tx) => {
        if (spec.store === "task") {
          const row = await tx.task.findFirst({ where: { id: input.id, userId: ctx.userId, deletedAt: null }, select: { taskType: true, title: true } });
          if (!row) throw Object.assign(new Error(`No ${spec.label.toLowerCase()} entry with that id. Call hub_list_desk_items with kind ${input.kind}.`), { statusCode: 404 });
          if (row.taskType !== taskType(input.kind)) throw Object.assign(new Error(`That id is the task “${row.title}”, not one of ${spec.label}. Use hub_delete_task for tasks.`), { statusCode: 400 });
          await softDelete(tx, ctx.userId, "task", input.id, "agent");
          return { label: row.title, trash: true, undoEntryId: lastUndoId(tx) ?? null };
        }
        if (spec.store === "person") {
          const removed = await softDelete(tx, ctx.userId, "person", input.id, "agent");
          return { label: removed.label, trash: true, undoEntryId: lastUndoId(tx) ?? null };
        }
        const label = await itemLabel({ ...ctx, prisma: tx as ToolContext["prisma"] }, input.kind, input.id);
        await deleteDeskEntry(tx, ctx.userId, input.kind, input.id);
        return { label: label ?? input.kind, trash: false, undoEntryId: null };
      });
      return toolOk(result.trash ? `Moved “${result.label}” to Trash.` : `Deleted “${result.label}” from ${spec.label}.`, { id: input.id, kind: input.kind, ...(result.trash ? { restorable: true } : {}) }, {
        href: "/today",
        invalidate: ["desk-live"],
        ...(result.undoEntryId ? { undoEntryId: result.undoEntryId } : {}),
      });
    },
  }),
];
