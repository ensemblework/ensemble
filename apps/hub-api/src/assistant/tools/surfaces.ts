import { isGuestIn } from "../../sharing/context.js";
import { z } from "zod";
import { assistantRequest } from "../request.js";
import { defineTool, toolOk } from "../types.js";

export const surfaceTools = [defineTool({
  name: "hub_read_surface", area: "context", description: "Read the open Ensemble surface and its current filters/selection: Today, Board, Context, pages/tasks/projects, meeting notes, Files, plots, diagrams, skills, settings (on the Connections tab: the apps connected in this space), Needs me, runs, Code, Completed, Trash, recap, spaces or sharing. Defaults to the person's open page. Returns bounded data and next tools; never screen pixels.",
  input: z.object({ path: z.string().max(500).optional() }), isWrite: false, risk: "low",
  async run(ctx, input) {
    const url = new URL(input.path ?? (ctx.page?.taskId ? `/tasks/${ctx.page.taskId}` : ctx.page?.path) ?? "/today", "https://ensemble.invalid");
    const [surface, id] = url.pathname.split("/").filter(Boolean);
    if (isGuestIn(ctx.userId) && (!surface || surface === "today")) throw new Error("Today is private to the space owner. You can work on this space’s shared content here.");
    const { getTool } = await import("../registry.js");
    const run = async (name: string, args: object) => { const { toolsForTurn } = await import("../apps.js"); const tool = (await toolsForTurn(ctx)).find(item => item.name === name); if (!tool) throw new Error("This surface is not available in this space."); return (await tool.run(ctx, tool.input.parse(args))).data; };
    let data: unknown;
    switch (surface) {
      case "tasks": data = { task: await run("hub_get_task", { taskId: id }), page: await run("hub_read_page", { taskId: id }) }; break;
      case "pages": data = id ? await run("hub_read_page", { pageId: id }) : await run("hub_list_pages", {}); break;
      case "projects": data = id ? await assistantRequest(ctx, "GET", `/api/projects/${encodeURIComponent(id)}`) : await run("hub_list_projects", {}); break;
      case "today": case undefined: data = { due: await run("hub_list_due", { from: new Intl.DateTimeFormat("en-CA", { timeZone: ctx.settings.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()), to: new Intl.DateTimeFormat("en-CA", { timeZone: ctx.settings.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()) }), events: await run("hub_list_events", { limit: 10 }), lists: await run("hub_list_desk_items", {}), layout: await run("hub_read_layout", { surface: "today" }) }; break;
      case "board": data = { filters: ctx.page?.surface?.filters, selected: ctx.page?.surface?.selectedIds?.length ? await run("hub_list_tasks", { ids: ctx.page.surface.selectedIds, limit: 100 }) : [], tasks: await run("hub_list_tasks", { ...(ctx.page?.surface?.visibleIds ? { ids: ctx.page.surface.visibleIds } : { query: url.searchParams.get("q") || undefined, status: url.searchParams.get("status") || undefined, owner: url.searchParams.get("owner") || undefined }), limit: 25 }), layout: await run("hub_read_layout", { surface: "board" }) }; break;
      case "context": data = { lists: await run("hub_list_desk_items", {}), layout: await run("hub_read_layout", { surface: "context" }), people: await run("hub_list_people", { query: url.searchParams.get("q") ?? "" }), projects: await run("hub_list_projects", {}) }; break;
      case "files": data = id ? await run("hub_read_file", { id }) : await run("hub_list_files", { query: url.searchParams.get("q") ?? "" }); break;
      case "diagrams": data = id ? await run("hub_get_diagram", { diagramId: id }) : await run("hub_list_diagrams", {}); break;
      case "plots": data = id ? await run("hub_get_plot", { plotId: id }) : await run("hub_list_plots", {}); break;
      case "meetings": { const meetingId = ctx.page?.meetingId ?? url.searchParams.get("session") ?? url.searchParams.get("note"); data = meetingId ? await run("hub_read_meeting_note", { meetingId }) : await run("hub_list_meeting_notes", {}); break; }
      case "settings": data = url.searchParams.get("tab") === "connections" ? { tab: "connections", connections: await run("hub_list_connections", {}), next: "Connecting, reconnecting and removing apps is the person's own step on this tab" } : { tab: url.searchParams.get("tab"), values: await run("hub_get_settings", {}), next: "hub_find_setting with the requested setting; hub_update_settings to change allowed keys" }; break;
      case "skills": { const skillId = id ?? url.searchParams.get("skill"); data = skillId ? await run("hub_read_skill", { skillId }) : await run("hub_list_skills", { includeDisabled: true }); break; }
      case "needs-me": data = await run("hub_list_approvals", {}); break;
      case "runs": { const runId = id ?? url.searchParams.get("run"); data = runId ? await run("hub_get_run", { runId }) : await run("hub_list_runs", {}); break; }
      case "workspace": data = await run("hub_list_activity", {}); break;
      case "code": data = { folders: await run("hub_list_code_folders", {}), changes: await run("hub_list_agent_changes", {}) }; break;
      case "completed": data = await assistantRequest(ctx, "GET", "/api/completed"); break;
      case "trash": data = await assistantRequest(ctx, "GET", "/api/deleted"); break;
      case "recap": data = await run("hub_weekly_recap", {}); break;
      case "metrics": data = await assistantRequest(ctx, "GET", "/api/metrics/summary"); break;
      case "spaces": data = await assistantRequest(ctx, "GET", "/api/spaces"); break;
      case "shared": data = await assistantRequest(ctx, "GET", "/api/sharing/with-me"); break;
      default: data = { path: url.pathname, next: "hub_find_setting or hub_how_to for this area" };
    }
    return toolOk(`Read ${surface ?? "today"}.`, { path: url.pathname + url.search, selection: ctx.page?.selection, data });
  }
})];
