import { z } from "zod";
import { hasModule } from "@ensemble/shared-types";
import { webSearch } from "../../workspace/research.js";
import {
  createDeliverable,
  createPerson,
  linkRepo,
  softDelete,
  unlinkRepo,
  updateDeliverable,
  updatePerson,
} from "../../services/records.js";
import { defineTool, inTransaction, toolOk } from "../types.js";
import { isGuestIn } from "../../sharing/context.js";

export const graphTools = [
  defineTool({
    name: "hub_create_person",
    area: "context",
    description: "Add a person to the graph. Do not use this to edit an existing person.",
    input: z.object({
      name: z.string().min(1),
      email: z.string().email().optional(),
      role: z.string().optional(),
      team: z.string().optional(),
    }),
    isWrite: true,
    risk: "low",
    undoable: true,
    preview(_ctx, input) {
      const bits = [input.name];
      if (input.role) bits.push(input.role);
      if (input.team) bits.push(input.team);
      return `Add person ${bits.join(", ")}`;
    },
    async run(ctx, input) {
      const person = await inTransaction(ctx, (tx) => createPerson(tx, ctx.userId, input, "agent"));
      return toolOk(`Added ${person.name}.`, { person: { id: person.id, name: person.name } }, { invalidate: ["people"] });
    },
  }),
  defineTool({
    name: "hub_update_person",
    area: "context",
    description: "Update a person's name, role, team, or email. The id comes from hub_list_people.",
    input: z.object({
      personId: z.string().uuid(),
      name: z.string().min(1).optional(),
      email: z.string().email().nullable().optional(),
      role: z.string().nullable().optional(),
      team: z.string().nullable().optional(),
    }),
    isWrite: true,
    risk: "low",
    undoable: true,
    async preview(ctx, input) {
      const person = await ctx.prisma.person.findFirst({ where: { id: input.personId, userId: ctx.userId }, select: { name: true, role: true } });
      const changes = [
        input.role !== undefined ? `role ${person?.role ?? "—"} → ${input.role ?? "—"}` : null,
        input.team !== undefined ? `team → ${input.team ?? "—"}` : null,
        input.name ? `name → ${input.name}` : null,
      ].filter(Boolean);
      return `Update ${person?.name ?? "person"}${changes.length ? `: ${changes.join(", ")}` : ""}`;
    },
    async run(ctx, input) {
      const { personId, ...patch } = input;
      const person = await inTransaction(ctx, (tx) => updatePerson(tx, ctx.userId, personId, patch, "agent"));
      return toolOk(`Updated ${person.name}.`, { id: person.id }, { invalidate: ["people"] });
    },
  }),
  defineTool({
    name: "hub_delete_person",
    area: "context",
    description: "Move a person to Trash. Tasks that mention them keep the id and show the person again after restore.",
    input: z.object({ personId: z.string().uuid() }),
    isWrite: true,
    risk: "medium",
    undoable: true,
    async preview(ctx, input) {
      const person = await ctx.prisma.person.findFirst({ where: { id: input.personId, userId: ctx.userId }, select: { name: true } });
      return `Move ${person?.name ?? "person"} to Trash`;
    },
    async run(ctx, input) {
      const result = await inTransaction(ctx, (tx) => softDelete(tx, ctx.userId, "person", input.personId, "agent"));
      return toolOk(`Moved ${result.label} to Trash.`, { ok: true }, { invalidate: ["people"] });
    },
  }),
  defineTool({
    name: "hub_link_repo",
    area: "context",
    description: "Link a GitHub repo (owner/name) to a project. Creates the repo row if it is new. Do not update an unrelated task to do this.",
    input: z.object({
      fullName: z.string().min(3),
      projectId: z.string().uuid().optional(),
      projectName: z.string().min(1).optional(),
    }),
    isWrite: true,
    risk: "low",
    undoable: true,
    preview(_ctx, input) {
      return `Link ${input.fullName} to ${input.projectName ?? "the project"}`;
    },
    async run(ctx, input) {
      const linked = await inTransaction(ctx, (tx) => linkRepo(tx, ctx.userId, input, "agent"));
      return toolOk(`Linked ${linked.repo.fullName} to “${linked.project.name}”.`, {
        projectId: linked.project.id,
        repoId: linked.repo.id,
      }, { invalidate: ["repos", "projects"], href: `/projects/${linked.project.id}` });
    },
  }),
  defineTool({
    name: "hub_unlink_repo",
    area: "context",
    description: "Remove the link between a project and a repo. The repo row stays.",
    input: z.object({ projectId: z.string().uuid(), repoId: z.string().uuid() }),
    isWrite: true,
    risk: "low",
    undoable: true,
    async run(ctx, input) {
      await inTransaction(ctx, (tx) => unlinkRepo(tx, ctx.userId, input));
      return toolOk("Unlinked the repo.", { ok: true }, { invalidate: ["repos", "projects"] });
    },
  }),
  defineTool({
    name: "hub_create_deliverable",
    area: "projects",
    description: "Add a deliverable to a project. due is YYYY-MM-DD.",
    input: z.object({
      title: z.string().min(1),
      projectId: z.string().uuid().optional(),
      projectName: z.string().min(1).optional(),
      due: z.string().optional(),
      notes: z.string().optional(),
      owner: z.string().optional(),
    }),
    isWrite: true,
    risk: "low",
    undoable: true,
    preview(_ctx, input) {
      return `Add deliverable “${input.title}”${input.projectName ? ` to ${input.projectName}` : ""}${input.due ? `, due ${input.due.slice(0, 10)}` : ""}`;
    },
    async run(ctx, input) {
      const row = await inTransaction(ctx, (tx) => createDeliverable(tx, ctx.userId, input, "agent"));
      return toolOk(`Added deliverable “${row.title}”.`, { id: row.id, projectId: row.projectId }, { invalidate: ["deliverables"] });
    },
  }),
  defineTool({
    name: "hub_update_deliverable",
    area: "projects",
    description: "Update a deliverable's title, notes, due date, or owner.",
    input: z.object({
      deliverableId: z.string().uuid(),
      title: z.string().min(1).optional(),
      notes: z.string().optional(),
      due: z.string().nullable().optional(),
      owner: z.string().nullable().optional(),
    }),
    isWrite: true,
    risk: "low",
    undoable: true,
    async preview(ctx, input) {
      const row = await ctx.prisma.deliverable.findFirst({ where: { id: input.deliverableId, userId: ctx.userId }, select: { title: true } });
      return `Update deliverable “${row?.title ?? input.deliverableId}”${input.title ? `: title → ${input.title}` : ""}`;
    },
    async run(ctx, input) {
      const { deliverableId, ...patch } = input;
      const row = await inTransaction(ctx, (tx) => updateDeliverable(tx, ctx.userId, deliverableId, patch, "agent"));
      return toolOk(`Updated “${row.title}”.`, { id: row.id }, { invalidate: ["deliverables"] });
    },
  }),
  defineTool({
    name: "hub_complete_deliverable",
    area: "projects",
    description: "Mark a deliverable completed.",
    input: z.object({ deliverableId: z.string().uuid() }),
    isWrite: true,
    risk: "low",
    undoable: true,
    async preview(ctx, input) {
      const row = await ctx.prisma.deliverable.findFirst({ where: { id: input.deliverableId, userId: ctx.userId }, select: { title: true, status: true } });
      return `Complete “${row?.title ?? "deliverable"}”: ${row?.status ?? "upcoming"} → completed`;
    },
    async run(ctx, input) {
      const row = await inTransaction(ctx, (tx) => updateDeliverable(tx, ctx.userId, input.deliverableId, { status: "completed" }, "agent"));
      return toolOk(`Completed “${row.title}”.`, { id: row.id }, { invalidate: ["deliverables"] });
    },
  }),
  defineTool({
    name: "hub_delete_deliverable",
    area: "projects",
    description: "Move a deliverable to Trash.",
    input: z.object({ deliverableId: z.string().uuid() }),
    isWrite: true,
    risk: "medium",
    undoable: true,
    async run(ctx, input) {
      const result = await inTransaction(ctx, (tx) => softDelete(tx, ctx.userId, "deliverable", input.deliverableId, "agent"));
      return toolOk(`Moved “${result.label}” to Trash.`, { ok: true }, { invalidate: ["deliverables"] });
    },
  }),
  defineTool({
    name: "hub_delete_entity",
    area: "context",
    description: "Move a project, repo, skill, or document to Trash. Tasks use hub_delete_task. People use hub_delete_person.",
    input: z.object({
      kind: z.enum(["project", "repo", "skill", "document"]),
      id: z.string().uuid(),
    }),
    isWrite: true,
    risk: "medium",
    undoable: true,
    async run(ctx, input) {
      if (input.kind === "skill" && ctx.modules !== undefined && !hasModule(ctx.modules, "skills")) {
        throw new Error("Not part of this template.");
      }
      const result = await inTransaction(ctx, (tx) => softDelete(tx, ctx.userId, input.kind, input.id, "agent"));
      return toolOk(`Moved “${result.label}” to Trash.`, { ok: true }, { invalidate: [input.kind] });
    },
  }),
  defineTool({
    name: "hub_restore_entity",
    area: "context",
    description: "Restore a trashed task, project, person, repo, deliverable, reminder, skill, document, or comment.",
    input: z.object({
      kind: z.enum(["task", "project", "person", "skill", "document", "repo", "deliverable", "reminder", "comment"]),
      id: z.string().uuid(),
    }),
    isWrite: true,
    risk: "low",
    undoable: false,
    async run(ctx, input) {
      if (input.kind === "skill" && ctx.modules !== undefined && !hasModule(ctx.modules, "skills")) {
        throw new Error("Not part of this template.");
      }
      const { restoreOne } = await import("../../services/records.js");
      await restoreOne(ctx.prisma, ctx.userId, input.kind, input.id);
      return toolOk(`Restored the ${input.kind}.`, { ok: true }, { invalidate: [input.kind] });
    },
  }),
  defineTool({
    name: "hub_list_due",
    area: "tasks",
    description: "What is due between two dates (YYYY-MM-DD, inclusive), across open tasks, upcoming deliverables, and active reminders.",
    input: z.object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      const from = new Date(`${input.from}T00:00:00.000Z`);
      const to = new Date(`${input.to}T23:59:59.999Z`);
      const [tasks, deliverables, reminders] = await Promise.all([
        ctx.prisma.task.findMany({
          where: { userId: ctx.userId, deletedAt: null, status: { notIn: ["done", "dropped"] }, due: { gte: from, lte: to } },
          select: { id: true, title: true, status: true, due: true, priority: true },
          take: 40,
        }),
        ctx.prisma.deliverable.findMany({
          where: { userId: ctx.userId, deletedAt: null, status: "upcoming", due: { gte: from, lte: to } },
          select: { id: true, title: true, due: true, projectId: true },
          take: 40,
        }),
        // Reminders are private to the space's owner.
        isGuestIn(ctx.userId)
          ? Promise.resolve([] as Array<{ id: string; title: string; dueDate: string; dueTime: string | null }>)
          : ctx.prisma.reminder.findMany({
              where: { userId: ctx.userId, deletedAt: null, dismissedAt: null, dueDate: { gte: input.from, lte: input.to } },
              select: { id: true, title: true, dueDate: true, dueTime: true },
              take: 40,
            }),
      ]);
      return toolOk(
        `${tasks.length} task(s), ${deliverables.length} deliverable(s), ${reminders.length} reminder(s) due ${input.from} to ${input.to}.`,
        { tasks, deliverables, reminders },
      );
    },
  }),
  defineTool({
    name: "hub_web_search",
    area: "context",
    description: "Search the public web. Cite the returned links. If this returns nothing, say you could not verify it. Never invent a citation.",
    input: z.object({ query: z.string().min(2).max(300) }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      const grounded = await groundedSearch(ctx, input.query);
      if (grounded.length) return toolOk(`Found ${grounded.length} source(s).`, { results: grounded, provider: "grounding" });
      try {
        const hits = await webSearch(input.query);
        return toolOk(hits.length ? `Found ${hits.length} source(s).` : "The search returned nothing.", { results: hits, provider: "fallback" });
      } catch (error) {
        ctx.app.log.warn({ err: error }, "web search unavailable");
        return toolOk("Web search is unavailable.", { results: [], provider: "unavailable", error: "search unavailable" });
      }
    },
  }),
];

async function groundedSearch(
  ctx: { app: { log: { warn: (obj: unknown, msg?: string) => void } }; userId: string; settings: { models: { easy: { provider: string; model: string }; medium: { provider: string; model: string }; high: { provider: string; model: string }; max: { provider: string; model: string } }; assistant: { defaultTier: "easy" | "medium" | "high" | "max" } } },
  query: string,
): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const tier = ctx.settings.models[ctx.settings.assistant.defaultTier] ?? ctx.settings.models.medium;
  try {
    const { runtime } = await import("../../lib/runtime.js");
    const result = await runtime<{ results: Array<{ title: string; url: string; snippet: string }>; error?: string }>("/api/search", {
      method: "POST",
      timeoutMs: 20_000,
      json: { userId: ctx.userId, provider: tier.provider, model: tier.model, query },
    });
    if (result.error) ctx.app.log.warn({ error: result.error, provider: tier.provider }, "grounded search unavailable");
    return Array.isArray(result.results) ? result.results.filter((row) => row.url) : [];
  } catch (error) {
    ctx.app.log.warn({ err: error }, "grounded search unavailable");
    return [];
  }
}
