/**
 * Routines for the assistant (routines/service.ts): list them, add one when the person asks for
 * recurring work ("every weekday at 9, sum up my unread mail"), and pause, resume, change or delete one.
 */
import { z } from "zod";
import { createRoutine, deleteRoutine, dropRoutineChat, findRoutine, listRoutines, routineWhen, updateRoutine, WEEKDAYS, cronFor, type Cadence } from "../../routines/service.js";
import { defineTool, inTransaction, toolOk, ToolBlockedError, type ToolContext } from "../types.js";

const Schedule = {
  every: z.enum(["hour", "day", "weekday", "week", "month"]).optional().describe("How often. weekday = Monday to Friday. Default day."),
  time: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "HH:MM, 24-hour").optional().describe("HH:MM in the person's time zone (for hour, only the minutes count). Default 09:00."),
  days: z.array(z.enum(WEEKDAYS)).max(7).optional().describe("For every=week: the days, e.g. [\"mon\",\"thu\"]."),
  dayOfMonth: z.number().int().min(1).max(28).optional().describe("For every=month: the day, 1-28."),
  cron: z.string().max(120).optional().describe("Only for a schedule the fields above cannot say: five-field cron in the person's time zone."),
};

const cadenceOf = (input: Cadence): Cadence => ({ every: input.every, time: input.time, days: input.days, dayOfMonth: input.dayOfMonth, cron: input.cron });
const hasCadence = (input: Cadence) => Boolean(input.every || input.time || input.days?.length || input.dayOfMonth || input.cron);

function whenOf(input: Cadence, timezone: string): string {
  try {
    return routineWhen(cronFor(cadenceOf(input)), timezone).toLowerCase();
  } catch (error) {
    return error instanceof Error ? error.message : "an unreadable schedule";
  }
}

function routinesOn(ctx: ToolContext): void {
  if (!ctx.settings.routines.enabled) throw new ToolBlockedError("Routines are off for this account.", "Turn them on in Settings › Notifications › Routines.");
}

export const routineTools = [
  defineTool({
    name: "hub_list_routines",
    area: "reminders",
    description: "List the person's routines: work the assistant does on a schedule. Each has an id, its schedule in words, whether it is paused, when it runs next and the result of its last run.",
    input: z.object({}),
    isWrite: false,
    risk: "low",
    async run(ctx) {
      const routines = await listRoutines(ctx.prisma, ctx.userId);
      const lines = routines.map((row) => `- ${row.title} (${row.id}): ${row.when.toLowerCase()}${row.status === "paused" ? ", paused" : ""}${row.lastStatus ? `; last run ${row.lastStatus}${row.lastSummary ? `: ${row.lastSummary.slice(0, 120)}` : ""}` : ""}`);
      return toolOk(routines.length ? `${routines.length} routines:\n${lines.join("\n")}` : "No routines yet.", { routines, enabled: ctx.settings.routines.enabled }, { href: "/routines" });
    },
  }),
  defineTool({
    name: "hub_create_routine",
    area: "reminders",
    description:
      "Add a routine: work the assistant does by itself on a schedule (a daily inbox digest, a Monday plan for the week, tidying the board on Fridays). Only when the person asks for something recurring. instruction is what to do each time, in plain words, complete on its own. A calendar meeting that repeats is a calendar event, not a routine.",
    input: z.object({
      title: z.string().min(1).max(120).describe("A short name: \"Morning inbox digest\"."),
      instruction: z.string().min(1).max(4000).describe("What to do each run, e.g. \"Read my unread Gmail from the last day and list what needs a reply, most urgent first.\""),
      ...Schedule,
    }),
    isWrite: true,
    risk: "low",
    undoable: false,
    preview(ctx, input) {
      return `Add the routine “${input.title}”, ${whenOf(input, ctx.settings.timezone)}: ${input.instruction.slice(0, 200)}`;
    },
    async run(ctx, input) {
      routinesOn(ctx);
      const routine = await inTransaction(ctx, (tx) => createRoutine(tx, ctx.userId, { title: input.title, instruction: input.instruction, cadence: cadenceOf(input) }));
      return toolOk(`Added the routine “${routine.title}”: ${routine.when.toLowerCase()}.`, { routine }, { href: `/routines?routine=${routine.id}` });
    },
  }),
  defineTool({
    name: "hub_update_routine",
    area: "reminders",
    description: "Change one routine (ids from hub_list_routines): action pause or resume it, delete it, or edit its title, instruction or schedule (send only what changes).",
    input: z.object({
      routineId: z.string().uuid(),
      action: z.enum(["edit", "pause", "resume", "delete"]).default("edit"),
      title: z.string().min(1).max(120).optional(),
      instruction: z.string().min(1).max(4000).optional(),
      ...Schedule,
    }),
    isWrite: true,
    risk: "low",
    undoable: false,
    async preview(ctx, input) {
      const row = await findRoutine(ctx.prisma, ctx.userId, input.routineId).catch(() => null);
      const name = row ? `“${row.title}”` : "the routine";
      if (input.action === "delete") return `Delete ${name}.`;
      if (input.action === "pause") return `Pause ${name}.`;
      if (input.action === "resume") return `Resume ${name}.`;
      const parts = [input.title ? `rename it “${input.title}”` : null, hasCadence(input) ? `run it ${whenOf(input, ctx.settings.timezone)}` : null, input.instruction ? `new instruction: ${input.instruction.slice(0, 160)}` : null].filter(Boolean);
      return `Change ${name}: ${parts.join("; ") || "nothing"}.`;
    },
    async run(ctx, input) {
      if (input.action === "delete") {
        const gone = await inTransaction(ctx, (tx) => deleteRoutine(tx, ctx.userId, input.routineId));
        void dropRoutineChat(ctx.app, ctx.userId, gone, { conversationId: ctx.conversationId });
        return toolOk(`Deleted the routine “${gone.title}”.`, { routine: gone }, { href: "/routines" });
      }
      if (input.action !== "pause") routinesOn(ctx);
      const status = input.action === "pause" ? "paused" : input.action === "resume" ? "active" : undefined;
      const routine = await inTransaction(ctx, (tx) =>
        updateRoutine(tx, ctx.userId, input.routineId, {
          title: input.title,
          instruction: input.instruction,
          cadence: hasCadence(input) ? cadenceOf(input) : undefined,
          status,
        }),
      );
      const what = status === "paused" ? "Paused" : status === "active" ? "Resumed" : "Changed";
      return toolOk(`${what} the routine “${routine.title}” (${routine.when.toLowerCase()}).`, { routine }, { href: `/routines?routine=${routine.id}` });
    },
  }),
];
