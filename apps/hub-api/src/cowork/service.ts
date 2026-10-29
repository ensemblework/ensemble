import { dataErasureVersion } from "../lib/workspace-data.js";
import { matchExcerpt } from "../bridge/text.js";
/**
 * Database side of the cowork surfaces. Pure wording lives next to this file.
 * Every query is scoped to userId. Meeting notes are soft-deleted, never hard-deleted here.
 */
import { Prisma, type PrismaClient, type TaskStatus } from "@prisma/client";
import { claimSlot } from "../jobs/claim.js";
import { PageDocument, moduleDenied, restoreMentionLinks } from "@ensemble/shared-types";
import { separateLists } from "../imports/markdown.js";
import { markdownToNodes, pageMarkdown } from "../pages/markdown.js";
import { isReadKind, readItem, searchHub, todayBriefing } from "../bridge/service.js";
import { hubUrl } from "../bridge/text.js";
import { isIsoDate, zonedDateTimeToUtc, zonedParts } from "../lib/clock.js";
import { loadSettings } from "../lib/settings.js";
import { lastUndoId } from "../lib/undo.js";
import { softDelete } from "../services/records.js";
import { createTask, updateTask } from "../services/tasks.js";
import { composeAskAnswer, pathFromHubUrl, searchTerms, type AskSource } from "./ask.js";
import { renderMorningBrief } from "./morning-skill.js";
import { formatMorningBrief } from "./brief.js";
import { parseCapture, type ParsedCapture } from "./capture.js";
import { addCalendarDays, calendarLabel, weekBounds } from "./dates.js";
import {
  CALENDAR_WRITE_MESSAGE,
  buildMeetingRecap,
  decisionLines,
  extractiveAnswer,
  meetingPhase,
  parseCrossMeetingQuestion,
  participantNames,
  type MeetingPhase,
} from "./meetings.js";
import { nudgeQuestion, nudgeReasons, pathToDone, OPEN_STATUSES, type NudgeReason } from "./nudges.js";
import {
  agentSummary,
  clipSummary,
  recapHighlights,
  recapNarrative,
  renderWeeklyRecap,
  slippedLinks,
  weekShape,
  type CompletedFact,
  type RecapProject,
  type RecapStats,
} from "./recap.js";
import { currentScope, isGuestIn } from "../sharing/context.js";

type Db = PrismaClient;
/** Meeting-session writes also run inside the assistant's Apply transaction. */
type Tx = PrismaClient | Prisma.TransactionClient;

/** Keyboard only. Microphone capture is a later step. */
export const VOICE_TODO = "Type your notes below. Microphone recording is not available yet.";

function fail(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

/** One winner per user, connector, and slot. A second caller in the same slot gets false. */
function claim(db: Db, userId: string, connector: string, slot: string): Promise<boolean> {
  return claimSlot(db, userId, connector, slot);
}

function dayStart(date: string, timezone: string): Date {
  return zonedDateTimeToUtc(date, "00:00", timezone);
}

export async function deliverMorningBrief(db: Db, userId: string, render = renderMorningBrief) {
  const settings = await loadSettings(db, userId);
  const clock = zonedParts(settings.timezone);
  const start = dayStart(clock.date, settings.timezone);
  const existing = await db.notification.findFirst({
    where: { userId, kind: "morning_brief", createdAt: { gte: start } },
    orderBy: { createdAt: "desc" },
  });
  if (!settings.morningBrief.enabled) {
    return { delivered: false, reason: "off" as const, notification: existing, brief: null };
  }
  if (existing) return { delivered: false, reason: "already" as const, notification: existing, brief: null };
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { createdAt: true } });
  if (zonedParts(settings.timezone, user.createdAt).date >= clock.date) return { delivered: false, reason: "early" as const, notification: null, brief: null };
  if (clock.time < settings.morningBrief.time) {
    return { delivered: false, reason: "early" as const, notification: null, brief: null };
  }
  if (!(await claim(db, userId, "schedule:brief", `brief@${clock.date}`))) {
    const raced = await db.notification.findFirst({
      where: { userId, kind: "morning_brief", createdAt: { gte: start } },
      orderBy: { createdAt: "desc" },
    });
    return { delivered: false, reason: "already" as const, notification: raced, brief: null };
  }
  const erasureVersion = await dataErasureVersion(db, userId);
  const briefing = await todayBriefing(db, userId);
  const context = { ...briefing, timezone: settings.timezone };
  let brief;
  try { brief = await render(db, userId, context); }
  catch {
    if (await dataErasureVersion(db, userId) !== erasureVersion) return { delivered: false, reason: "erased" as const, notification: null, brief: null };
    brief = formatMorningBrief(context);
    brief.body += "\n\nYour personal brief could not be generated. Check your model connection in Settings → Models. This is the current overview of your day.";
  }
  if (await dataErasureVersion(db, userId) !== erasureVersion) return { delivered: false, reason: "erased" as const, notification: null, brief: null };
  const notification = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    if (await dataErasureVersion(tx, userId) !== erasureVersion) return null;
    return tx.notification.create({
    data: {
      userId,
      kind: "morning_brief",
      title: brief.title,
      body: brief.body,
      channel: "hub",
      url: "/morning-brief",
    },
    });
  });
  if (!notification) return { delivered: false, reason: "erased" as const, notification: null, brief: null };
  return { delivered: true, reason: "sent" as const, notification, brief };
}

export async function listNotifications(db: Db, userId: string) {
  const [rows, user] = await Promise.all([
    db.notification.findMany({
      // Read notifications leave the list: the bell keeps no history.
      where: { userId, channel: "hub", readAt: null },
      orderBy: { createdAt: "desc" },
      take: 60,
    }),
    db.user.findUnique({ where: { id: userId }, select: { moduleSet: true } }),
  ]);
  return rows.filter((row) => !row.url || !moduleDenied(row.url, user?.moduleSet ?? null)).map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    url: row.url,
    urgent: row.urgent,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function markNotificationRead(db: Db, userId: string, id: string) {
  const result = await db.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: new Date() } });
  if (!result.count && !(await db.notification.findFirst({ where: { id, userId }, select: { id: true } }))) {
    throw fail(404, "Notification not found.");
  }
  return { updated: result.count };
}

/** Every unread notification, or only `ids` (one tab of the bell). */
export async function markAllNotificationsRead(db: Db, userId: string, ids?: string[]) {
  const result = await db.notification.updateMany({ where: { userId, readAt: null, channel: "hub", ...(ids ? { id: { in: ids } } : {}) }, data: { readAt: new Date() } });
  return { updated: result.count };
}

export interface PersonRow {
  id: string;
  name: string;
  email: string | null;
}

export function matchAttendees(names: string[], people: PersonRow[]) {
  return names.map((name) => {
    const lower = name.toLowerCase();
    const exact = people.find((person) => person.name.toLowerCase() === lower || person.email?.toLowerCase() === lower);
    const first = people.filter((person) => person.name.split(/\s+/)[0]?.toLowerCase() === lower);
    const hit = exact ?? (first.length === 1 ? first[0] : undefined);
    return hit ? { id: hit.id, name: hit.name } : { id: null as string | null, name };
  });
}

function taskTouches(people: string[], attendees: Array<{ id: string | null; name: string }>): boolean {
  const ids = new Set(attendees.map((person) => person.id).filter((id): id is string => Boolean(id)));
  const names = new Set(attendees.map((person) => person.name.toLowerCase()));
  return people.some((value) => ids.has(value) || names.has(value.toLowerCase()));
}

async function previewCapture(db: Db, userId: string, text: string): Promise<ParsedCapture & { matched: Array<{ id: string; name: string }>; unmatched: string[] }> {
  const settings = await loadSettings(db, userId);
  const clock = zonedParts(settings.timezone);
  const people = await db.person.findMany({ where: { userId, deletedAt: null }, select: { id: true, name: true, email: true } });
  const parsed = parseCapture(text, { date: clock.date, weekday: clock.weekday }, people.map((person) => person.name));
  const attendees = matchAttendees(parsed.personNames, people);
  const matched: Array<{ id: string; name: string }> = [];
  const unmatched: string[] = [];
  for (const person of attendees) {
    if (person.id) {
      if (!matched.some((row) => row.id === person.id)) matched.push({ id: person.id, name: person.name });
    } else if (!unmatched.some((name) => name.toLowerCase() === person.name.toLowerCase())) unmatched.push(person.name);
  }
  return { ...parsed, matched, unmatched };
}

export async function previewQuickCapture(db: Db, userId: string, text: string) {
  const trimmed = text.trim();
  if (!trimmed) throw fail(400, "Type a reminder first.");
  return previewCapture(db, userId, trimmed);
}

export async function commitQuickCapture(db: Db, userId: string, text: string) {
  const { captureDeskIntent } = await import("../desk/intents.js");
  const desk = await captureDeskIntent(db, userId, text.trim());
  if (desk) return desk;
  const parsed = await previewCapture(db, userId, text.trim());
  if (!parsed.title) throw fail(400, "Type a reminder first.");
  const people = [...parsed.matched.map((person) => person.id), ...parsed.unmatched];
  const created = await db.$transaction(async (tx) => {
    const task = await createTask(
      tx,
      userId,
      {
        title: parsed.title,
        description: text.trim(),
        owner: "me",
        status: "todo",
        due: parsed.due,
        people,
        sourceKind: "manual",
        sourceRef: "quick-capture",
      },
      "me",
    );
    return { task, undoEntryId: lastUndoId(tx) ?? null };
  });
  return { ...created, parsed };
}

const OPEN = new Set<string>(OPEN_STATUSES);

export async function listNudges(db: Db, userId: string, now = new Date()) {
  const settings = await loadSettings(db, userId);
  if (!settings.staleNudge.enabled) return { days: settings.staleNudge.untouchedDays, nudges: [] };
  const tasks = await db.task.findMany({
    where: { userId, deletedAt: null, status: { in: [...OPEN_STATUSES] } },
    select: { id: true, title: true, status: true, due: true, updatedAt: true, snoozedUntil: true, nudgePausedUntil: true },
    take: 400,
  });
  const nudges = tasks
    .map((task) => {
      const reasons = nudgeReasons(task, now, settings.staleNudge.untouchedDays);
      if (!reasons.length) return null;
      return {
        id: task.id,
        title: task.title,
        status: task.status,
        due: task.due?.toISOString() ?? null,
        updatedAt: task.updatedAt.toISOString(),
        reasons,
        question: nudgeQuestion(reasons, settings.staleNudge.untouchedDays),
      };
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row))
    .slice(0, 24);
  return { days: settings.staleNudge.untouchedDays, nudges };
}

export async function ensureStaleNotice(db: Db, userId: string) {
  const settings = await loadSettings(db, userId);
  if (!settings.staleNudge.enabled) return { created: false };
  const clock = zonedParts(settings.timezone);
  const gate = settings.morningBrief.enabled ? settings.morningBrief.time : "09:00";
  if (clock.time < gate) return { created: false };
  const { nudges } = await listNudges(db, userId);
  if (!nudges.length) return { created: false };
  if (!(await claim(db, userId, "schedule:nudges", `nudges@${clock.date}`))) return { created: false };
  await db.notification.create({
    data: {
      userId,
      kind: "stale_nudge",
      channel: "hub",
      title: nudges.length === 1 ? "1 item has gone quiet" : `${nudges.length} items have gone quiet`,
      body: "Still relevant? Keep it, snooze it, mark it done, or move it to Trash.",
      url: "/today#still-relevant",
    },
  });
  return { created: true };
}

export async function actOnNudge(db: Db, userId: string, taskId: string, action: "keep" | "snooze" | "done" | "trash") {
  const settings = await loadSettings(db, userId);
  const days = action === "snooze" ? 7 : settings.staleNudge.untouchedDays;
  const until = new Date(Date.now() + days * 86_400_000).toISOString();
  if (action === "trash") {
    const removed = await db.$transaction(async (tx) => {
      const result = await softDelete(tx, userId, "task", taskId, "me");
      return { label: result.label, undoEntryId: lastUndoId(tx) ?? null };
    });
    return { action, label: removed.label, undoEntryId: removed.undoEntryId };
  }
  const updated = await db.$transaction(async (tx) => {
    if (action === "done") {
      const existing = await tx.task.findFirst({ where: { id: taskId, userId, deletedAt: null } });
      if (!existing) throw fail(404, "That task was not found.");
      let current = existing;
      for (const status of pathToDone(existing.status)) {
        current = await updateTask(tx, userId, taskId, { status: status as TaskStatus }, "me");
      }
      return { id: current.id, status: current.status, undoEntryId: lastUndoId(tx) ?? null };
    }
    const task =
      action === "snooze"
        ? await updateTask(tx, userId, taskId, { snoozedUntil: until, nudgePausedUntil: until }, "me")
        : await updateTask(tx, userId, taskId, { nudgePausedUntil: until }, "me");
    return { id: task.id, status: task.status, undoEntryId: lastUndoId(tx) ?? null };
  });
  return { action, taskId: updated.id, status: updated.status, undoEntryId: updated.undoEntryId };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return { ...(value as Record<string, unknown>) };
  return {};
}

/** Markdown → the page document the notes editor shows. */
export function notesDocument(markdown: string): PageDocument {
  const content = markdown.trim() ? markdownToNodes(separateLists(markdown)) : [];
  return restoreMentionLinks(PageDocument.parse({ type: "doc", content: content.length ? content : [{ type: "paragraph" }] }));
}

/** The notes as a page: the saved document, or (for notes typed before 13 Oct 2026) one made from their Markdown. */
export function meetingContent(row: { content?: unknown; notes: string }): PageDocument | null {
  const saved = row.content ? PageDocument.safeParse(row.content) : null;
  if (saved?.success) return saved.data;
  return row.notes.trim() ? notesDocument(row.notes) : null;
}

/**
 * What a save writes: a document from the editor becomes `content` with its Markdown in `notes`;
 * Markdown alone (the assistant, older clients) becomes both.
 */
export function meetingNotesFields(input: { notes?: string; content?: unknown }): { notes: string; content: Prisma.InputJsonValue } | null {
  if (input.content !== undefined) {
    const doc = restoreMentionLinks(PageDocument.parse(input.content));
    return { notes: pageMarkdown(doc, "").slice(0, 100_000), content: doc as Prisma.InputJsonValue };
  }
  if (input.notes !== undefined) return { notes: input.notes, content: notesDocument(input.notes) as Prisma.InputJsonValue };
  return null;
}

function sessionJson(row: {
  id: string;
  artifactId: string | null;
  title: string;
  notes: string;
  content?: unknown;
  recap: string;
  status: string;
  attachState: string;
  personIds: string[];
  projectId?: string | null;
  startedAt: Date;
  endedAt: Date | null;
}, withContent = true) {
  return {
    id: row.id,
    artifactId: row.artifactId,
    title: row.title,
    notes: row.notes,
    ...(withContent ? { content: meetingContent(row) } : {}),
    recap: row.recap,
    status: row.status,
    attachState: row.attachState,
    personIds: row.personIds,
    projectId: row.projectId ?? null,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    href: `/meetings?session=${row.id}`,
  };
}

async function ownedSession(db: Tx, userId: string, id: string) {
  const row = await db.meetingSession.findFirst({ where: { id, userId, deletedAt: null } });
  if (!row) throw fail(404, "That meeting was not found.");
  return row;
}

async function syncNote(
  db: Tx,
  userId: string,
  session: { id: string; meetingNoteId: string | null; title: string; notes: string; personIds: string[]; artifactId: string | null; startedAt: Date },
) {
  const data = {
    title: session.title,
    answer: session.notes,
    personIds: session.personIds,
    artifactId: session.artifactId,
    source: "live",
    status: "ready",
    occurredAt: session.startedAt,
  };
  if (session.meetingNoteId) {
    await db.meetingNote.updateMany({ where: { id: session.meetingNoteId, userId }, data });
    return session.meetingNoteId;
  }
  const note = await db.meetingNote.create({ data: { userId, ...data, prompt: "" } });
  await db.meetingSession.update({ where: { id: session.id }, data: { meetingNoteId: note.id } });
  return note.id;
}

async function prepBundle(
  db: Tx,
  userId: string,
  attendees: Array<{ id: string | null; name: string }>,
) {
  const since = new Date(Date.now() - 180 * 86_400_000);
  const [tasks, notes, sessions] = await Promise.all([
    db.task.findMany({
      where: { userId, deletedAt: null },
      select: { id: true, title: true, status: true, due: true, people: true, notes: true, description: true },
      take: 300,
      orderBy: { updatedAt: "desc" },
    }),
    db.meetingNote.findMany({
      where: { userId, deletedAt: null, askedAt: { gte: since } },
      select: { id: true, title: true, answer: true, personIds: true },
      take: 80,
      orderBy: { askedAt: "desc" },
    }),
    db.meetingSession.findMany({
      where: { userId, deletedAt: null, startedAt: { gte: since } },
      select: { id: true, title: true, notes: true, recap: true, personIds: true },
      take: 80,
      orderBy: { startedAt: "desc" },
    }),
  ]);
  const openTasks = tasks
    .filter((task) => OPEN.has(task.status) && taskTouches(task.people, attendees))
    .slice(0, 6)
    .map((task) => ({ id: task.id, title: task.title, status: task.status, due: task.due?.toISOString() ?? null, href: `/tasks/${task.id}` }));
  const blobs = [
    ...notes.map((note) => ({ text: `${note.title}\n${note.answer}`, personIds: note.personIds })),
    ...sessions.map((session) => ({ text: `${session.title}\n${session.notes}\n${session.recap}`, personIds: session.personIds })),
    ...tasks
      .filter((task) => task.status === "done" && taskTouches(task.people, attendees))
      .map((task) => ({ text: task.notes || task.description || task.title, personIds: task.people })),
  ];
  const ids = new Set(attendees.map((person) => person.id).filter((id): id is string => Boolean(id)));
  const names = attendees.map((person) => person.name.toLowerCase());
  const related = blobs.filter((blob) => {
    if (blob.personIds.some((id) => ids.has(id))) return true;
    const lower = blob.text.toLowerCase();
    return names.some((name) => name.length > 1 && lower.includes(name));
  });
  const decisions = [...new Set(related.flatMap((blob) => decisionLines(blob.text)))].slice(0, 6).map((text) => ({ text }));
  return { openTasks, decisions };
}

export async function listMeetingCues(db: Db, userId: string, now = new Date()) {
  const horizon = new Date(now.getTime() + 24 * 3600_000);
  const lookback = new Date(now.getTime() - 48 * 3600_000);
  const [events, sessions, people] = await Promise.all([
    db.artifact.findMany({
      where: { userId, deletedAt: null, kind: "event", ts: { gte: lookback, lt: horizon } },
      orderBy: { ts: "asc" },
      take: 40,
      select: { id: true, title: true, ts: true, metadata: true, participants: true },
    }),
    db.meetingSession.findMany({
      where: { userId, deletedAt: null, OR: [{ status: "live" }, { endedAt: { gte: new Date(now.getTime() - 36 * 3600_000) } }] },
    }),
    db.person.findMany({ where: { userId, deletedAt: null }, select: { id: true, name: true, email: true } }),
  ]);
  const cues = [];
  for (const event of events) {
    const meta = asRecord(event.metadata);
    const end = typeof meta.end === "string" ? new Date(meta.end) : null;
    const phase: MeetingPhase = meetingPhase(event.ts, end, now);
    if (phase === "past") continue;
    const names = participantNames(event.participants);
    const session =
      sessions
        .filter((row) => row.artifactId === event.id)
        .sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime())[0] ?? null;
    if (names.length === 0 && !session) continue;
    if (phase === "follow_up" && session && session.attachState !== "pending" && session.status === "ended") continue;
    const attendees = matchAttendees(names, people);
    if (phase !== "follow_up" && attendees.length === 0 && !session) continue;
    const prep = attendees.length ? await prepBundle(db, userId, attendees) : { openTasks: [], decisions: [] };
    cues.push({
      kind: phase === "follow_up" ? "follow_up" : phase === "live" ? "live" : "prep",
      artifactId: event.id,
      session: session ? sessionJson(session) : null,
      title: event.title || "Meeting",
      start: event.ts.toISOString(),
      end: end && !Number.isNaN(end.getTime()) ? end.toISOString() : null,
      attendees,
      decisions: prep.decisions,
      openTasks: prep.openTasks,
      attachState: session?.attachState ?? "none",
    });
  }
  for (const session of sessions) {
    if (session.artifactId && events.some((event) => event.id === session.artifactId)) continue;
    if (session.status !== "live") continue;
    const attendees = matchAttendees([], people).concat(session.personIds.map((id) => ({ id, name: people.find((person) => person.id === id)?.name ?? id })));
    const prep = await prepBundle(db, userId, attendees);
    cues.push({
      kind: "live" as const,
      artifactId: null,
      session: sessionJson(session),
      title: session.title,
      start: session.startedAt.toISOString(),
      end: null,
      attendees,
      decisions: prep.decisions,
      openTasks: prep.openTasks,
      attachState: session.attachState,
    });
  }
  return {
    cues,
    voice: VOICE_TODO,
    calendarWrite: false as const,
    calendarWriteReason: CALENDAR_WRITE_MESSAGE,
  };
}

export async function listMeetingSessions(db: Db, userId: string) {
  const rows = await db.meetingSession.findMany({
    where: { userId, deletedAt: null },
    orderBy: { startedAt: "desc" },
    take: 200,
  });
  return { sessions: rows.map((row) => sessionJson(row, false)), voice: VOICE_TODO };
}

export async function getMeetingSession(db: Db, userId: string, id: string) {
  const session = await ownedSession(db, userId, id);
  const people = await db.person.findMany({ where: { userId, deletedAt: null, id: { in: session.personIds } }, select: { id: true, name: true, email: true } });
  const attendees = session.personIds.map((personId) => ({ id: personId, name: people.find((person) => person.id === personId)?.name ?? personId }));
  const prep = await prepBundle(db, userId, attendees);
  return { session: sessionJson(session), attendees, ...prep, voice: VOICE_TODO, calendarWrite: false, calendarWriteReason: CALENDAR_WRITE_MESSAGE };
}

export async function startMeetingSession(db: Db, userId: string, input: { artifactId?: string | null; title?: string; projectId?: string | null }) {
  let title = input.title?.trim() || "Meeting notes";
  let personIds: string[] = [];
  if (input.projectId) await ownedProject(db, userId, input.projectId);
  if (input.artifactId) {
    const event = await db.artifact.findFirst({ where: { id: input.artifactId, userId, deletedAt: null, kind: "event" } });
    if (!event) throw fail(404, "That calendar event was not found.");
    const live = await db.meetingSession.findFirst({ where: { userId, artifactId: event.id, deletedAt: null, status: "live" } });
    if (live) return { session: sessionJson(live) };
    title = input.title?.trim() || event.title || title;
    const people = await db.person.findMany({ where: { userId, deletedAt: null }, select: { id: true, name: true, email: true } });
    personIds = matchAttendees(participantNames(event.participants), people)
      .map((person) => person.id)
      .filter((id): id is string => Boolean(id));
  }
  const session = await db.meetingSession.create({
    data: { userId, title, artifactId: input.artifactId ?? null, personIds, status: "live", attachState: "none", projectId: input.projectId ?? null },
  });
  return { session: sessionJson(session) };
}

async function ownedProject(db: Tx, userId: string, id: string) {
  if (!(await db.project.findFirst({ where: { id, userId, deletedAt: null }, select: { id: true } }))) throw fail(404, "That project was not found.");
}

/** Links meeting notes to a project, or unlinks them with null. */
export async function setMeetingProject(db: Tx, userId: string, id: string, projectId: string | null) {
  const session = await ownedSession(db, userId, id);
  if (projectId) await ownedProject(db, userId, projectId);
  const updated = await db.meetingSession.update({ where: { id: session.id }, data: { projectId } });
  return { session: sessionJson(updated) };
}

export async function saveMeetingNotes(db: Tx, userId: string, id: string, change: { notes?: string; content?: unknown; title?: string }) {
  const session = await ownedSession(db, userId, id);
  await db.meetingSession.update({ where: { id: session.id }, data: { ...meetingNotesFields(change), title: change.title } });
  if (session.status === "ended") {
    const refreshed = await refreshMeetingRecap(db, userId, id);
    const updated = await ownedSession(db, userId, id);
    if (updated.meetingNoteId) await syncNote(db, userId, updated);
    return refreshed;
  }
  const updated = await ownedSession(db, userId, id);
  if (updated.meetingNoteId) await syncNote(db, userId, updated);
  return { session: sessionJson(updated) };
}

async function finishSession(db: Tx, userId: string, id: string) {
  const session = await ownedSession(db, userId, id);
  if (session.status === "ended") return session;
  const people = await db.person.findMany({ where: { userId, deletedAt: null }, select: { id: true, name: true, email: true } });
  const attendees = session.personIds.map((personId) => people.find((person) => person.id === personId)?.name ?? personId);
  const prep = await prepBundle(db, userId, session.personIds.map((personId) => ({ id: personId, name: attendees[session.personIds.indexOf(personId)] ?? personId })));
  const recap = buildMeetingRecap({
    title: session.title,
    notes: session.notes,
    attendees,
    decisions: prep.decisions.map((row) => row.text),
    openTasks: prep.openTasks.map((task) => task.title),
  });
  const ended = await db.meetingSession.update({
    where: { id: session.id },
    data: {
      status: "ended",
      endedAt: new Date(),
      recap,
      recapAt: new Date(),
      attachState: session.artifactId ? "pending" : "none",
    },
  });
  await syncNote(db, userId, ended);
  return ended;
}

export async function endMeetingSession(db: Tx, userId: string, id: string) {
  const ended = await finishSession(db, userId, id);
  return {
    session: sessionJson(ended),
    askAttach: ended.attachState === "pending",
    calendarWrite: false,
    calendarWriteReason: CALENDAR_WRITE_MESSAGE,
  };
}

export async function attachMeetingNotes(db: Db, userId: string, id: string) {
  let session = await ownedSession(db, userId, id);
  const artifactId = session.artifactId;
  if (!artifactId) throw fail(400, "These notes are not tied to a calendar event. They stay in Meeting notes.");
  if (session.status !== "ended") session = await finishSession(db, userId, id);
  const event = await db.artifact.findFirst({ where: { id: artifactId, userId, deletedAt: null } });
  if (!event) throw fail(404, "That calendar event was not found.");
  const metadata = {
    ...asRecord(event.metadata),
    ensembleNotes: session.notes,
    ensembleRecap: session.recap,
    ensembleSessionId: session.id,
    ensembleNotesAttachedAt: new Date().toISOString(),
  };
  await db.artifact.update({ where: { id: event.id }, data: { metadata: metadata as Prisma.InputJsonValue } });
  const updated = await db.meetingSession.update({ where: { id: session.id }, data: { attachState: "attached" } });
  return { session: sessionJson(updated), attached: true, calendarWrite: false, message: CALENDAR_WRITE_MESSAGE };
}

export async function declineMeetingAttach(db: Db, userId: string, id: string) {
  let session = await ownedSession(db, userId, id);
  if (session.status !== "ended") session = await finishSession(db, userId, id);
  const updated = await db.meetingSession.update({ where: { id: session.id }, data: { attachState: "declined" } });
  await syncNote(db, userId, updated);
  return { session: sessionJson(updated), kept: true };
}

export async function refreshMeetingRecap(db: Tx, userId: string, id: string) {
  const session = await ownedSession(db, userId, id);
  const people = await db.person.findMany({ where: { userId, deletedAt: null }, select: { id: true, name: true } });
  const attendees = session.personIds.map((personId) => people.find((person) => person.id === personId)?.name ?? personId);
  const prep = await prepBundle(db, userId, session.personIds.map((personId, index) => ({ id: personId, name: attendees[index] ?? personId })));
  const recap = buildMeetingRecap({
    title: session.title,
    notes: session.notes,
    attendees,
    decisions: prep.decisions.map((row) => row.text),
    openTasks: prep.openTasks.map((task) => task.title),
  });
  const updated = await db.meetingSession.update({ where: { id: session.id }, data: { recap, recapAt: new Date() } });
  return { session: sessionJson(updated) };
}

export async function trashMeetingSession(db: Db, userId: string, id: string) {
  const session = await ownedSession(db, userId, id);
  const now = new Date();
  await db.$transaction(async (tx) => {
    await tx.meetingSession.update({ where: { id: session.id }, data: { deletedAt: now } });
    if (session.meetingNoteId) {
      await tx.meetingNote.updateMany({ where: { id: session.meetingNoteId, userId, deletedAt: null }, data: { deletedAt: now } });
    }
  });
  return { deleted: true };
}

export async function summarizeMeetings(db: Db, userId: string, question: string) {
  const parsed = parseCrossMeetingQuestion(question);
  const [sessions, notes] = await Promise.all([
    db.meetingSession.findMany({
      where: { userId, deletedAt: null },
      orderBy: { startedAt: "desc" },
      take: 200,
      select: { id: true, title: true, notes: true, recap: true },
    }),
    db.meetingNote.findMany({
      where: { userId, deletedAt: null },
      orderBy: { askedAt: "desc" },
      take: 200,
      select: { id: true, title: true, answer: true },
    }),
  ]);
  const rows = [
    ...sessions.map((session) => ({
      title: session.title,
      text: `${session.notes}\n${session.recap}`.trim(),
      href: `/meetings?session=${session.id}`,
    })),
    ...notes.map((note) => ({ title: note.title, text: note.answer, href: `/meetings?note=${note.id}` })),
  ];
  if (parsed) return { ...extractiveAnswer(rows, parsed), question };
  const terms = searchTerms(question);
  const quotes = [];
  for (const row of rows) {
    for (const sentence of row.text.split(/\n+|(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean)) {
      const hay = sentence.toLowerCase();
      if (terms.length && terms.every((term) => hay.includes(term.toLowerCase()))) {
        quotes.push({ text: sentence, title: row.title, href: row.href });
      }
      if (quotes.length >= 8) break;
    }
    if (quotes.length >= 8) break;
  }
  return {
    question,
    answer: quotes.length ? "From your meeting notes:" : `I couldn't find notes about “${question.trim()}”.`,
    quotes,
  };
}

async function hitsForTerm(db: Db, userId: string, term: string, modules: string | null): Promise<AskSource[]> {
  const searched = await searchHub(db, userId, term, 6, modules);
  const sessions = await db.meetingSession.findMany({
    where: {
      userId,
      deletedAt: null,
      OR: [
        { title: { contains: term, mode: "insensitive" } },
        { notes: { contains: term, mode: "insensitive" } },
        { recap: { contains: term, mode: "insensitive" } },
      ],
    },
    take: 5,
    orderBy: { startedAt: "desc" },
  });
  const fromSearch: AskSource[] = searched.results.map((hit) => ({
    id: String(hit.id),
    kind: String(hit.kind),
    label: String(hit.label),
    excerpt: String(hit.excerpt ?? ""),
    url: String(hit.url),
    path: pathFromHubUrl(String(hit.url)),
  }));
  const fromSessions: AskSource[] = sessions.map((session) => ({
    id: session.id,
    kind: "meeting",
    label: session.title,
    excerpt: clipSummary(session.recap || session.notes, 240),
    url: hubUrl(`/meetings?session=${session.id}`),
    path: `/meetings?session=${session.id}`,
  }));
  return [...fromSessions, ...fromSearch];
}

export async function searchWorkspace(db: Db, userId: string, query: string) {
  const q = query.trim();
  if (!q) throw fail(400, "Enter a search term.");
  const user = await db.user.findUnique({ where: { id: userId }, select: { moduleSet: true } });
  const [found, sessions] = await Promise.all([
    searchHub(db, userId, q, 8, user?.moduleSet ?? ""),
    db.meetingSession.findMany({ where: { userId, deletedAt: null, OR: [{ title: { contains: q, mode: "insensitive" } }, { notes: { contains: q, mode: "insensitive" } }, { recap: { contains: q, mode: "insensitive" } }] }, take: 8, orderBy: { startedAt: "desc" } }),
  ]);
  const hits = [
    ...found.results.map((hit) => ({ id: hit.id, kind: hit.kind, label: hit.label, excerpt: hit.excerpt, path: pathFromHubUrl(hit.url) })),
    ...sessions.map((session) => ({ id: session.id, kind: "meeting", label: session.title, excerpt: matchExcerpt(`${session.notes} ${session.recap ?? ""}`, q).excerpt, path: `/meetings?session=${session.id}` })),
  ];
  const seen = new Set<string>();
  const results = hits.sort((a, b) => (b.label.toLowerCase() === q.toLowerCase() ? 2 : Number(b.label.toLowerCase().includes(q.toLowerCase()))) - (a.label.toLowerCase() === q.toLowerCase() ? 2 : Number(a.label.toLowerCase().includes(q.toLowerCase()))))
    .filter((hit) => { if (seen.has(hit.path)) return false; seen.add(hit.path); return true; }).slice(0, 12);
  return { query: q, results };
}

export async function askEnsemble(db: Db, userId: string, question: string) {
  const asked = question.trim();
  if (!asked) throw fail(400, "Ask a question first.");
  const { captureDeskIntent } = await import("../desk/intents.js");
  // A shorthand like "mock 7/10" writes to the owner's desk: only from the owner's own question.
  const desk = isGuestIn(userId) ? null : await captureDeskIntent(db, userId, asked);
  if (desk) {
    return {
      question: asked,
      answer: desk.answer,
      sources: [] as Array<{ id: string; kind: string; label: string; excerpt: string; url: string; path: string }>,
      undoEntryId: desk.undoEntryId,
    };
  }
  const terms = searchTerms(asked);
  const queries = [asked, ...terms].slice(0, 4);
  const user = await db.user.findUnique({ where: { id: userId }, select: { moduleSet: true } });
  const modules = user?.moduleSet ?? "";
  const batches = await Promise.all(queries.map((term) => hitsForTerm(db, userId, term, modules)));
  let sources = batches.flat();
  const cross = parseCrossMeetingQuestion(asked);
  let answerPrefix = "";
  if (cross) {
    const summary = await summarizeMeetings(db, userId, asked);
    answerPrefix = summary.answer;
    sources = [
      ...summary.quotes.map((quote) => ({
        id: quote.href,
        kind: "meeting",
        label: quote.title,
        excerpt: quote.text,
        url: hubUrl(quote.href),
        path: quote.href,
      })),
      ...sources,
    ];
  }
  const composed = composeAskAnswer(asked, sources);
  const top = composed.sources[0];
  if (top && isReadKind(top.kind)) {
    const read = await readItem(db, userId, top.kind, top.id, 0, 360, modules);
    if (read.found) {
      const body = read.item.body as { text?: string } | undefined;
      if (body?.text) top.excerpt = clipSummary(body.text, 360);
    }
  }
  const answer = answerPrefix ? `${answerPrefix} ${composed.sources.length ? composed.answer : ""}`.trim() : composed.answer;
  return { question: asked, answer, sources: composed.sources };
}

const DAY_MS = 86_400_000;
/** Screen-time rows read for one week; a person active all day stays well under this. */
const MAX_VIEWS = 20_000;

/**
 * The weekly recap: the lists (done, decided, slipped, meetings) plus the week in numbers, its
 * days, when and where screen time went, projects, agent runs, highlights and what is coming up.
 * Everything is scoped to the space (`userId`); screen time is the signed-in account's own
 * (`accountId`), because interaction events belong to a person, not a space.
 */
export async function weeklyRecap(db: Db, userId: string, anchor?: string, accountId = currentScope()?.accountId ?? userId) {
  const settings = await loadSettings(db, userId);
  const timeZone = settings.timezone;
  const now = new Date();
  const clock = zonedParts(timeZone, now);
  if (anchor && !isIsoDate(anchor)) throw fail(400, "Pick a real date.");
  const date = anchor ?? clock.date;
  const weekday = anchor
    ? new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(new Date(`${date}T12:00:00Z`))
    : clock.weekday;
  const bounds = weekBounds(date, weekday);
  const startUtc = dayStart(bounds.start, timeZone);
  const endUtc = dayStart(bounds.end, timeZone);
  const prevStartUtc = dayStart(addCalendarDays(bounds.start, -7), timeZone);
  const current = startUtc <= now && now < endUtc;
  // Mid-week, last week is compared up to the same moment, not its whole seven days.
  const prevEndUtc = current ? new Date(now.getTime() - 7 * DAY_MS) : startUtc;
  const cutoff = bounds.end < clock.date ? bounds.end : clock.date;
  const dueFrom = clock.date > bounds.start ? clock.date : bounds.start;
  const dueUntil = addCalendarDays(bounds.end, 7);
  const both = { gte: prevStartUtc, lt: endUtc };
  const thisWeek = { gte: startUtc, lt: endUtc };
  const guest = isGuestIn(userId);
  const [
    completedRows,
    agentDone,
    createdRows,
    overdue,
    deliverables,
    projectsDone,
    sessions,
    approvals,
    decisions,
    runs,
    firstRun,
    views,
    previousViews,
    revisions,
    pages,
    dueTasks,
    dueDeliverables,
    waitingApprovals,
    waitingDecisions,
  ] = await Promise.all([
    db.task.findMany({
      where: { userId, deletedAt: null, status: "done", completedAt: both },
      orderBy: { completedAt: "asc" },
      select: { id: true, title: true, priority: true, projectId: true, completedAt: true },
      take: 2000,
    }),
    db.taskTransition.findMany({
      where: { userId, toStatus: "done", actor: "agent", at: both },
      select: { taskId: true },
      take: 2000,
    }),
    db.task.findMany({ where: { userId, deletedAt: null, createdAt: both }, select: { createdAt: true, projectId: true }, take: 4000 }),
    db.task.findMany({
      where: { userId, deletedAt: null, status: { in: [...OPEN_STATUSES] }, due: { lt: new Date(`${cutoff}T00:00:00.000Z`) } },
      orderBy: { due: "asc" },
      select: { id: true, title: true, status: true, due: true },
      take: 100,
    }),
    db.deliverable.findMany({
      where: { userId, deletedAt: null, status: "completed", completedAt: thisWeek },
      select: { id: true, title: true, projectId: true, completedAt: true },
    }),
    db.project.findMany({ where: { userId, deletedAt: null, completedAt: thisWeek }, select: { id: true, name: true }, take: 10 }),
    db.meetingSession.findMany({
      where: { userId, deletedAt: null, startedAt: both },
      orderBy: { startedAt: "asc" },
      take: 200,
    }),
    db.approval.findMany({
      where: { userId, decidedAt: both, decision: { not: null } },
      select: { id: true, title: true, decision: true, decidedAt: true },
      take: 200,
    }),
    db.agentDecision.findMany({
      // The owner's own editors (Cursor, Claude Code…) are theirs alone; runs' questions are the space's.
      where: { userId, decidedAt: both, decision: { not: null }, ...(guest ? { source: "ensemble" } : {}) },
      select: { id: true, title: true, decision: true, decidedAt: true },
      take: 200,
    }),
    db.run.findMany({
      where: { userId, deletedAt: null, startedAt: both },
      select: { startedAt: true, outcome: true, worker: true, workspaceJob: { select: { provider: true } } },
      take: 2000,
    }),
    db.run.findFirst({ where: { userId }, orderBy: { startedAt: "asc" }, select: { startedAt: true } }),
    db.interactionEvent.findMany({
      where: { userId: accountId, kind: "view", at: thisWeek },
      select: { at: true, durationMs: true, surface: true },
      take: MAX_VIEWS,
    }),
    db.interactionEvent.aggregate({ where: { userId: accountId, kind: "view", at: { gte: prevStartUtc, lt: prevEndUtc } }, _sum: { durationMs: true } }),
    db.pageRevision.findMany({ where: { userId, createdAt: both }, select: { pageId: true, createdAt: true }, take: 2000 }),
    db.taskPage.findMany({ where: { userId, deletedAt: null, updatedAt: both }, select: { id: true, updatedAt: true }, take: 2000 }),
    dueFrom < dueUntil
      ? db.task.findMany({
          where: { userId, deletedAt: null, status: { in: [...OPEN_STATUSES] }, due: { gte: new Date(`${dueFrom}T00:00:00.000Z`), lt: new Date(`${dueUntil}T00:00:00.000Z`) } },
          orderBy: { due: "asc" },
          select: { id: true, title: true, due: true, priority: true },
          take: 12,
        })
      : Promise.resolve([]),
    dueFrom < dueUntil
      ? db.deliverable.findMany({
          where: { userId, deletedAt: null, status: "upcoming", due: { gte: new Date(`${dueFrom}T00:00:00.000Z`), lt: new Date(`${dueUntil}T00:00:00.000Z`) } },
          orderBy: { due: "asc" },
          select: { title: true, due: true, projectId: true },
          take: 6,
        })
      : Promise.resolve([]),
    db.approval.count({ where: { userId, decision: null } }),
    db.agentDecision.count({ where: { userId, status: "pending", ...(guest ? { source: "ensemble" } : {}) } }),
  ]);

  const inWeek = (at: Date | null | undefined) => Boolean(at && at >= startUtc && at < endUtc);
  const inPrevious = (at: Date | null | undefined) => Boolean(at && at >= prevStartUtc && at < prevEndUtc);
  const byAgent = new Set(agentDone.map((row) => row.taskId));
  const completedFacts: CompletedFact[] = completedRows.map((task) => ({
    id: task.id,
    title: task.title,
    priority: task.priority,
    projectId: task.projectId,
    at: task.completedAt!,
    byAgent: byAgent.has(task.id),
  }));
  const completedWeek = completedFacts.filter((task) => inWeek(task.at));
  const completedBefore = completedFacts.filter((task) => inPrevious(task.at));
  const sessionsWeek = sessions.filter((session) => inWeek(session.startedAt));
  // The recap is written from the notes, so the same decision can appear in both.
  const meetingDecisions = (rows: typeof sessions) =>
    rows.flatMap((session) => {
      const seen = new Set<string>();
      return decisionLines(`${session.notes}\n${session.recap}`)
        .filter((text) => {
          const key = text.toLowerCase().replace(/\s+/g, " ");
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .map((text) => ({ title: text, href: `/meetings?session=${session.id}` }));
    });
  const runsWeek = runs.filter((run) => inWeek(run.startedAt));
  const runsBefore = runs.filter((run) => inPrevious(run.startedAt));
  const pagesIn = (inRange: (at: Date) => boolean) =>
    new Set([...revisions.filter((row) => inRange(row.createdAt)).map((row) => row.pageId), ...pages.filter((row) => inRange(row.updatedAt)).map((row) => row.id)]).size;

  const done = [
    ...completedWeek.map((task) => ({ title: task.title, href: `/tasks/${task.id}`, detail: "Done" })),
    ...deliverables.map((row) => ({ title: row.title, href: `/projects/${row.projectId}`, detail: "Deliverable" })),
  ];
  const slipped = slippedLinks(overdue, cutoff, clock.date);
  const decided = [
    ...meetingDecisions(sessionsWeek),
    ...approvals.filter((row) => inWeek(row.decidedAt)).map((row) => ({ title: `${row.title} (${row.decision})`, href: "/needs-me" })),
    ...decisions.filter((row) => inWeek(row.decidedAt)).map((row) => ({ title: `${row.title} (${row.decision})`, href: "/needs-me" })),
  ];
  const decidedBefore =
    meetingDecisions(sessions.filter((session) => inPrevious(session.startedAt))).length +
    approvals.filter((row) => inPrevious(row.decidedAt)).length +
    decisions.filter((row) => inPrevious(row.decidedAt)).length;
  const meetings = sessionsWeek.map((session) => ({
    title: session.title,
    when: calendarLabel(session.startedAt.toISOString().slice(0, 10)),
    summary: clipSummary(session.recap || session.notes),
    href: `/meetings?session=${session.id}`,
  }));

  const shape = weekShape({
    start: bounds.start,
    today: clock.date,
    timeZone,
    completed: completedWeek,
    created: createdRows.filter((row) => inWeek(row.createdAt)).map((row) => row.createdAt),
    views: views.map((row) => ({ at: row.at, durationMs: row.durationMs ?? 0, surface: row.surface })),
  });
  const agents = agentSummary(runsWeek.map((run) => ({ at: run.startedAt, outcome: run.outcome, worker: run.worker, provider: run.workspaceJob?.provider ?? null })));
  const stats: RecapStats = {
    completed: completedWeek.length,
    completedByAgents: completedWeek.filter((task) => task.byAgent).length,
    created: shape.days.reduce((sum, day) => sum + day.created, 0),
    agentRuns: agents.runs,
    agentSucceeded: agents.succeeded,
    activeMinutes: shape.days.reduce((sum, day) => sum + day.activeMinutes, 0),
    meetings: sessionsWeek.length,
    decisions: decided.length,
    pagesEdited: pagesIn(inWeek),
  };
  const previous: RecapStats = {
    completed: completedBefore.length,
    completedByAgents: completedBefore.filter((task) => task.byAgent).length,
    created: createdRows.filter((row) => inPrevious(row.createdAt)).length,
    agentRuns: runsBefore.length,
    agentSucceeded: runsBefore.filter((run) => run.outcome === "success").length,
    activeMinutes: Math.round((previousViews._sum.durationMs ?? 0) / 60_000),
    meetings: sessions.filter((session) => inPrevious(session.startedAt)).length,
    decisions: decidedBefore,
    pagesEdited: pagesIn(inPrevious),
  };

  const projectCounts = new Map<string, { completed: number; created: number }>();
  const bump = (id: string | null, key: "completed" | "created") => {
    if (!id) return;
    const row = projectCounts.get(id) ?? { completed: 0, created: 0 };
    row[key] += 1;
    projectCounts.set(id, row);
  };
  for (const task of completedWeek) bump(task.projectId, "completed");
  for (const row of createdRows) if (inWeek(row.createdAt)) bump(row.projectId, "created");
  const projectIds = [...projectCounts.entries()]
    .sort((a, b) => b[1].completed - a[1].completed || b[1].created - a[1].created || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([id]) => id);
  const [projectRows, openRows] = projectIds.length
    ? await Promise.all([
        db.project.findMany({ where: { userId, deletedAt: null, id: { in: projectIds } }, select: { id: true, name: true } }),
        db.task.groupBy({ by: ["projectId"], where: { userId, deletedAt: null, status: { in: [...OPEN_STATUSES] }, projectId: { in: projectIds } }, _count: { _all: true } }),
      ])
    : [[], []];
  const names = new Map(projectRows.map((row) => [row.id, row.name]));
  const open = new Map(openRows.map((row) => [row.projectId, row._count._all]));
  const projects: RecapProject[] = projectIds.flatMap((id) => {
    const name = names.get(id);
    if (!name) return [];
    const counts = projectCounts.get(id)!;
    return [{ id, name, href: `/projects/${id}`, completed: counts.completed, created: counts.created, open: open.get(id) ?? 0 }];
  });

  const waiting = waitingApprovals + waitingDecisions;
  const dueSoon = [
    ...dueTasks.map((row) => ({ title: row.title, href: `/tasks/${row.id}`, due: row.due!.toISOString().slice(0, 10), ...(row.priority === "critical" || row.priority === "p0" ? { detail: "High priority" } : {}) })),
    ...dueDeliverables.map((row) => ({ title: row.title, href: `/projects/${row.projectId}`, due: row.due!.toISOString().slice(0, 10), detail: "Deliverable" })),
  ]
    .sort((a, b) => a.due.localeCompare(b.due))
    .slice(0, 12);
  const highlights = recapHighlights({
    days: shape.days,
    stats,
    completed: completedWeek,
    deliverables: deliverables.map((row) => ({ title: row.title, href: `/projects/${row.projectId}` })),
    projectsDone: projectsDone.map((row) => ({ name: row.name, href: `/projects/${row.id}` })),
    projects,
    firstRun: inWeek(firstRun?.startedAt),
    current,
    waiting,
    decided: decided.length,
  });
  const narrative = recapNarrative({ stats, previous, days: shape.days, current });
  const summary = { narrative, stats, previous, current, highlights, dueSoon };
  const input = { label: bounds.label, done, decided, slipped, meetings };
  return {
    ...input,
    start: bounds.start,
    end: bounds.end,
    markdown: renderWeeklyRecap({ ...input, summary }),
    today: clock.date,
    timeZone,
    current,
    /** "to_date": this week so far against last week up to the same moment. "full": whole weeks. */
    compare: current ? ("to_date" as const) : ("full" as const),
    narrative,
    stats,
    previous,
    days: shape.days,
    /** Seven rows (Monday first) of 24 hourly active minutes. */
    rhythm: shape.rhythm,
    surfaces: shape.surfaces,
    projects,
    highlights,
    ahead: {
      dueNextWeek: dueSoon,
      dueRange: { from: dueFrom, until: addCalendarDays(dueUntil, -1) },
      overdue: slipped.slice(0, 8),
      overdueTotal: slipped.length,
      waiting: { count: waiting, href: "/needs-me" },
    },
    agents,
  };
}

export type { NudgeReason };
