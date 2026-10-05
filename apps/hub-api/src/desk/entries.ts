import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { isIsoDate } from "../lib/clock.js";
import { lastUndoId } from "../lib/undo.js";
import { createTask } from "../services/tasks.js";
import { isLimitationRule } from "./limitation.js";

type Db = PrismaClient;
const day = z.string().refine(isIsoDate, "Pick a real date.");
const title = z.string().trim().min(1).max(200);
const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 09:00.");

function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}

function minutes(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return h! * 60 + m!;
}

const TASK_KINDS = new Set([
  "hearing",
  "matter",
  "filing",
  "draft",
  "time",
  "task",
  "mock",
  "paper",
  "reading",
  "exam",
  "phase",
  "revision",
  "deadline",
  "review",
  "concept",
  "hold",
]);

export async function createDeskEntry(db: Db, userId: string, kind: string, raw: unknown) {
  if (TASK_KINDS.has(kind)) return createTaskEntry(db, userId, kind, raw);
  if (kind === "slot") return createSlot(db, userId, raw);
  if (kind === "holiday") return createHoliday(db, userId, raw);
  if (kind === "part") return createPart(db, userId, raw);
  if (kind === "test") return createTest(db, userId, raw);
  if (kind === "citation") return createCitation(db, userId, raw);
  if (kind === "grade") return createGrade(db, userId, raw);
  if (kind === "objective") return createObjective(db, userId, raw);
  if (kind === "deploy") return createDeploy(db, userId, raw);
  if (kind === "person") return createPerson(db, userId, raw);
  if (kind === "attendance") return createAttendance(db, userId, raw);
  fail(400, "That tile cannot add this yet.");
}

export async function deleteDeskEntry(db: Db, userId: string, kind: string, id: string) {
  const gone = async (count: number) => {
    if (!count) fail(404, "That entry is not yours.");
  };
  if (TASK_KINDS.has(kind)) {
    const row = await db.task.updateMany({ where: { id, userId, deletedAt: null }, data: { deletedAt: new Date() } });
    return gone(row.count);
  }
  if (kind === "slot") return gone((await db.timetableSlot.deleteMany({ where: { id, userId } })).count);
  if (kind === "holiday") return gone((await db.courtHoliday.deleteMany({ where: { id, userId } })).count);
  if (kind === "part") return gone((await db.partRow.deleteMany({ where: { id, userId } })).count);
  if (kind === "test") return gone((await db.testResult.deleteMany({ where: { id, userId } })).count);
  if (kind === "citation") return gone((await db.citationLink.deleteMany({ where: { id, userId } })).count);
  if (kind === "grade") return gone((await db.gradingRow.deleteMany({ where: { id, userId } })).count);
  if (kind === "objective") return gone((await db.objective.deleteMany({ where: { id, userId } })).count);
  if (kind === "deploy") return gone((await db.deployEvent.deleteMany({ where: { id, userId } })).count);
  if (kind === "person") return gone((await db.person.updateMany({ where: { id, userId, deletedAt: null }, data: { deletedAt: new Date() } })).count);
  if (kind === "attendance") return gone((await db.attendanceMark.deleteMany({ where: { id, userId } })).count);
  fail(400, "That tile cannot add this yet.");
}

async function taskTx(db: Db, userId: string, draft: Parameters<typeof createTask>[2]) {
  return db.$transaction(async (tx) => {
    const task = await createTask(tx, userId, draft, "me");
    return { id: task.id, kind: draft.taskType ?? "task", title: task.title, undoEntryId: lastUndoId(tx) ?? null };
  });
}

async function createTaskEntry(db: Db, userId: string, kind: string, raw: unknown) {
  if (kind === "mock") {
    const body = z.object({ score: z.coerce.number().int().min(0).max(10000), outOf: z.coerce.number().int().min(1).max(10000), subject: z.string().max(80).optional(), day: day.optional() }).parse(raw);
    if (body.score > body.outOf) fail(400, "That score is larger than the paper.");
    const subject = body.subject?.trim() ?? "";
    return taskTx(db, userId, {
      title: subject ? `Mock ${body.score}/${body.outOf} · ${subject}` : `Mock ${body.score}/${body.outOf}`,
      status: "done",
      taskType: "mock",
      measure: body.score,
      weight: body.outOf,
      subject: subject || null,
      due: body.day ?? null,
      owner: "me",
    });
  }
  if (kind === "matter") {
    const body = z.object({ title, orderDate: day, rule: z.string(), court: z.string().max(80).optional(), stage: z.string().max(40).optional() }).parse(raw);
    if (!isLimitationRule(body.rule)) fail(400, "Pick a limitation rule.");
    return taskTx(db, userId, {
      title: body.title,
      status: "todo",
      taskType: "matter",
      orderDate: body.orderDate,
      limitationRule: body.rule,
      court: body.court?.trim() || null,
      matterStage: body.stage?.trim() || "Pleadings",
      owner: "me",
    });
  }
  if (kind === "hearing") {
    const body = z.object({ title, day, court: z.string().max(80).optional(), stage: z.string().max(40).optional() }).parse(raw);
    return taskTx(db, userId, {
      title: body.title,
      status: "todo",
      taskType: "hearing",
      startsAt: `${body.day}T00:00:00.000Z`,
      due: body.day,
      court: body.court?.trim() || null,
      matterStage: body.stage?.trim() || null,
      owner: "me",
    });
  }
  if (kind === "time") {
    const body = z.object({ title, hours: z.coerce.number().min(0.25).max(24) }).parse(raw);
    return taskTx(db, userId, {
      title: body.title,
      status: "done",
      taskType: "time",
      measure: Math.round(body.hours * 60),
      owner: "me",
    });
  }
  if (kind === "paper") {
    const body = z.object({ title, words: z.coerce.number().int().min(0).max(200000).optional(), stage: z.string().max(40).optional() }).parse(raw);
    return taskTx(db, userId, {
      title: body.title,
      status: "todo",
      taskType: "paper",
      wordCount: body.words ?? null,
      pipelineStage: body.stage?.trim() || "To read",
      owner: "me",
    });
  }
  if (kind === "exam") {
    const body = z.object({ day }).parse(raw);
    const existing = await db.task.findFirst({ where: { userId, deletedAt: null, taskType: "exam" }, orderBy: { updatedAt: "desc" } });
    if (existing) {
      await db.task.update({ where: { id: existing.id }, data: { due: new Date(`${body.day}T00:00:00.000Z`), title: "Exam" } });
      return { id: existing.id, kind, title: "Exam", undoEntryId: null };
    }
    return taskTx(db, userId, { title: "Exam", status: "todo", taskType: "exam", due: body.day, owner: "me" });
  }
  const body = z.object({ title, day: day.optional(), subject: z.string().max(80).optional(), stage: z.string().max(40).optional() }).parse(raw);
  const taskType = kind === "task" ? "note" : kind;
  return taskTx(db, userId, {
    title: body.title,
    status: "todo",
    taskType,
    due: body.day ?? null,
    subject: body.subject?.trim() || null,
    pipelineStage: body.stage?.trim() || null,
    owner: "me",
  });
}

async function plain<T extends { id: string }>(row: T, kind: string, label: string) {
  return { id: row.id, kind, title: label, undoEntryId: null as string | null };
}

async function createSlot(db: Db, userId: string, raw: unknown) {
  const body = z
    .object({ title, weekday: z.coerce.number().int().min(0).max(6), start: hm, end: hm, course: z.string().max(80).optional() })
    .parse(raw);
  const start = minutes(body.start);
  const end = minutes(body.end);
  if (end <= start) fail(400, "The class has to end after it starts.");
  const row = await db.timetableSlot.create({
    data: { userId, title: body.title, weekday: body.weekday, startMin: start, endMin: end, course: body.course?.trim() ?? "" },
  });
  return plain(row, "slot", row.title);
}

async function createHoliday(db: Db, userId: string, raw: unknown) {
  const body = z.object({ day, name: title }).parse(raw);
  const row = await db.courtHoliday.create({ data: { userId, day: new Date(`${body.day}T00:00:00.000Z`), name: body.name } });
  return plain(row, "holiday", row.name);
}

async function createPart(db: Db, userId: string, raw: unknown) {
  const body = z.object({ name: title, qty: z.coerce.number().int().min(1).max(10000).optional(), status: z.enum(["out", "ordered", "in"]).optional() }).parse(raw);
  const row = await db.partRow.create({ data: { userId, name: body.name, qty: body.qty ?? 1, status: body.status ?? "out" } });
  return plain(row, "part", row.name);
}

async function createTest(db: Db, userId: string, raw: unknown) {
  const body = z.object({ name: title, build: z.string().max(40).optional(), status: z.enum(["pass", "fail", "unknown"]).optional() }).parse(raw);
  const row = await db.testResult.create({ data: { userId, name: body.name, build: body.build?.trim() ?? "", status: body.status ?? "unknown" } });
  return plain(row, "test", row.name);
}

async function createCitation(db: Db, userId: string, raw: unknown) {
  const body = z.object({ from: title, to: title }).parse(raw);
  const row = await db.citationLink.create({ data: { userId, fromTitle: body.from, toTitle: body.to } });
  return plain(row, "citation", row.fromTitle);
}

async function createGrade(db: Db, userId: string, raw: unknown) {
  const body = z.object({ className: title, expected: z.coerce.number().int().min(0).max(1000), marked: z.coerce.number().int().min(0).max(1000) }).parse(raw);
  const row = await db.gradingRow.create({ data: { userId, className: body.className, expected: body.expected, marked: body.marked } });
  return plain(row, "grade", row.className);
}

async function createObjective(db: Db, userId: string, raw: unknown) {
  const body = z.object({ title, progress: z.coerce.number().int().min(0).max(100).optional() }).parse(raw);
  const row = await db.objective.create({ data: { userId, title: body.title, progress: body.progress ?? 0 } });
  return plain(row, "objective", row.title);
}

async function createDeploy(db: Db, userId: string, raw: unknown) {
  const body = z.object({ name: title, env: z.string().max(20).optional() }).parse(raw);
  const row = await db.deployEvent.create({ data: { userId, name: body.name, env: body.env?.trim() || "prod" } });
  return plain(row, "deploy", row.name);
}

async function createPerson(db: Db, userId: string, raw: unknown) {
  const body = z
    .object({ name: title, capacity: z.coerce.number().min(0).max(80).optional(), cadence: z.coerce.number().int().min(1).max(90).optional() })
    .parse(raw);
  const row = await db.person.create({
    data: {
      userId,
      name: body.name,
      confidence: 1,
      capacityHours: body.capacity ?? null,
      oneOnOneDays: body.cadence ?? null,
    },
  });
  return plain(row, "person", row.name);
}

async function createAttendance(db: Db, userId: string, raw: unknown) {
  const body = z.object({ name: title, present: z.enum(["yes", "no"]).optional(), day: day.optional() }).parse(raw);
  const person = await findOrCreatePerson(db, userId, body.name);
  const row = await db.attendanceMark.create({
    data: {
      userId,
      personId: person.id,
      day: new Date(`${body.day ?? new Date().toISOString().slice(0, 10)}T00:00:00.000Z`),
      present: body.present !== "no",
    },
  });
  return plain(row, "attendance", body.name);
}

async function findOrCreatePerson(db: Db, userId: string, name: string) {
  const existing = await db.person.findFirst({ where: { userId, deletedAt: null, name: { equals: name, mode: "insensitive" } } });
  if (existing) return existing;
  return db.person.create({ data: { userId, name, confidence: 1 } });
}

export type DeskTaskRow = Prisma.TaskGetPayload<{ select: typeof TASK_SELECT }>;

export const TASK_SELECT = {
  id: true,
  title: true,
  status: true,
  taskType: true,
  due: true,
  startsAt: true,
  court: true,
  matterStage: true,
  orderDate: true,
  subject: true,
  weight: true,
  wordCount: true,
  pipelineStage: true,
  measure: true,
  limitationRule: true,
  projectId: true,
  sourceRef: true,
} as const;
