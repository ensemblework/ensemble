import { z } from "zod";
import { defineTool, toolOk } from "../types.js";
import { assistantRequest } from "../request.js";

export const skillTools = [
  defineTool({
    name: "hub_list_skills",
    area: "skills",
    description: "List current enabled skills. Retrieval is current-version only.",
    input: z.object({ includeDisabled: z.boolean().default(false) }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      const skills = await ctx.prisma.skill.findMany({
        where: { userId: ctx.userId, deletedAt: null, ...(input.includeDisabled ? {} : { enabled: true }) },
        select: { id: true, slug: true, name: true, version: true, confidence: true, enabled: true },
      });
      return toolOk(`Listed ${skills.length} skill(s).`, { skills });
    },
  }),
  defineTool({
    name: "hub_read_skill",
    area: "skills",
    description: "Read the current SKILL.md body for one skill.",
    input: z.object({ skillId: z.string().uuid(), offset: z.number().int().nonnegative().default(0), includeVersions: z.boolean().default(false) }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      const skill = await ctx.prisma.skill.findFirst({
        where: { id: input.skillId, userId: ctx.userId, deletedAt: null },
        select: { id: true, name: true, slug: true, version: true, body: true },
      });
      if (!skill) throw new Error("call hub_list_skills and match by name — never invent a skill.");
      const body = skill.body.slice(input.offset, input.offset + 4500);
      const versions = input.includeVersions ? await ctx.prisma.skillVersion.findMany({ where: { skillId: skill.id }, orderBy: { version: "desc" }, take: 3, select: { version: true, note: true, createdAt: true } }) : undefined;
      return toolOk(`Read “${skill.name}”.`, { skill: { ...skill, body }, offset: input.offset, total: skill.body.length, ...(input.offset + body.length < skill.body.length ? { nextOffset: input.offset + body.length } : {}), ...(versions ? { versions } : {}) }, { href: `/skills?skill=${skill.id}` });
    },
  }),
  defineTool({
    name: "hub_manage_skill", area: "skills", description: "Create a personal skill with name/body, update its body/name/description/enabled using expectedVersion from hub_read_skill, restore a retained version, or delete it. Changes standing instructions after Apply; no test/model call is started.",
    input: z.object({ action: z.enum(["create", "update", "restore", "delete"]), skillId: z.string().uuid().optional(), name: z.string().min(1).max(200).optional(), description: z.string().max(2000).optional(), body: z.string().max(100_000).optional(), enabled: z.boolean().optional(), expectedVersion: z.number().int().positive().optional(), version: z.number().int().positive().optional() }),
    isWrite: true, risk: "medium", alwaysHold: true, outsideTransaction: true,
    preview(_ctx, input) { if (input.action === "create" && (!input.name || !input.body)) throw new Error("Create needs name and body."); if (input.action !== "create" && !input.skillId) throw new Error("Read the skill first and send skillId."); if (input.action === "update" && !input.expectedVersion) throw new Error("Send expectedVersion from hub_read_skill."); return `${input.action} personal skill ${input.name ?? input.skillId}${input.body ? `: ${input.body.slice(0, 700)}` : ""}${input.enabled !== undefined ? `; enabled ${input.enabled}` : ""}.`; },
    async run(ctx, input) {
      let result;
      if (input.action === "create") result = await assistantRequest(ctx, "POST", "/api/skills", { name: input.name, description: input.description, body: input.body });
      else if (input.action === "update") result = await assistantRequest(ctx, "PATCH", `/api/skills/${input.skillId}`, { name: input.name, description: input.description, body: input.body, enabled: input.enabled, expectedVersion: input.expectedVersion, note: "Edited through the assistant" });
      else if (input.action === "restore") result = await assistantRequest(ctx, "POST", `/api/skills/${input.skillId}/restore`, { version: input.version });
      else result = await assistantRequest(ctx, "DELETE", `/api/skills/${input.skillId}`);
      const skill = result.skill;
      return toolOk(`Skill ${input.action} completed.`, skill ? { id: skill.id, name: skill.name, version: skill.version, enabled: skill.enabled } : result, { href: "/skills", invalidate: ["skills"] });
    }
  }),
];
