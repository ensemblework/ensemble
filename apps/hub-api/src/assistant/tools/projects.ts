import { z } from "zod";
import { createProject } from "../../services/records.js";
import { defineTool, inTransaction, toolOk } from "../types.js";

export const projectTools = [
  defineTool({
    name: "hub_list_projects",
    area: "projects",
    description: "List project pages. Use these ids; never invent a project from a name in a summary.",
    input: z.object({ query: z.string().optional() }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      const projects = await ctx.prisma.project.findMany({
        where: {
          userId: ctx.userId,
          deletedAt: null,
          ...(input.query ? { name: { contains: input.query, mode: "insensitive" } } : {}),
        },
        select: { id: true, name: true, summary: true, status: true },
        orderBy: { name: "asc" },
        take: 40,
      });
      return toolOk(`Listed ${projects.length} project(s).`, { projects });
    },
  }),
  defineTool({
    name: "hub_create_project",
    area: "projects",
    description: "Create a project page.",
    input: z.object({ name: z.string().min(1), summary: z.string().optional() }),
    isWrite: true,
    risk: "low",
    undoable: true,
    preview(_ctx, input) {
      return `Create project “${input.name}”`;
    },
    async run(ctx, input) {
      const project = await inTransaction(ctx, (tx) => createProject(tx, ctx.userId, input, "agent"));
      return toolOk(`Created “${project.name}”.`, { project: { id: project.id, name: project.name } }, {
        invalidate: ["projects"],
        href: `/projects/${project.id}`,
      });
    },
  }),
  defineTool({
    name: "hub_list_deliverables",
    area: "projects",
    description: "List deliverables for a project.",
    input: z.object({ projectId: z.string().uuid() }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      const deliverables = await ctx.prisma.deliverable.findMany({
        where: { userId: ctx.userId, projectId: input.projectId, deletedAt: null },
        select: { id: true, title: true, status: true, due: true },
      });
      return toolOk(`Listed ${deliverables.length} deliverable(s).`, { deliverables });
    },
  }),
];
