import { z } from "zod";
import { createWatcher } from "../../ensemble/watchers.js";
import { defineTool, inTransaction, toolOk } from "../types.js";

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
];
