import { z } from "zod";
import { fileFormat, isWorkspace, plotConfigSchema, workspaceSchema } from "@ensemble/shared-types";
import { defineTool, inTransaction, toolOk, type ToolContext } from "../types.js";
import { configOf, ingestDataset, loadOwnedTable, ownedPlot } from "../../plots/service.js";
import { decodeText } from "../../files/extract.js";
import type { Prisma } from "@prisma/client";

export const plotTools = [
  defineTool({
    name: "hub_get_plot",
    area: "context",
    description: "Read a saved chart or plot space, including its configuration and dataset IDs. For a tile mention, pass the space UUID before / as plotId and the decoded tile ID after / as tileId. Read source tables with hub_get_dataset.",
    input: z.object({ plotId: z.string().uuid(), tileId: z.string().min(1).max(40).optional() }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      const row = await ownedPlot(ctx.prisma, ctx.userId, input.plotId);
      if (isWorkspace(row.config)) {
        const config = workspaceSchema.parse(row.config);
        if (input.tileId) {
          const tile = config.tiles.find((tile) => tile.id === input.tileId);
          if (!tile) throw Object.assign(new Error("That tile is not in this plot space."), { statusCode: 404 });
          config.tiles = [tile];
        }
        return toolOk(`Plot space “${row.title}”.`, { id: row.id, title: row.title, datasetIds: config.datasetIds, config });
      }
      if (input.tileId) throw Object.assign(new Error("This saved plot is not a plot space."), { statusCode: 400 });
      return toolOk(`Plot “${row.title}”.`, { id: row.id, title: row.title, datasetId: row.datasetId, config: configOf(row.config) });
    },
  }),
  defineTool({
    name: "hub_get_dataset",
    area: "context",
    description: "Read an uploaded table's columns, row count, and up to 40 preview rows. Use the dataset id from a page mention or hub_list_datasets before plotting. Plot creation uses the full stored table.",
    input: z.object({ datasetId: z.string().uuid() }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      const loaded = await loadOwnedTable(ctx.prisma, ctx.userId, input.datasetId);
      return toolOk("Dataset columns and preview.", { id: input.datasetId, columns: loaded.table.columns, rowCount: loaded.table.rows.length, rows: loaded.table.rows.slice(0, 40) });
    },
  }),
  defineTool({
    name: "hub_list_plots",
    area: "context",
    description: "List this person's saved plots. Optional query matches the title. Read-only.",
    input: z.object({ query: z.string().optional() }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      const rows = await ctx.prisma.plot.findMany({
        where: {
          userId: ctx.userId,
          deletedAt: null,
          ...(input.query ? { title: { contains: input.query, mode: "insensitive" } } : {}),
        },
        orderBy: { updatedAt: "desc" },
        take: 30,
        select: { id: true, title: true, datasetId: true, updatedAt: true },
      });
      return toolOk(rows.length ? `${rows.length} plot${rows.length === 1 ? "" : "s"}.` : "No plots yet.", {
        plots: rows.map((row) => ({ id: row.id, title: row.title, datasetId: row.datasetId, updatedAt: row.updatedAt.toISOString() })),
      });
    },
  }),
  defineTool({
    name: "hub_list_datasets",
    area: "context",
    description: "List tables this person imported into Plots. Read-only. Names are labels, not file paths.",
    input: z.object({ query: z.string().optional() }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      const rows = await ctx.prisma.plotDataset.findMany({
        where: {
          userId: ctx.userId,
          deletedAt: null,
          ...(input.query ? { name: { contains: input.query, mode: "insensitive" } } : {}),
        },
        orderBy: { updatedAt: "desc" },
        take: 30,
        select: { id: true, name: true, rowCount: true, columns: true },
      });
      return toolOk(rows.length ? `${rows.length} dataset${rows.length === 1 ? "" : "s"}.` : "No datasets yet.", {
        datasets: rows.map((row) => ({
          id: row.id,
          name: row.name,
          rowCount: row.rowCount,
          columns: row.columns,
        })),
      });
    },
  }),
  defineTool({
    name: "hub_create_plot",
    area: "context",
    description:
      "Create a 2D plot from a dataset that already belongs to this person. Pass datasetId from hub_list_datasets. config.chart is a chart type, config.x is the x column, config.series is [{y, axis: left|right}]. A write waits for Apply.",
    input: z.object({
      title: z.string().min(1).max(200),
      datasetId: z.string().uuid(),
      config: plotConfigSchema.partial().optional(),
    }),
    isWrite: true,
    risk: "low",
    undoable: true,
    preview(_ctx, input) {
      return `Create plot “${input.title}”`;
    },
    async run(ctx, input) {
      const dataset = await ctx.prisma.plotDataset.findFirst({ where: { id: input.datasetId, userId: ctx.userId, deletedAt: null } });
      if (!dataset) throw Object.assign(new Error("That dataset is not on your account."), { statusCode: 404 });
      const config = plotConfigSchema.parse({ ...configOf({}), ...input.config });
      const row = await inTransaction(ctx, (tx) =>
        tx.plot.create({
          data: {
            userId: ctx.userId,
            title: input.title.trim().slice(0, 200),
            datasetId: dataset.id,
            config: config as unknown as Prisma.InputJsonValue,
          },
        }),
      );
      return toolOk(`Created plot “${row.title}”.`, { id: row.id, title: row.title }, { invalidate: ["plots"], href: `/plots/${row.id}` });
    },
  }),
  defineTool({
    name: "hub_update_plot",
    area: "context",
    description: "Edit a plot that belongs to this person. Pass the fields to change. A write waits for Apply.",
    input: z.object({
      plotId: z.string().uuid(),
      title: z.string().min(1).max(200).optional(),
      config: plotConfigSchema.partial().optional(),
    }),
    isWrite: true,
    risk: "low",
    undoable: true,
    async preview(ctx, input) {
      const row = await ctx.prisma.plot.findFirst({ where: { id: input.plotId, userId: ctx.userId, deletedAt: null }, select: { title: true } });
      return `Update plot “${row?.title ?? "plot"}”`;
    },
    async run(ctx, input) {
      const current = await ownedPlot(ctx.prisma, ctx.userId, input.plotId);
      const config = input.config ? plotConfigSchema.parse({ ...configOf(current.config), ...input.config }) : undefined;
      const row = await inTransaction(ctx, (tx) =>
        tx.plot.update({
          where: { id: current.id },
          data: {
            ...(input.title ? { title: input.title.trim().slice(0, 200) } : {}),
            ...(config ? { config: config as unknown as Prisma.InputJsonValue } : {}),
          },
        }),
      );
      return toolOk(`Updated plot “${row.title}”.`, { id: row.id, title: row.title }, { invalidate: ["plots"], href: `/plots/${row.id}` });
    },
  }),
  defineTool({
    name: "hub_import_dataset",
    area: "context",
    description:
      "Make a Plots dataset from a CSV, TSV or Excel (.xlsx) file in Files (fileId from hub_list_files; sheet picks a workbook tab, default the first), or from CSV text or rows pasted in chat (text, header row first). Do not invent file paths. Pickle is refused. A write waits for Apply.",
    input: z.object({
      name: z.string().min(1).max(200).optional().describe("The dataset's name. Default: the file name."),
      text: z.string().min(1).max(200_000).optional().describe("CSV text, header row first."),
      fileId: z.string().uuid().optional().describe("A CSV, TSV or .xlsx file in Files."),
      sheet: z.string().min(1).max(200).optional().describe("The workbook tab to use (.xlsx only)."),
    }),
    isWrite: true,
    risk: "low",
    outsideTransaction: true,
    async preview(ctx, input) {
      if (Boolean(input.text) === Boolean(input.fileId)) throw Object.assign(new Error("Send either fileId (a file in Files) or text (pasted CSV)."), { statusCode: 400 });
      if (input.fileId) {
        const table = await fileTable(ctx, input.fileId, input.sheet);
        return `Import dataset “${input.name ?? table.name}” from ${table.filename}${table.sheet ? ` (sheet ${table.sheet})` : ""}`;
      }
      return `Import dataset “${input.name ?? "Pasted table"}”`;
    },
    async run(ctx, input) {
      if (Boolean(input.text) === Boolean(input.fileId)) throw Object.assign(new Error("Send either fileId (a file in Files) or text (pasted CSV)."), { statusCode: 400 });
      if (input.fileId) {
        const table = await fileTable(ctx, input.fileId, input.sheet);
        const name = input.name ?? table.name;
        const dataset = await ingestDataset(ctx.prisma, ctx.userId, { name, text: table.text, filename: table.parseAs });
        const warnings = [...dataset.warnings, ...table.warnings];
        return toolOk(`Imported “${dataset.name}” (${dataset.rowCount} rows) from ${table.filename}${table.sheet ? `, sheet ${table.sheet}` : ""}.`, {
          id: dataset.id,
          name: dataset.name,
          columns: dataset.columns,
          rowCount: dataset.rowCount,
          ...(table.sheets.length > 1 ? { sheet: table.sheet, sheets: table.sheets } : {}),
          ...(warnings.length ? { warnings } : {}),
        }, { invalidate: ["plots"] });
      }
      const name = input.name ?? "Pasted table";
      const dataset = await ingestDataset(ctx.prisma, ctx.userId, { name, text: input.text, filename: `${name}.csv` });
      return toolOk(`Imported “${dataset.name}” (${dataset.rowCount} rows).`, dataset, { invalidate: ["plots"] });
    },
  }),
];

const TEXT_TABLES = new Set(["csv", "tsv", "txt"]);
const WORKBOOKS = new Set(["xlsx", "xlsm"]);
const SHEET_HEADER = /^--- Sheet \d+: (.*) ---$/;

/** The sheets of a workbook as Files read them (`--- Sheet N: name ---` then CSV). */
function workbookSheets(text: string): Array<{ name: string; csv: string }> {
  const sheets: Array<{ name: string; lines: string[] }> = [];
  for (const line of text.split("\n")) {
    const header = SHEET_HEADER.exec(line);
    if (header) sheets.push({ name: header[1]!, lines: [] });
    else sheets.at(-1)?.lines.push(line);
  }
  return sheets.map((sheet) => ({ name: sheet.name, csv: sheet.lines.join("\n").trim() }));
}

/**
 * A table from a file in Files: CSV and TSV from the original bytes, an .xlsx from the
 * per-sheet CSV text Files already extracted. Only this space's files.
 */
async function fileTable(ctx: ToolContext, fileId: string, sheet?: string): Promise<{ text: string; parseAs: string; name: string; filename: string; sheet: string; sheets: string[]; warnings: string[] }> {
  const row = await ctx.prisma.document.findFirst({
    where: { id: fileId, userId: ctx.userId, deletedAt: null },
    select: { filename: true, original: true, parseStatus: true, warnings: true, artifact: { select: { text: true } } },
  });
  if (!row) throw Object.assign(new Error("No file with that id in Files. Call hub_list_files and use an id it returns."), { statusCode: 404 });
  const format = fileFormat(row.filename).ext;
  const base = row.filename.replace(/\.[^.]+$/, "") || "Dataset";
  if (TEXT_TABLES.has(format)) {
    if (sheet) throw Object.assign(new Error(`${row.filename} has no sheets; leave sheet out.`), { statusCode: 400 });
    const text = decodeText(row.original);
    return { text, parseAs: format === "tsv" ? `${base}.tsv` : `${base}.csv`, name: base, filename: row.filename, sheet: "", sheets: [], warnings: [] };
  }
  if (!WORKBOOKS.has(format)) {
    throw Object.assign(new Error(`${row.filename} is not a CSV, TSV or .xlsx file. Make an .xlsx or CSV copy, or upload it on the Plots page.`), { statusCode: 400 });
  }
  if (row.parseStatus === "queued" || row.parseStatus === "running") throw Object.assign(new Error("Ensemble is still reading this workbook. Try again in a minute."), { statusCode: 409 });
  const sheets = workbookSheets(row.artifact?.text ?? "");
  if (row.parseStatus !== "ready" || !sheets.length) throw Object.assign(new Error(`Ensemble could not read the sheets in ${row.filename}. Upload it on the Plots page instead.`), { statusCode: 400 });
  const chosen = sheet ? sheets.find((item) => item.name.trim().toLowerCase() === sheet.trim().toLowerCase()) : sheets.find((item) => item.csv);
  if (!chosen) throw Object.assign(new Error(`${row.filename} has no sheet “${sheet}”. Its sheets: ${sheets.map((item) => item.name).join(", ")}.`), { statusCode: 400 });
  if (!chosen.csv) throw Object.assign(new Error(`Sheet “${chosen.name}” is empty. Its sheets: ${sheets.map((item) => item.name).join(", ")}.`), { statusCode: 400 });
  const warnings = row.warnings.filter((warning) => /rows/i.test(warning)).map((warning) => warning.replace(/^Agents can read/, "Plots got"));
  return { text: chosen.csv, parseAs: `${base}.csv`, name: sheets.length > 1 ? `${base} – ${chosen.name}` : base, filename: row.filename, sheet: chosen.name, sheets: sheets.map((item) => item.name), warnings };
}
