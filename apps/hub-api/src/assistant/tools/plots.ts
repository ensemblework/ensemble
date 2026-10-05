import { z } from "zod";
import { plotConfigSchema } from "@ensemble/shared-types";
import { defineTool, inTransaction, toolOk } from "../types.js";
import { configOf, ingestDataset, ownedPlot } from "../../plots/service.js";
import type { Prisma } from "@prisma/client";

export const plotTools = [
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
      "Import a small table into Plots from CSV text or rows the person pasted in chat. Do not invent file paths. Pickle is refused. A write waits for Apply.",
    input: z.object({
      name: z.string().min(1).max(200),
      text: z.string().min(1).max(200_000),
    }),
    isWrite: true,
    risk: "low",
    undoable: true,
    preview(_ctx, input) {
      return `Import dataset “${input.name}”`;
    },
    async run(ctx, input) {
      const dataset = await ingestDataset(ctx.prisma, ctx.userId, { name: input.name, text: input.text, filename: `${input.name}.csv` });
      return toolOk(`Imported “${dataset.name}” (${dataset.rowCount} rows).`, dataset, { invalidate: ["plots"] });
    },
  }),
];
