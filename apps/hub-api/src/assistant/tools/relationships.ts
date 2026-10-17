import { z } from "zod";
import { assistantRequest } from "../request.js";
import { defineTool, toolOk } from "../types.js";

const Id = z.string().uuid();
const Input = z.object({
  action: z.enum(["attach", "detach", "refresh", "add_as_task", "import_people", "link_project", "unlink_project", "merge_people"]),
  source: z.string().max(40).optional(), kind: z.string().max(40).optional(), id: z.string().max(300).optional(),
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
    case "link_project": return { method: "POST", url: "/api/project-links", body: { projectId: need(input.projectId, "projectId"), source: need(input.source, "source"), containerId: need(input.containerId, "containerId"), containerName: input.containerName } };
    case "unlink_project": return { method: "DELETE", url: `/api/project-links/${need(input.linkId, "linkId")}` };
    case "merge_people": return { method: "POST", url: `/api/people/${need(input.personId, "personId to keep")}/merge`, body: { otherId: need(input.otherId, "otherId to merge") } };
  }
}

export const relationshipTools = [
  defineTool({ name: "hub_list_app_relationships", area: "context", description: "List connected item sources, items attached to a task/project, project source links or People merge suggestions. Use before changing relationships.", input: z.object({ view: z.enum(["sources", "attached", "project_links", "merge_suggestions"]), taskId: Id.optional(), projectId: Id.optional() }), isWrite: false, risk: "low", async run(ctx, input) {
    const query = new URLSearchParams(); if (input.taskId) query.set("taskId", input.taskId); if (input.projectId) query.set("projectId", input.projectId);
    const url = input.view === "sources" ? "/api/app-items/sources" : input.view === "attached" ? `/api/app-items/attached?${query}` : input.view === "project_links" ? `/api/project-links?${query}` : "/api/people/identity-suggestions";
    return toolOk(`Read ${input.view}.`, await assistantRequest(ctx, "GET", url));
  } }),
  defineTool({ name: "hub_manage_app_relationship", area: "context", description: "Attach/detach/refresh app context; convert an app item to a linked task; import app people; link/unlink a source container to a project; merge two People only when requested. Use real IDs from apps_search or hub_list_app_relationships. Does not post messages.", input: Input, isWrite: true, risk: "medium", alwaysHold: true, outsideTransaction: true,
    preview(_ctx, input) { action(input); return `${input.action.replaceAll("_", " ")}: ${JSON.stringify(Object.fromEntries(Object.entries(input).filter(([key, value]) => key !== "action" && value !== undefined)))}`; },
    async run(ctx, input) { const call = action(input); const result = await assistantRequest(ctx, call.method, call.url, call.body); return toolOk(`Completed ${input.action.replaceAll("_", " ")}.`, result, { invalidate: ["app-items", "context", "tasks", "people", "projects"] }); }
  }),
];
