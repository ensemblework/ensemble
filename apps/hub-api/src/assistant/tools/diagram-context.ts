import { z } from "zod";
import { hasModule } from "@ensemble/shared-types";
import { defineTool, toolOk } from "../types.js";

const CAP = 1_200;

function clip(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, CAP);
}

function plain(value: unknown): string {
  const parts: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const record = node as { text?: unknown; content?: unknown };
    if (typeof record.text === "string") parts.push(record.text);
    if (Array.isArray(record.content)) record.content.forEach(walk);
  };
  walk(value);
  return clip(parts.join(" "));
}

export const diagramContextTools = [
  defineTool({
    name: "hub_diagram_context",
    area: "context",
    description:
      "Read the bounded context for a diagram: a task, its page text, its project, deliverables, meeting notes, and linked repos. Call this before drawing a diagram of a task, project, deliverable, or page. Then follow the hint it returns. Do not invent blocks that this payload does not name.",
    input: z
      .object({
        taskId: z.string().uuid().optional(),
        projectId: z.string().uuid().optional(),
        deliverableId: z.string().uuid().optional(),
        repoId: z.string().uuid().optional(),
      })
      .refine((value) => value.taskId || value.projectId || value.deliverableId || value.repoId, "Pass a task, project, deliverable, or repo id."),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      const userId = ctx.userId;
      let projectId = input.projectId;
      let deliverableId = input.deliverableId;
      let repoIds = input.repoId ? [input.repoId] : [];
      const payload: Record<string, unknown> = {};
      if (input.taskId) {
        const task = await ctx.prisma.task.findFirst({ where: { id: input.taskId, userId, deletedAt: null } });
        if (!task) throw Object.assign(new Error("That task is not on your account."), { statusCode: 404 });
        const page = await ctx.prisma.taskPage.findFirst({ where: { taskId: task.id, userId } });
        payload.task = {
          id: task.id,
          title: task.title,
          description: clip(task.description),
          notes: clip(task.notes),
          pageText: plain(page?.content),
          projectId: task.projectId,
          repoId: task.repoId,
          deliverableId: task.deliverableId,
        };
        if (task.projectId) projectId = projectId ?? task.projectId;
        if (task.repoId) repoIds.push(task.repoId);
        if (task.deliverableId && !deliverableId) deliverableId = task.deliverableId;
      }
      if (deliverableId) {
        const deliverable = await ctx.prisma.deliverable.findFirst({ where: { id: deliverableId, userId, deletedAt: null } });
        if (!deliverable) throw Object.assign(new Error("That deliverable is not on your account."), { statusCode: 404 });
        payload.deliverable = { id: deliverable.id, title: deliverable.title, notes: clip(deliverable.notes), projectId: deliverable.projectId };
        projectId = projectId ?? deliverable.projectId;
      }
      if (projectId) {
        const project = await ctx.prisma.project.findFirst({ where: { id: projectId, userId, deletedAt: null } });
        if (!project) throw Object.assign(new Error("That project is not on your account."), { statusCode: 404 });
        const [deliverables, tasks, links, notes] = await Promise.all([
          ctx.prisma.deliverable.findMany({ where: { projectId, userId, deletedAt: null }, take: 12, select: { id: true, title: true, notes: true } }),
          ctx.prisma.task.findMany({ where: { projectId, userId, deletedAt: null }, take: 12, select: { id: true, title: true, description: true } }),
          ctx.prisma.projectRepo.findMany({ where: { projectId }, select: { repoId: true } }),
          ctx.prisma.meetingNote.findMany({ where: { projectId, userId }, orderBy: { askedAt: "desc" }, take: 5, select: { id: true, title: true, answer: true, prompt: true } }),
        ]);
        repoIds.push(...links.map((link) => link.repoId));
        payload.project = { id: project.id, name: project.name, summary: clip(project.summary), notes: clip(project.notes), pageText: plain(project.content) };
        payload.deliverables = deliverables.map((row) => ({ id: row.id, title: row.title, notes: clip(row.notes) }));
        payload.tasks = tasks.map((row) => ({ id: row.id, title: row.title, description: clip(row.description) }));
        payload.meetings = notes.map((row) => ({ id: row.id, title: row.title, excerpt: clip(row.answer || row.prompt) }));
      }
      const ids = [...new Set(repoIds)];
      if (ids.length) {
        const repos = await ctx.prisma.repo.findMany({
          where: { userId, id: { in: ids }, deletedAt: null },
          select: { id: true, fullName: true, description: true },
        });
        payload.repos = repos.map((row) => ({ id: row.id, fullName: row.fullName, description: clip(row.description) }));
      }
      // Without the code module the repo-read tools are not offered, so do not point at them.
      const reposReadable = ctx.modules === undefined || hasModule(ctx.modules, "code");
      payload.hint = reposReadable
        ? "Call hub_repo_overview for each repo id before drawing. Draw only names that appear here or in that overview."
        : "Reading repositories is not part of this template. Draw only names that appear here or that the person gives you.";
      return toolOk("Context for the diagram.", payload);
    },
  }),
];
