/**
 * node_routines (docs/35 §6.5): the node makes, lists and changes its owner's routines for it when
 * they ask ("every weekday at 9, tell me what is due"). Only where the owner reads alone and asked.
 */
import { z } from "zod";
import { defineTool, toolOk, ToolBlockedError, type AnyHubTool } from "../assistant/types.js";
import { createRoutine, NOTIFY, RoutineError, RoutineEvent, routineView, runNow, updateRoutine } from "./routines.js";
import type { NodeScope } from "./tools.js";

export function routineTools(scope: NodeScope): AnyHubTool[] {
  if (!scope.ownerOnly || scope.lineage.fromNonOwner || scope.plan) return [];
  const { prisma, node } = scope;
  const fail = (error: unknown): never => {
    if (error instanceof RoutineError) throw new ToolBlockedError(error.message);
    if (error instanceof z.ZodError) throw new ToolBlockedError(error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
    throw error;
  };
  return [
    defineTool({
      name: "node_routines",
      area: "tasks",
      description:
        "Your owner's routines for you: work you do by yourself on a schedule, when something changes in their Ensemble, or when a webhook calls. " +
        "list: yours, with when they run next. create: title, instruction (what to do each time and what to report), and when: cron (five fields, for example “0 9 * * 1-5” for weekdays at 09:00) with timezone (default your owner's), or event (on task or page changes). " +
        "notify: always (post the result), needed (post only when something failed or needs your owner) or never. pause, resume, delete, run_now: by the routine's id. " +
        "Make or change a routine only when your owner asks; webhook routines are made on the website, where the token is shown.",
      input: z
        .object({
          action: z.enum(["list", "create", "pause", "resume", "delete", "run_now"]),
          routine: z.string().uuid().optional().describe("The routine's id (from list), for pause, resume, delete and run_now."),
          title: z.string().min(1).max(120).optional(),
          instruction: z.string().min(1).max(4000).optional(),
          cron: z.string().max(120).optional(),
          timezone: z.string().max(80).optional(),
          event: RoutineEvent.optional(),
          notify: z.enum(NOTIFY).optional(),
        })
        .strict(),
      isWrite: false,
      risk: "low",
      async run(ctx, input) {
        if (input.action === "list") {
          const rows = await prisma.nodeRoutine.findMany({ where: { nodeId: node.id }, orderBy: { createdAt: "asc" } });
          const views = await Promise.all(rows.map((row) => routineView(prisma, row)));
          return toolOk(
            views.length ? `${views.length} routine(s).` : "No routines yet.",
            { routines: views.map((row) => ({ id: row.id, title: row.title, when: row.when, notify: row.notify, status: row.status, nextRunAt: row.nextRunAt, lastRunAt: row.lastRunAt })) },
          );
        }
        if (input.action === "create") {
          if (!input.title || !input.instruction) throw new ToolBlockedError("A routine needs a title and an instruction.");
          try {
            const { routine } = await createRoutine(ctx.app, node.userId, {
              title: input.title,
              nodeId: node.id,
              instruction: input.instruction,
              trigger: input.event ? "event" : "schedule",
              ...(input.cron ? { cron: input.cron } : {}),
              ...(input.timezone ? { timezone: input.timezone } : {}),
              ...(input.event ? { event: input.event } : {}),
              ...(input.notify ? { notify: input.notify } : {}),
            });
            const view = await routineView(prisma, routine);
            return toolOk(`Routine “${view.title}” made: ${view.when}${view.nextRunAt ? `, next at ${view.nextRunAt}` : ""}. Your owner can change or delete it in Routines.`, { routine: view.id });
          } catch (error) {
            return fail(error);
          }
        }
        if (!input.routine) throw new ToolBlockedError("Name the routine's id (node_routines list).");
        const routine = await prisma.nodeRoutine.findFirst({ where: { id: input.routine, nodeId: node.id } });
        if (!routine) throw new ToolBlockedError("That is not one of your routines.");
        try {
          if (input.action === "delete") {
            await prisma.nodeRoutine.delete({ where: { id: routine.id } });
            return toolOk(`Deleted “${routine.title}”.`);
          }
          if (input.action === "run_now") {
            await runNow(ctx.app, node.userId, routine.id);
            return toolOk(`“${routine.title}” runs now; it reports here as usual.`);
          }
          await updateRoutine(ctx.app, node.userId, routine.id, { status: input.action === "pause" ? "paused" : "active" });
          return toolOk(input.action === "pause" ? `Paused “${routine.title}”.` : `“${routine.title}” runs again.`);
        } catch (error) {
          return fail(error);
        }
      },
    }),
  ];
}
