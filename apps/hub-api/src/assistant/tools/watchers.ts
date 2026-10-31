import { z } from "zod";
import { createWatcher } from "../../ensemble/watchers.js";
import { recordUndoInTransaction } from "../../lib/undo.js";
import { defineTool, inTransaction, toolOk, ToolBlockedError } from "../types.js";

export const watcherTools = [
  defineTool({
    name: "hub_create_watcher",
    area: "reminders",
    description:
      "Propose a watcher. all_tasks_done fires when every task under a deliverable is done or dropped. days_before_due fires once when that deliverable or task is due within daysBefore days. Nothing is stored until the user applies.",
    input: z.object({
      scopeKind: z.enum(["deliverable", "task"]),
      scopeId: z.string().uuid(),
      condition: z.enum(["all_tasks_done", "days_before_due"]),
      daysBefore: z.number().int().min(0).max(60).optional(),
      message: z.string().min(1).max(300),
      surface: z.string().max(40).optional(),
      prompt: z.string().max(500).optional(),
    }),
    isWrite: true,
    risk: "low",
    undoable: true,
    preview(_ctx, input) {
      return input.condition === "all_tasks_done"
        ? `Watch: ${input.message}`
        : `Watch: ${input.message} (${input.daysBefore ?? 0} days before due)`;
    },
    async run(ctx, input) {
      const watcher = await inTransaction(ctx, (tx) =>
        createWatcher(tx, ctx.userId, {
          scopeKind: input.scopeKind,
          scopeId: input.scopeId,
          condition: input.condition,
          daysBefore: input.condition === "days_before_due" ? (input.daysBefore ?? 0) : null,
          message: input.message,
          surface: input.surface,
          prompt: input.prompt,
          actor: "agent",
        }),
      );
      return toolOk(`Watching: ${watcher.message}. Nothing fires until the condition is true.`, { id: watcher.id }, { href: "/settings", invalidate: ["watchers"] });
    },
  }),
  defineTool({
    name: "hub_list_watchers",
    area: "reminders",
    description: "List the person's watchers (from hub_create_watcher): what each watches, its condition and message, and whether it is active, fired or cancelled. Active ones unless all.",
    input: z.object({ all: z.boolean().optional().describe("Also fired and cancelled ones.") }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      const rows = await ctx.prisma.watcher.findMany({
        where: { userId: ctx.userId, ...(input.all ? {} : { status: "active" }) },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: { id: true, scopeKind: true, scopeId: true, condition: true, daysBefore: true, message: true, status: true, firedAt: true },
      });
      const watchers = rows.map((row) => ({
        id: row.id,
        message: row.message,
        watches: { kind: row.scopeKind, id: row.scopeId },
        condition: row.condition === "days_before_due" ? `${row.daysBefore ?? 0} days before due` : "all tasks done",
        status: row.status,
        ...(row.firedAt ? { firedAt: row.firedAt.toISOString().slice(0, 10) } : {}),
      }));
      return toolOk(`Listed ${watchers.length} ${input.all ? "" : "active "}watcher${watchers.length === 1 ? "" : "s"}.`, { watchers });
    },
  }),
  defineTool({
    name: "hub_cancel_watcher",
    area: "reminders",
    description: "Stop an active watcher (watcherId from hub_list_watchers): it will not fire. Undo brings it back.",
    input: z.object({ watcherId: z.string().uuid() }),
    isWrite: true,
    risk: "low",
    undoable: true,
    async preview(ctx, input) {
      const row = await ctx.prisma.watcher.findFirst({ where: { id: input.watcherId, userId: ctx.userId }, select: { message: true } });
      if (!row) throw new ToolBlockedError("That watcher is not in this space.", "Call hub_list_watchers and use an id it returns.");
      return `Stop watching: ${row.message}`;
    },
    async run(ctx, input) {
      const message = await inTransaction(ctx, async (tx) => {
        const before = await tx.watcher.findFirst({ where: { id: input.watcherId, userId: ctx.userId } });
        if (!before) throw new ToolBlockedError("That watcher is not in this space.", "Call hub_list_watchers and use an id it returns.");
        if (before.status !== "active") throw new ToolBlockedError(`That watcher is ${before.status} already.`);
        const after = await tx.watcher.update({ where: { id: before.id }, data: { status: "cancelled", cancelledAt: new Date() } });
        const op = { op: "update" as const, model: "watcher" as const, id: before.id, before: { ...before } as Record<string, unknown>, after: { ...after } as Record<string, unknown> };
        await recordUndoInTransaction(tx, { userId: ctx.userId, actor: "agent", label: `Stopped watching: ${before.message}`, kind: "update", subject: "watcher", inverse: op, forward: op });
        return before.message;
      });
      return toolOk(`Stopped watching: ${message}.`, { id: input.watcherId, status: "cancelled" }, { href: "/settings", invalidate: ["watchers"] });
    },
  }),
];
