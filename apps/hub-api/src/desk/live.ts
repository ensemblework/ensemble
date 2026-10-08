import type { PrismaClient } from "@prisma/client";
import { loadSettings } from "../lib/settings.js";
import { zonedParts } from "../lib/clock.js";
import { isLimitationRule, limitationDue, daysBetween, type LimitationRule } from "./limitation.js";
import { TASK_SELECT } from "./entries.js";
import { isListedArtifact } from "./artifacts.js";
import { isGuestIn, visibleArtifacts } from "../sharing/context.js";

const TASKS = 48;
const MATTERS = 24;
const LISTS = 12;

function iso(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function stamp(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function artifactSource(metadata: unknown, kind: string): string {
  if (metadata && typeof metadata === "object" && "source" in metadata) {
    const source = (metadata as { source?: unknown }).source;
    if (typeof source === "string" && source.trim()) return source.trim();
  }
  return kind.replaceAll("_", " ");
}

export async function loadDeskLive(db: PrismaClient, userId: string, now = new Date()) {
  const settings = await loadSettings(db, userId);
  const today = zonedParts(settings.timezone, now).date;
  const holidayFrom = new Date(now.getTime() - 400 * 86_400_000);
  const holidayTo = new Date(now.getTime() + 500 * 86_400_000);
  const [tasks, matters, deliverables, people, meetings, artifacts, reminders, slots, holidays, present, absent, objectives, deploys, parts, tests, citations, grading, repos, projects] =
    await Promise.all([
      db.task.findMany({ where: { userId, deletedAt: null }, orderBy: { updatedAt: "desc" }, take: TASKS, select: TASK_SELECT }),
      db.task.findMany({
        where: { userId, deletedAt: null, orderDate: { not: null } },
        orderBy: { orderDate: "asc" },
        take: MATTERS,
        select: TASK_SELECT,
      }),
      db.deliverable.findMany({
        where: { userId, deletedAt: null },
        orderBy: { due: "asc" },
        take: LISTS,
        select: { id: true, title: true, due: true, status: true },
      }),
      db.person.findMany({
        where: { userId, deletedAt: null },
        orderBy: { name: "asc" },
        take: 16,
        select: { id: true, name: true, role: true, capacityHours: true, oneOnOneDays: true, lastInteraction: true },
      }),
      db.meetingNote.findMany({
        where: { userId, deletedAt: null },
        orderBy: { askedAt: "desc" },
        take: 8,
        select: { id: true, title: true },
      }),
      db.artifact.findMany({
        where: { userId, deletedAt: null, AND: [visibleArtifacts(userId)] },
        orderBy: { ts: "desc" },
        take: 8,
        select: { id: true, title: true, kind: true, url: true, ts: true, metadata: true },
      }),
      // Reminders are private to the space's owner.
      isGuestIn(userId)
        ? Promise.resolve([] as Array<{ id: string; title: string; dueDate: string }>)
        : db.reminder.findMany({
            where: { userId, deletedAt: null, dismissedAt: null },
            orderBy: { dueDate: "asc" },
            take: 8,
            select: { id: true, title: true, dueDate: true },
          }),
      db.timetableSlot.findMany({ where: { userId }, orderBy: [{ weekday: "asc" }, { startMin: "asc" }], take: 40 }),
      db.courtHoliday.findMany({
        where: { userId, day: { gte: holidayFrom, lt: holidayTo } },
        orderBy: { day: "asc" },
        take: 40,
        select: { id: true, day: true, name: true },
      }),
      db.attendanceMark.count({ where: { userId, present: true } }),
      db.attendanceMark.count({ where: { userId, present: false } }),
      db.objective.findMany({ where: { userId }, orderBy: { title: "asc" }, take: 8 }),
      db.deployEvent.findMany({ where: { userId }, orderBy: { at: "desc" }, take: 8 }),
      db.partRow.findMany({ where: { userId }, orderBy: { name: "asc" }, take: 20 }),
      db.testResult.findMany({ where: { userId }, take: 12 }),
      db.citationLink.findMany({ where: { userId }, take: 16 }),
      db.gradingRow.findMany({ where: { userId }, take: 12 }),
      db.repo.findMany({ where: { userId, deletedAt: null }, orderBy: { fullName: "asc" }, take: 12, select: { id: true, fullName: true } }),
      db.project.findMany({ where: { userId, deletedAt: null }, orderBy: { name: "asc" }, take: 12, select: { id: true, name: true } }),
    ]);

  const byId = new Map(tasks.map((row) => [row.id, row]));
  for (const row of matters) if (!byId.has(row.id)) byId.set(row.id, row);
  const merged = [...byId.values()];
  const holidayRows = holidays.map((row) => ({ day: row.day.toISOString().slice(0, 10), name: row.name }));
  const limitation = merged
    .filter((row) => row.orderDate && row.limitationRule && isLimitationRule(row.limitationRule))
    .map((row) => {
      const hit = limitationDue(row.orderDate!.toISOString().slice(0, 10), row.limitationRule as LimitationRule, holidayRows, today);
      return { id: row.id, title: row.title, court: row.court, due: hit.due, days: hit.days, shifted: hit.shifted, note: hit.note };
    })
    .sort((a, b) => a.days - b.days)
    .slice(0, 12);

  const countdowns = merged
    .filter((row) => row.due && (row.taskType === "exam" || row.taskType === "phase" || row.taskType === "deadline"))
    .map((row) => ({ id: row.id, title: row.title, due: iso(row.due)!, days: daysBetween(today, iso(row.due)!) }))
    .sort((a, b) => a.days - b.days)
    .slice(0, 8);

  return {
    today,
    tasks: merged.slice(0, TASKS).map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      taskType: row.taskType,
      due: iso(row.due),
      startsAt: stamp(row.startsAt),
      court: row.court,
      matterStage: row.matterStage,
      orderDate: iso(row.orderDate),
      subject: row.subject,
      weight: row.weight,
      wordCount: row.wordCount,
      pipelineStage: row.pipelineStage,
      measure: row.measure,
      rule: row.limitationRule,
      projectId: row.projectId,
      starter: row.sourceRef.startsWith("template:"),
    })),
    deliverables: deliverables.map((row) => ({ id: row.id, title: row.title, due: iso(row.due), status: row.status })),
    people: people.map((row) => ({
      id: row.id,
      name: row.name,
      role: row.role,
      capacityHours: row.capacityHours,
      oneOnOneDays: row.oneOnOneDays,
      lastInteraction: stamp(row.lastInteraction),
    })),
    meetings: meetings.map((row) => ({ id: row.id, title: row.title })),
    artifacts: artifacts.filter((row) => isListedArtifact(row)).map((row) => ({
      id: row.id,
      title: row.title,
      kind: row.kind,
      url: row.url,
      ts: row.ts.toISOString(),
      source: artifactSource(row.metadata, row.kind),
    })),
    reminders: reminders.map((row) => ({ id: row.id, title: row.title, dueDate: row.dueDate })),
    slots: slots.map((row) => ({ id: row.id, title: row.title, weekday: row.weekday, startMin: row.startMin, endMin: row.endMin, course: row.course })),
    holidays: holidays.map((row) => ({ id: row.id, day: row.day.toISOString().slice(0, 10), name: row.name })),
    attendance: { present, absent },
    objectives: objectives.map((row) => ({ id: row.id, title: row.title, progress: row.progress })),
    deploys: deploys.map((row) => ({ id: row.id, name: row.name, env: row.env, at: row.at.toISOString() })),
    parts: parts.map((row) => ({ id: row.id, name: row.name, status: row.status, qty: row.qty })),
    tests: tests.map((row) => ({ id: row.id, name: row.name, build: row.build, status: row.status })),
    citations: citations.map((row) => ({ id: row.id, fromTitle: row.fromTitle, toTitle: row.toTitle })),
    grading: grading.map((row) => ({ id: row.id, className: row.className, expected: row.expected, marked: row.marked })),
    repos: repos.map((row) => ({ id: row.id, fullName: row.fullName })),
    projects: projects.map((row) => ({ id: row.id, name: row.name })),
    limitation,
    countdowns,
  };
}
