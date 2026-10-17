import { z } from "zod";
import { assistantRequest } from "../request.js";
import { defineTool, toolOk } from "../types.js";
import { LINK_SOURCES } from "../../projects/links.js";

const Id = z.string().uuid();
const Input = z.object({
  action: z.enum(["attach", "detach", "refresh", "add_as_task", "import_people", "link_project", "unlink_project", "merge_people"]),
  source: z.string().max(40).optional().describe(`App source from search. Project-link rules use: ${LINK_SOURCES.join(", ")}; list project_containers for existing container IDs.`), kind: z.string().max(40).optional(), id: z.string().max(300).optional(),
  taskId: Id.optional(), projectId: Id.optional(), artifactId: Id.optional(), linkId: Id.optional(),
  personId: Id.optional(), otherId: Id.optional(), containerId: z.string().max(300).optional(), containerName: z.string().max(200).optional(),
});
const need = <T>(value: T | undefined, name: string): T => { if (value === undefined) throw new Error(`Send ${name}.`); return value; };

function action(input: z.infer<typeof Input>): { method: "POST" | "DELETE"; url: string; body?: object } {
  const ref = () => ({ source: need(input.source, "source from apps_search"), kind: need(input.kind, "kind from apps_search"), id: need(input.id, "id from apps_search") });
  const destination = () => { if (!input.taskId && !input.projectId) throw new Error("Send taskId or projectId."); return { taskId: input.taskId, projectId: input.projectId }; };
  switch (input.action) {
    case "attach": return { method: "POST", url: "/api/app-items/attach", body: { ...ref(), ...destination() } };
    case "detach": return { method: "DELETE", url: `/api/app-items/attached/${need(input.artifactId, "artifactId")}?${new URLSearchParams(Object.entries(destination()).filter((row): row is [string, string] => typeof row[1] === "string"))}` };
    case "refresh": return { method: "POST", url: `/api/app-items/attached/${need(input.artifactId, "artifactId")}/refresh` };
    case "add_as_task": return { method: "POST", url: "/api/app-items/task", body: { ...ref(), projectId: input.projectId } };
    case "import_people": return { method: "POST", url: "/api/app-items/people", body: { source: need(input.source, "source") } };
    case "link_project": if (!(LINK_SOURCES as readonly string[]).includes(input.source ?? "")) throw new Error(`Project source links use ${LINK_SOURCES.join(", ")}. Read project_containers for the source and ID.`); return { method: "POST", url: "/api/project-links", body: { projectId: need(input.projectId, "projectId"), source: need(input.source, "source"), containerId: need(input.containerId, "containerId"), containerName: input.containerName } };
    case "unlink_project": return { method: "DELETE", url: `/api/project-links/${need(input.linkId, "linkId")}` };
    case "merge_people": return { method: "POST", url: `/api/people/${need(input.personId, "personId to keep")}/merge`, body: { otherId: need(input.otherId, "otherId to merge") } };
  }
}

export const relationshipTools = [
  defineTool({ name: "hub_list_app_relationships", area: "context", description: "List connected item sources, attached task/project items, project links, known project source containers or People merge suggestions. Use real returned sources/IDs before changing relationships.", input: z.object({ view: z.enum(["sources", "attached", "project_links", "project_containers", "merge_suggestions"]), taskId: Id.optional(), projectId: Id.optional() }), isWrite: false, risk: "low", async run(ctx, input) {
    const query = new URLSearchParams(); if (input.taskId) query.set("taskId", input.taskId); if (input.projectId) query.set("projectId", input.projectId);
    const url = input.view === "sources" ? "/api/app-items/sources" : input.view === "attached" ? `/api/app-items/attached?${query}` : input.view === "project_links" ? `/api/project-links?${query}` : input.view === "project_containers" ? "/api/project-links/containers" : "/api/people/identity-suggestions";
    return toolOk(`Read ${input.view}.`, { ...await assistantRequest(ctx, "GET", url), ...(input.view === "sources" || input.view === "project_containers" ? { linkSources: LINK_SOURCES } : {}) });
  } }),
  defineTool({ name: "hub_manage_app_relationship", area: "context", description: "Attach/detach/refresh app context; convert an app item to a linked task; import app people; link/unlink a source container to a project; merge two People only when requested. Use real IDs from apps_search or hub_list_app_relationships. Does not post messages.", input: Input, isWrite: true, risk: "medium", alwaysHold: true, outsideTransaction: true,
    async preview(ctx, input) {
      action(input);
      const labels: string[] = [];
      if (input.taskId) { const row = await ctx.prisma.task.findFirst({ where: { id: input.taskId, userId: ctx.userId, deletedAt: null }, select: { title: true } }); if (!row) throw new Error("Task not found in this space."); labels.push(`task “${row.title}”`); }
      if (input.projectId) { const row = await ctx.prisma.project.findFirst({ where: { id: input.projectId, userId: ctx.userId, deletedAt: null }, select: { name: true } }); if (!row) throw new Error("Project not found in this space."); labels.push(`project “${row.name}”`); }
      if (input.linkId) { const row = await ctx.prisma.projectLink.findFirst({ where: { id: input.linkId, userId: ctx.userId }, select: { source: true, containerName: true, containerId: true, project: { select: { name: true } } } }); if (!row) throw new Error("Project link not found in this space."); labels.push(`${row.source} “${row.containerName || row.containerId}” from project “${row.project.name}”`); }
      if (["attach", "add_as_task", "import_people"].includes(input.action)) {
        const result = await assistantRequest(ctx, "GET", "/api/app-items/sources");
        const source = result.sources?.find((row: any) => row.id === input.source);
        if (!source) throw new Error("That app is not ready. Read hub_list_app_relationships sources first.");
        if (input.action === "import_people" && !source.people) throw new Error("This app does not provide a People import.");
        if (input.kind && !source.kinds.includes(input.kind)) throw new Error(`This app supports: ${source.kinds.join(", ")}.`);
        labels.push(source.name);
      }
      if (input.artifactId) { const row = await ctx.prisma.artifact.findFirst({ where: { id: input.artifactId, userId: ctx.userId, deletedAt: null }, select: { title: true } }); if (!row) throw new Error("Attached item not found in this space."); labels.push(`item “${row.title}”`); }
      if (input.action === "merge_people") { const rows = await ctx.prisma.person.findMany({ where: { userId: ctx.userId, deletedAt: null, id: { in: [input.personId!, input.otherId!] } }, select: { id: true, name: true } }); if (rows.length !== 2) throw new Error("Choose two different people in this space."); return `Merge “${rows.find(row => row.id === input.otherId)!.name}” into “${rows.find(row => row.id === input.personId)!.name}”.`; }
      return `${input.action.replaceAll("_", " ")}: ${labels.join(", ")}${input.containerName ? `; ${input.source} “${input.containerName}”` : input.containerId ? `; ${input.source} container ${input.containerId}` : input.id ? `; source item ${input.id}` : ""}.`;
    },
    async run(ctx, input) { const call = action(input); const result = await assistantRequest(ctx, call.method, call.url, call.body); return toolOk(`Completed ${input.action.replaceAll("_", " ")}.`, result, { invalidate: ["app-items", "context", "tasks", "people", "projects"] }); }
  }),
];
