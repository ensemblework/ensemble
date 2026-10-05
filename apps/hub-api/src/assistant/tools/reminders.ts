import { z } from "zod";
import { createReminder, softDelete, updateReminder } from "../../services/records.js";
import { defineTool, inTransaction, toolOk } from "../types.js";

const DateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD. Resolve relative dates from today's date in the prompt.");
const TimeField = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM in 24-hour time");

export const reminderTools = [
  defineTool({
    name: "hub_list_reminders",
    area: "reminders",
    description: "List private Today reminders.",
    input: z.object({}),
    isWrite: false,
    risk: "low",
    async run(ctx) {
      const reminders = await ctx.prisma.reminder.findMany({
        where: { userId: ctx.userId, deletedAt: null, dismissedAt: null },
        orderBy: { dueDate: "asc" },
      });
      return toolOk(`Listed ${reminders.length} reminder(s).`, {
        reminders: reminders.map((row) => ({
          id: row.id,
          title: row.title,
          dueDate: row.dueDate,
          dueTime: row.dueTime,
          timeZone: row.timeZone,
        })),
      });
    },
  }),
  defineTool({
    name: "hub_create_reminder",
    area: "reminders",
    description: "Create a private reminder. dueDate is YYYY-MM-DD and dueTime is HH:MM. Never send words like tomorrow or 5pm.",
    input: z.object({
      title: z.string().min(1),
      dueDate: DateField,
      dueTime: TimeField.optional(),
    }),
    isWrite: true,
    risk: "low",
    undoable: true,
    preview(_ctx, input) {
      return `Remind: ${input.title} on ${input.dueDate}${input.dueTime ? ` at ${input.dueTime}` : ""}`;
    },
    async run(ctx, input) {
      const reminder = await inTransaction(ctx, (tx) =>
        createReminder(tx, ctx.userId, { ...input, timeZone: ctx.settings.timezone }, "agent"),
      );
      const desktop = ctx.settings.desktopReminders
        ? ""
        : " Desktop notifications are off; the reminder still appears in Ensemble. Turn them on in Settings → Reminders to also alert this computer.";
      return toolOk(`Reminder ready: ${reminder.title}.${desktop}`, {
        reminder: { id: reminder.id, title: reminder.title, dueDate: reminder.dueDate, dueTime: reminder.dueTime },
      }, { invalidate: ["reminders"] });
    },
  }),
  defineTool({
    name: "hub_update_reminder",
    area: "reminders",
    description: "Change a reminder's title or when it fires.",
    input: z.object({
      reminderId: z.string().uuid(),
      title: z.string().min(1).optional(),
      dueDate: DateField.optional(),
      dueTime: TimeField.nullable().optional(),
    }),
    isWrite: true,
    risk: "low",
    undoable: true,
    async preview(ctx, input) {
      const row = await ctx.prisma.reminder.findFirst({ where: { id: input.reminderId, userId: ctx.userId }, select: { title: true } });
      return `Update reminder “${row?.title ?? input.reminderId}”`;
    },
    async run(ctx, input) {
      const reminder = await inTransaction(ctx, (tx) =>
        updateReminder(tx, ctx.userId, input.reminderId, { title: input.title, dueDate: input.dueDate, dueTime: input.dueTime }, "agent"),
      );
      return toolOk(`Updated reminder “${reminder.title}”.`, { id: reminder.id }, { invalidate: ["reminders"] });
    },
  }),
  defineTool({
    name: "hub_delete_reminder",
    area: "reminders",
    description: "Move a reminder to Trash.",
    input: z.object({ reminderId: z.string().uuid() }),
    isWrite: true,
    risk: "low",
    undoable: true,
    async run(ctx, input) {
      await inTransaction(ctx, (tx) => softDelete(tx, ctx.userId, "reminder", input.reminderId, "agent"));
      return toolOk("Moved the reminder to Trash.", { ok: true }, { invalidate: ["reminders"] });
    },
  }),
  defineTool({
    name: "hub_dismiss_reminder",
    area: "reminders",
    description: "Dismiss a private reminder without deleting it.",
    input: z.object({ reminderId: z.string().uuid() }),
    isWrite: true,
    risk: "low",
    async run(ctx, input) {
      const result = await ctx.prisma.reminder.updateMany({
        where: { id: input.reminderId, userId: ctx.userId, deletedAt: null, dismissedAt: null },
        data: { dismissedAt: new Date(), nextNotificationAt: null },
      });
      if (result.count === 0) {
        throw Object.assign(new Error("That reminder was not found."), { statusCode: 404 });
      }
      return toolOk("Reminder dismissed.", { ok: true }, { invalidate: ["reminders"] });
    },
  }),
];
