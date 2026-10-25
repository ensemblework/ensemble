import { z } from "zod";
import { TaskStatus } from "@ensemble/shared-types";
import { IMPORT_SOURCES, SOURCE_LABEL, type ImportSourceId } from "../../imports/types.js";
import { getPreview } from "../../imports/previews.js";
import { labelStatus } from "../../services/tasks.js";
import { ORIGINAL_SELECT, originalBytes } from "../../files/originals.js";
import { assistantRequest } from "../request.js";
import { defineTool, toolOk } from "../types.js";

export const boardImportTools = [
  defineTool({ name: "hub_preview_board_import", area: "context", description: "Preview a whole board/workspace import using a connected account. First send source to list containers and previewId; then previewId + chosen container IDs for sample rows and status mapping. No import starts.", input: z.object({ source: z.enum(IMPORT_SOURCES).optional(), fileId: z.string().uuid().optional().describe("An export already uploaded in Files, instead of a connected account."), previewId: z.string().uuid().optional(), containers: z.array(z.string().max(200)).max(100).optional(), includeCompleted: z.boolean().optional() }), isWrite: false, risk: "low", async run(ctx, input) {
    let result;
    if (input.fileId) {
      await assistantRequest(ctx, "GET", `/api/documents/${input.fileId}`);
      const file = await ctx.prisma.document.findFirst({ where: { id: input.fileId, userId: ctx.userId, deletedAt: null }, select: { filename: true, ...ORIGINAL_SELECT } });
      if (!file) throw new Error("File not found.");
      const form = new FormData(); form.set("source", input.source ?? "csv"); form.set("file", new Blob([new Uint8Array(await originalBytes(file))]), file.filename);
      const encoded = new Request("https://ensemble.invalid", { method: "POST", body: form });
      result = await assistantRequest(ctx, "POST", "/api/imports/preview", Buffer.from(await encoded.arrayBuffer()), encoded.headers.get("content-type")!);
    } else result = await assistantRequest(ctx, "POST", "/api/imports/preview", { source: input.source, previewId: input.previewId, containers: input.containers, options: { includeCompleted: input.includeCompleted } });
    return toolOk("Import preview; nothing imported.", result);
  } }),
  defineTool({ name: "hub_start_board_import", area: "context", description: "Import selected whole boards/projects from hub_preview_board_import. Send previewId, chosen containers and reviewed statusMap. Runs in the background after Apply; returns job ID. Re-imports use the existing deduplication rules.", input: z.object({ previewId: z.string().uuid(), containers: z.array(z.string().max(200)).min(1).max(100), statusMap: z.record(TaskStatus).optional(), importAs: z.record(z.enum(["tasks", "pages"])).optional() }), isWrite: true, risk: "medium", alwaysHold: true, outsideTransaction: true,
    preview(ctx, input) {
      // Board names and the app, as the preview showed them; container ids are the app's own.
      const preview = getPreview(ctx.userId, input.previewId);
      const names = input.containers.map((id) => preview?.containers.find((container) => container.id === id)?.name ?? id);
      const from = preview ? ` from ${SOURCE_LABEL[preview.source] ?? preview.source}` : "";
      const statuses = input.statusMap ? Object.entries(input.statusMap).map(([name, to]) => `${name} → ${labelStatus(to)}`).join(", ") : "";
      return `Import ${input.containers.length} selected board(s)${from}: ${names.join(", ")}${statuses ? `; statuses ${statuses}` : " using the app's default status mapping"}.`;
    },
    async run(ctx, input) { const result = await assistantRequest(ctx, "POST", "/api/imports", input); return toolOk("Started the board import. Check its job for completion.", result, { href: "/board", invalidate: ["imports", "tasks", "pages", "projects"] }); }
  }),
  defineTool({ name: "hub_read_import", area: "context", description: "Read recent imports or one import job's progress, counts, links and errors.", input: z.object({ jobId: z.string().uuid().optional() }), isWrite: false, risk: "low", async run(ctx, input) { return toolOk("Read import progress.", await assistantRequest(ctx, "GET", `/api/imports${input.jobId ? `/${input.jobId}` : ""}`)); } }),
  defineTool({ name: "hub_manage_import", area: "context", description: "Cancel a running import or undo what a finished import created. Use jobId from hub_read_import. Undo follows the app's existing import rules.", input: z.object({ jobId: z.string().uuid(), action: z.enum(["cancel", "undo"]) }), isWrite: true, risk: "medium", outsideTransaction: true, alwaysHold: true, async preview(ctx, input) { const job = await ctx.prisma.importJob.findFirst({ where: { id: input.jobId, userId: ctx.userId }, select: { source: true, createdAt: true } }); if (!job) throw new Error("That import is not in this space. Read the imports again."); return `${input.action === "cancel" ? "Cancel" : "Undo"} the import from ${SOURCE_LABEL[job.source as ImportSourceId] ?? job.source} started ${job.createdAt.toISOString().slice(0, 10)}.`; }, async run(ctx, input) { return toolOk(`Import ${input.action} requested.`, await assistantRequest(ctx, "POST", `/api/imports/${input.jobId}/${input.action}`), { invalidate: ["imports", "tasks", "pages", "projects"] }); } }),
];
