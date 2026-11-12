/**
 * Routines (docs/02 §3.10): work the Ensemble assistant does on a schedule. Each routine is the
 * person's own instruction, run as a turn of the assistant at every time its cron names (in the
 * person's time zone), with the person's own settings: the same tools, models and write policy as the
 * dock, so a change that waits for Apply waits in the routine's conversation. Every run adds to one
 * conversation per routine and leaves a notification in the bell.
 *
 * Settings › Notifications › Routines (`routines.enabled`) turns them all off; none run while it is off.
 */
import type { AssistantRoutine, Prisma, PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { INCLUDED_PROVIDER } from "@ensemble/shared-types";
import { loadSettings } from "../lib/settings.js";
import { sseHub } from "../lib/sse.js";
import { CronError, describeCron, nextRun, parseCron, validTimeZone } from "../node/cron.js";

type Db = PrismaClient | Prisma.TransactionClient;

/** How many routines one person may keep. */
export const ROUTINE_LIMIT = 50;
/** A run still marked running after this long was cut short (a restart): the routine may run again. */
const STUCK_MS = 30 * 60_000;
export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** A schedule in words, as the Routines page and the assistant give it. `cron` wins when set. */
export type Cadence = {
  every?: "hour" | "day" | "weekday" | "week" | "month";
  /** HH:MM, 24-hour. */
  time?: string;
  /** For `week`: which days. */
  days?: Weekday[];
  /** For `month`: which day (1–28). */
  dayOfMonth?: number;
  /** Five-field cron, for anything else. */
  cron?: string;
};

export class RoutineError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

/** The cron for a schedule in words. Throws RoutineError for one that cannot run. */
export function cronFor(cadence: Cadence): string {
  if (cadence.cron?.trim()) {
    try {
      parseCron(cadence.cron);
    } catch (error) {
      throw new RoutineError(error instanceof CronError ? error.message : "That schedule could not be read.");
    }
    return cadence.cron.trim().replace(/\s+/g, " ");
  }
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(cadence.time ?? "09:00");
  if (!match) throw new RoutineError("Give the time as HH:MM, 24-hour.");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  switch (cadence.every ?? "day") {
    case "hour":
      return `${minute} * * * *`;
    case "day":
      return `${minute} ${hour} * * *`;
    case "weekday":
      return `${minute} ${hour} * * 1-5`;
    case "week": {
      const days = [...new Set(cadence.days?.length ? cadence.days : (["mon"] as Weekday[]))].map((day) => WEEKDAYS.indexOf(day)).filter((day) => day >= 0).sort();
      if (!days.length) throw new RoutineError("Pick at least one day of the week.");
      return `${minute} ${hour} * * ${days.join(",")}`;
    }
    case "month": {
      const day = cadence.dayOfMonth ?? 1;
      if (!Number.isInteger(day) || day < 1 || day > 28) throw new RoutineError("Pick a day of the month from 1 to 28.");
      return `${minute} ${hour} ${day} * *`;
    }
  }
}

/** When a routine runs next after `after`, or null when its schedule never comes. */
export function nextRoutineRun(cron: string, timezone: string, after = new Date()): Date | null {
  return nextRun(parseCron(cron), timezone, after);
}

/** The schedule in words, without the zone. */
export function routineWhen(cron: string, timezone: string): string {
  try {
    return describeCron(cron, timezone).replace(` (${timezone})`, "");
  } catch {
    return cron;
  }
}

export type RoutineView = {
  id: string;
  title: string;
  instruction: string;
  cron: string;
  timezone: string;
  when: string;
  status: "active" | "paused";
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: "running" | "ok" | "failed" | null;
  lastSummary: string | null;
  conversationId: string | null;
  runCount: number;
  createdAt: string;
};

export function routineView(row: AssistantRoutine): RoutineView {
  return {
    id: row.id,
    title: row.title,
    instruction: row.instruction,
    cron: row.cron,
    timezone: row.timezone,
    when: routineWhen(row.cron, row.timezone),
    status: row.status === "paused" ? "paused" : "active",
    nextRunAt: row.status === "paused" ? null : row.nextRunAt?.toISOString() ?? null,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastStatus: row.lastStatus === "running" || row.lastStatus === "ok" || row.lastStatus === "failed" ? row.lastStatus : null,
    lastSummary: row.lastSummary,
    conversationId: row.conversationId,
    runCount: row.runCount,
    createdAt: row.createdAt.toISOString(),
  };
}

async function zoneOf(db: Db, userId: string): Promise<string> {
  const settings = await loadSettings(db, userId);
  return validTimeZone(settings.timezone) ? settings.timezone : "UTC";
}

export async function listRoutines(db: Db, userId: string): Promise<RoutineView[]> {
  const rows = await db.assistantRoutine.findMany({ where: { userId }, orderBy: [{ status: "asc" }, { createdAt: "asc" }] });
  return rows.map(routineView);
}

export async function findRoutine(db: Db, userId: string, id: string): Promise<AssistantRoutine> {
  const row = await db.assistantRoutine.findFirst({ where: { id, userId } });
  if (!row) throw new RoutineError("No routine with that id.", 404);
  return row;
}

const clean = (text: string, max: number) => text.replace(/\r\n?/g, "\n").trim().slice(0, max);

export async function createRoutine(db: Db, userId: string, input: { title: string; instruction: string; cadence: Cadence; paused?: boolean }): Promise<RoutineView> {
  const title = clean(input.title, 120);
  const instruction = clean(input.instruction, 4000);
  if (!title) throw new RoutineError("Give the routine a name.");
  if (!instruction) throw new RoutineError("Say what the assistant should do each time.");
  if ((await db.assistantRoutine.count({ where: { userId } })) >= ROUTINE_LIMIT) throw new RoutineError(`You can keep up to ${ROUTINE_LIMIT} routines. Delete one first.`, 409);
  const cron = cronFor(input.cadence);
  const timezone = await zoneOf(db, userId);
  const nextRunAt = nextRoutineRun(cron, timezone);
  if (!nextRunAt) throw new RoutineError("That schedule never comes round.");
  const row = await db.assistantRoutine.create({ data: { userId, title, instruction, cron, timezone, status: input.paused ? "paused" : "active", nextRunAt } });
  return routineView(row);
}

export async function updateRoutine(
  db: Db,
  userId: string,
  id: string,
  patch: { title?: string; instruction?: string; cadence?: Cadence; status?: "active" | "paused" },
): Promise<RoutineView> {
  const row = await findRoutine(db, userId, id);
  const data: Prisma.AssistantRoutineUpdateInput = {};
  if (patch.title !== undefined) {
    const title = clean(patch.title, 120);
    if (!title) throw new RoutineError("Give the routine a name.");
    data.title = title;
  }
  if (patch.instruction !== undefined) {
    const instruction = clean(patch.instruction, 4000);
    if (!instruction) throw new RoutineError("Say what the assistant should do each time.");
    data.instruction = instruction;
  }
  const cron = patch.cadence ? cronFor(patch.cadence) : row.cron;
  if (patch.cadence) data.cron = cron;
  if (patch.status) data.status = patch.status;
  // A new schedule, or a routine that starts again, counts from now in the person's time zone today.
  if (patch.cadence || (patch.status === "active" && row.status !== "active")) {
    const timezone = await zoneOf(db, userId);
    const next = nextRoutineRun(cron, timezone);
    if (!next) throw new RoutineError("That schedule never comes round.");
    data.nextRunAt = next;
    data.timezone = timezone;
  }
  return routineView(await db.assistantRoutine.update({ where: { id: row.id }, data }));
}

export async function deleteRoutine(db: Db, userId: string, id: string): Promise<RoutineView> {
  const row = await findRoutine(db, userId, id);
  await db.assistantRoutine.delete({ where: { id: row.id } });
  return routineView(row);
}

/**
 * A deleted routine's conversation goes with it, as a deleted chat does (assistant/delete-chat.ts): its
 * messages here, a run still going, and the agent session behind it on the person's computer.
 */
export async function dropRoutineChat(app: FastifyInstance, userId: string, routine: Pick<RoutineView, "conversationId">, from?: { conversationId?: string }): Promise<void> {
  if (!routine.conversationId) return;
  // Loaded here: the assistant's tools include the routine tools, which load this file.
  const { deleteAssistantChat } = await import("../assistant/delete-chat.js");
  // Deleted by a turn in its own conversation: that turn finishes instead of being stopped.
  const keepTurn = from?.conversationId === routine.conversationId;
  await deleteAssistantChat(app, userId, routine.conversationId, { keepTurn }).catch((error: unknown) => app.log.warn({ err: error }, "Could not delete a routine's conversation"));
}

const DAY_MS = 24 * 3600_000;
/** The most a paired computer keeps an unused chat session (remote/assistant.ts `keepDays`). */
const SESSION_KEEP_MAX = 90;

/**
 * How long the routine's agent session is kept unused on the person's computer: past the gap to its
 * next run twice over, so one skipped run still finds it, and at least the usual 30 days.
 */
export function routineKeepDays(cron: string, timezone: string, now = new Date()): number {
  try {
    const first = nextRoutineRun(cron, timezone, now);
    const second = first ? nextRoutineRun(cron, timezone, first) : null;
    if (!first || !second) return SESSION_KEEP_MAX;
    return Math.min(SESSION_KEEP_MAX, Math.max(30, Math.ceil((2 * (second.getTime() - first.getTime())) / DAY_MS) + 1));
  } catch {
    return SESSION_KEEP_MAX;
  }
}

const ROUTINE_PREAMBLE = [
  "This turn is one of the person's routines, run on its schedule while they are away.",
  "Do what the routine says with Ensemble's tools and their connected apps, then reply with a short result they can read in a minute: what you found or did, and anything that needs them.",
  "Do not ask questions back: decide sensibly and say what you assumed. Do not create, change or delete routines.",
].join(" ");

/** The first lines of a reply, for the routine's card and its notification. */
function summaryOf(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/[#>*_`[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > 280 ? `${plain.slice(0, 277).trimEnd()}…` : plain;
}

/**
 * Runs one routine now: claims it (no second run of it starts meanwhile), runs the assistant in the
 * routine's conversation, saves the reply there, notes the result on the routine and in the bell.
 * `scheduled` moves the routine to its next time; a run asked for by hand leaves that alone.
 */
export async function runRoutine(app: FastifyInstance, routine: AssistantRoutine, how: "scheduled" | "manual"): Promise<RoutineView | null> {
  const prisma = app.prisma;
  const now = new Date();
  const free: Prisma.AssistantRoutineWhereInput = { OR: [{ lastStatus: null }, { lastStatus: { not: "running" } }, { lastRunAt: { lt: new Date(now.getTime() - STUCK_MS) } }] };
  const scheduled = how === "scheduled";
  const claimed = await prisma.assistantRoutine.updateMany({
    where: { id: routine.id, ...(scheduled ? { status: "active", nextRunAt: routine.nextRunAt } : {}), ...free },
    data: { lastStatus: "running", lastRunAt: now, ...(scheduled ? { nextRunAt: nextRoutineRun(routine.cron, routine.timezone, now) } : {}) },
  });
  if (claimed.count !== 1) return null;
  const userId = routine.userId;
  sseHub.publish(userId, { event: "routine", data: { id: routine.id, status: "running" } });
  let status: "ok" | "failed" = "ok";
  let summary = "";
  let held = 0;
  let conversationId = routine.conversationId;
  try {
    const settings = await loadSettings(prisma, userId);
    if (!settings.routines.enabled) throw new RoutineError("Routines are off in Settings › Notifications.");
    const existing = conversationId ? await prisma.assistantConversation.findFirst({ where: { id: conversationId, userId }, select: { id: true } }) : null;
    if (!existing) {
      const made = await prisma.assistantConversation.create({ data: { userId, accountId: null, title: `Routine: ${routine.title}`.slice(0, 80) } });
      conversationId = made.id;
    }
    const chat = conversationId!;
    const message = `${routine.title} (${routineWhen(routine.cron, routine.timezone).toLowerCase()}): ${routine.instruction}`;
    const asked = await prisma.assistantMessage.create({ data: { conversationId: chat, userId, role: "user", content: message } });
    const tierName = settings.assistant.defaultTier;
    const tier = settings.models[tierName];
    if (!tier.model) throw new RoutineError(`No model is set for the ${tierName} tier. Pick one in Settings › Models.`);
    if (tier.provider === INCLUDED_PROVIDER) await (await import("../included/budget.js")).assertIncludedOpen(userId, tier.model);
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { moduleSet: true } });
    // Loaded here: the assistant's tools include the routine tools, which load this file.
    const { runAssistantTurn } = await import("../assistant/agent.js");
    const result = await runAssistantTurn({
      app,
      userId,
      modules: user?.moduleSet ?? null,
      conversationId: chat,
      message,
      messageId: asked.id,
      page: { path: "/routines", label: "Routines" },
      settings,
      model: tier.model,
      provider: tier.provider,
      reasoningEffort: tier.effort !== "default" ? tier.effort : tier.provider === INCLUDED_PROVIDER ? undefined : settings.assistant.reasoningEffort,
      preamble: ROUTINE_PREAMBLE,
      // On the person's AI plan the routine keeps its one agent session from run to run (turn-sessions.ts).
      subscription: { keepDays: routineKeepDays(routine.cron, routine.timezone) },
      emit: () => undefined,
    });
    held = result.toolCalls.filter((call) => call.state === "awaiting_approval").length;
    await prisma.assistantMessage.create({
      data: {
        conversationId: chat,
        userId,
        role: result.failed ? "error" : "assistant",
        content: (result.content || "The assistant did not produce a reply.").slice(0, 100_000),
        toolCalls: result.toolCalls as never,
        ...(result.refs?.length && !result.failed ? { mentions: result.refs as never } : {}),
        model: result.failed ? null : result.model,
        credentialSource: result.credentialSource,
        credits: result.credits ?? undefined,
      },
    });
    await prisma.assistantConversation.update({ where: { id: chat }, data: { updatedAt: new Date() } });
    status = result.failed ? "failed" : "ok";
    summary = summaryOf(result.content || "") || (status === "ok" ? "Done." : "It did not finish.");
  } catch (error) {
    status = "failed";
    summary = summaryOf(error instanceof Error ? error.message : String(error)) || "It did not finish.";
    app.log.warn({ err: error, routineId: routine.id }, "routine run failed");
  }
  // Deleted while it ran: its conversation went with it, and nothing is reported.
  const saved = await prisma.assistantRoutine.updateMany({
    where: { id: routine.id },
    data: { lastStatus: status, lastSummary: summary, conversationId, runCount: { increment: 1 } },
  });
  if (!saved.count) return null;
  const view = routineView(await prisma.assistantRoutine.findUniqueOrThrow({ where: { id: routine.id } }));
  const title = status === "failed" ? `Routine didn't finish: ${routine.title}` : held ? `Routine needs you: ${routine.title}` : `Routine done: ${routine.title}`;
  const body = held ? `${held} ${held === 1 ? "change waits" : "changes wait"} for Apply in its conversation. ${summary}` : summary;
  await prisma.notification
    .create({ data: { userId, kind: "routine", title: title.slice(0, 200), body: body.slice(0, 300), url: `/routines?routine=${routine.id}`, subject: `routine:${routine.id}`, urgent: held > 0 } })
    .catch((error: unknown) => app.log.warn({ err: error }, "routine notification failed"));
  sseHub.publish(userId, { event: "routine", data: { id: routine.id, status } });
  sseHub.publish(userId, { event: "notification", data: { kind: "routine" } });
  return view;
}

/** The scheduler's minute: this person's routines that are due run, one after another. */
export async function runDueRoutines(app: FastifyInstance, userId: string, routinesOn: boolean): Promise<void> {
  if (!routinesOn) return;
  const due = await app.prisma.assistantRoutine.findMany({ where: { userId, status: "active", nextRunAt: { lte: new Date() } }, orderBy: { nextRunAt: "asc" }, take: 5 });
  for (const routine of due) await runRoutine(app, routine, "scheduled");
}
