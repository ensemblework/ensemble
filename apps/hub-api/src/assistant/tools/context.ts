import { z } from "zod";
import { defineTool, toolOk } from "../types.js";

export const contextTools = [
  defineTool({
    name: "hub_list_people",
    area: "context",
    description: "List people in the Engineer Graph. Match by name, then use the id.",
    input: z.object({ query: z.string().optional() }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      const people = await ctx.prisma.person.findMany({
        where: {
          userId: ctx.userId,
          deletedAt: null,
          ...(input.query ? { name: { contains: input.query, mode: "insensitive" } } : {}),
        },
        select: { id: true, name: true, email: true, role: true },
        take: 40,
      });
      const links = people.length
        ? await ctx.prisma.projectPerson.findMany({
            where: { personId: { in: people.map((person) => person.id) }, project: { userId: ctx.userId, deletedAt: null } },
            select: { personId: true, role: true, project: { select: { id: true, name: true } } },
          })
        : [];
      const rows = people.map((person) => ({
        ...person,
        projects: links
          .filter((link) => link.personId === person.id)
          .map((link) => ({ id: link.project.id, name: link.project.name, role: link.role })),
      }));
      return toolOk(`Listed ${rows.length} people.`, { people: rows });
    },
  }),
  defineTool({
    name: "hub_list_repos",
    area: "context",
    description: "List known repositories.",
    input: z.object({ query: z.string().optional() }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      const repos = await ctx.prisma.repo.findMany({
        where: {
          userId: ctx.userId,
          deletedAt: null,
          ...(input.query ? { fullName: { contains: input.query, mode: "insensitive" } } : {}),
        },
        select: { id: true, fullName: true, provider: true, tracked: true },
        take: 40,
      });
      const links = repos.length
        ? await ctx.prisma.projectRepo.findMany({
            where: { repoId: { in: repos.map((repo) => repo.id) }, project: { userId: ctx.userId, deletedAt: null } },
            select: { repoId: true, project: { select: { id: true, name: true } } },
          })
        : [];
      const rows = repos.map((repo) => ({
        ...repo,
        projects: links.filter((link) => link.repoId === repo.id).map((link) => ({ id: link.project.id, name: link.project.name })),
      }));
      return toolOk(`Listed ${rows.length} repo(s).`, { repos: rows });
    },
  }),
  defineTool({
    name: "hub_list_approvals",
    area: "context",
    description: "List undecided Needs-me approvals.",
    input: z.object({}),
    isWrite: false,
    risk: "low",
    async run(ctx) {
      const approvals = await ctx.prisma.approval.findMany({
        where: { userId: ctx.userId, decision: null },
        orderBy: { requestedAt: "asc" },
        take: 20,
      });
      return toolOk(`Listed ${approvals.length} pending approval(s).`, { approvals });
    },
  }),
];
