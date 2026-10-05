import { z } from "zod";
import { defineTool, toolOk } from "../types.js";

export const skillTools = [
  defineTool({
    name: "hub_list_skills",
    area: "skills",
    description: "List current enabled skills. Retrieval is current-version only.",
    input: z.object({}),
    isWrite: false,
    risk: "low",
    async run(ctx) {
      const skills = await ctx.prisma.skill.findMany({
        where: { userId: ctx.userId, deletedAt: null, enabled: true },
        select: { id: true, slug: true, name: true, version: true, confidence: true },
      });
      return toolOk(`Listed ${skills.length} skill(s).`, { skills });
    },
  }),
  defineTool({
    name: "hub_read_skill",
    area: "skills",
    description: "Read the current SKILL.md body for one skill.",
    input: z.object({ skillId: z.string().uuid() }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      const skill = await ctx.prisma.skill.findFirst({
        where: { id: input.skillId, userId: ctx.userId, deletedAt: null },
        select: { id: true, name: true, slug: true, version: true, body: true },
      });
      if (!skill) throw new Error("call hub_list_skills and match by name — never invent a skill.");
      return toolOk(`Read “${skill.name}”.`, { skill }, { href: `/skills?skill=${skill.id}` });
    },
  }),
];
