/**
 * The person's Ensemble board for their own agent in Chat (Claude Code, Codex or Cursor in the
 * `ensemble` app's Chat tab): list and create tasks, and search their notes, pages and tasks. The
 * agent calls these through the run's ensemble MCP server (scripts/ensemble-ask-mcp.mjs), which posts
 * to /api/engine/tool with the run's own secret. Chat turns only: a task run gets its brief instead.
 */
import type { PrismaClient, TaskStatus } from "@prisma/client";
import { z } from "zod";
import { searchWorkspace } from "../../cowork/service.js";
import { createTask } from "../../services/tasks.js";
import { appendToTaskPage } from "../../assistant/tools/pages.js";
import type { JobContext } from "../tools.js";

export const CHAT_TOOLS = ["ensemble_list_tasks", "ensemble_create_task", "ensemble_search"] as const;
export type ChatTool = (typeof CHAT_TOOLS)[number];

const OPEN: TaskStatus[] = ["proposed", "todo", "in_progress", "waiting_approval", "blocked"];

const ListInput = z.object({ query: z.string().max(200).optional(), include_done: z.boolean().optional() });
// `description` is what older chat servers sent; either way the text goes on the task's page.
const CreateInput = z.object({ title: z.string().trim().min(1).max(200), page: z.string().max(20_000).optional(), description: z.string().max(4000).optional(), due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
const SearchInput = z.object({ query: z.string().trim().min(1).max(200) });

/** Runs one board tool for the person whose chat this is; the text goes back to the agent. */
export async function runChatTool(ctx: Pick<JobContext, "userId" | "taskId" | "event"> & { prisma: PrismaClient }, name: string, input: unknown): Promise<string> {
  if (name === "ensemble_list_tasks") {
    const args = ListInput.parse(input ?? {});
    const tasks = await ctx.prisma.task.findMany({
      where: {
        userId: ctx.userId,
        deletedAt: null,
        ...(args.include_done ? {} : { status: { in: OPEN } }),
        ...(args.query ? { OR: [{ title: { contains: args.query, mode: "insensitive" } }, { description: { contains: args.query, mode: "insensitive" } }] } : {}),
      },
      orderBy: [{ updatedAt: "desc" }],
      take: 40,
      select: { id: true, title: true, status: true, owner: true, due: true },
    });
    if (!tasks.length) return args.query ? `No tasks match “${args.query}”.` : "The board has no open tasks.";
    return tasks
      .map((task) => `- ${task.title} [${task.status.replace("_", " ")}${task.owner === "agent" ? ", agent" : ""}${task.due ? `, due ${task.due.toISOString().slice(0, 10)}` : ""}] (id ${task.id})`)
      .join("\n");
  }
  if (name === "ensemble_create_task") {
    const args = CreateInput.parse(input ?? {});
    const page = [args.page, args.description].filter((part) => part?.trim()).join("\n\n");
    const task = await ctx.prisma.$transaction(async (tx) => {
      const row = await createTask(tx, ctx.userId, { title: args.title, owner: "me", status: "todo", ...(args.due ? { due: args.due } : {}) }, "agent");
      if (page) await appendToTaskPage(tx, ctx.userId, row.id, page);
      return row;
    });
    await ctx.event("tool", { name, ok: true, summary: `Created the task “${task.title}”` });
    return `Created the task “${task.title}” on the board (id ${task.id}).`;
  }
  if (name === "ensemble_search") {
    const args = SearchInput.parse(input ?? {});
    const found = await searchWorkspace(ctx.prisma, ctx.userId, args.query);
    if (!found.results.length) return `Nothing in Ensemble matches “${args.query}”.`;
    return found.results.map((hit) => `- ${hit.kind}: ${hit.label}${hit.excerpt ? ` — ${hit.excerpt}` : ""}`).join("\n");
  }
  throw new Error(`Unknown tool ${name}.`);
}
