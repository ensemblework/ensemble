import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { buildSeries, defaultPlotConfig, emptyWorkspace, isWorkspace, lttb, plotConfigSchema, plottedRows, tableToCsv, workspaceBoilerplate, workspaceSchema } from "@ensemble/shared-types";
import { declareModule } from "../lib/module-gate.js";
import { runtime } from "../lib/runtime.js";
import { requireHostAccess } from "../lib/hosted-access.js";
import { datasetErrorReply, plotExportErrorReply, plotRenderFailure } from "../runtime/plot-failure.js";
import { fetchHostedPlotRun, PLOT_QUEUE_LIMIT_MS, PLOT_RUN_LIMIT_MS } from "../runtime/plot-run.js";
import { useInProcessRuntime } from "../runtime/mode.js";
import { matplotlibSource } from "@ensemble/shared-types";
import { configOf, deleteDataset, ingestDataset, loadOwnedTable, ownedPlot, reparseSheet, updateDatasetColumns } from "../plots/service.js";

const limit = { bodyLimit: 34 * 1024 * 1024 };

function datasetPayload(error: unknown, empty = "Could not read that file."): { statusCode: number; body: { error: string; retry?: boolean } } {
  const failure = datasetErrorReply(error);
  const message = error instanceof Error ? failure.error : empty;
  const body = failure.retry === undefined ? { error: message } : { error: message, retry: failure.retry };
  return { statusCode: failure.statusCode, body };
}

function presentPlot(row: {
  id: string;
  title: string;
  datasetId: string | null;
  config: Prisma.JsonValue;
  code: string;
  createdAt: Date;
  updatedAt: Date;
  dataset?: { id: string; name: string } | null;
}) {
  return {
    id: row.id,
    title: row.title,
    datasetId: row.datasetId,
    datasetName: row.dataset?.name ?? null,
    config: isWorkspace(row.config) ? workspaceSchema.parse(row.config) : configOf(row.config),
    code: row.code,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function plotRoutes(app: FastifyInstance): Promise<void> {
  declareModule(app, "plots");
  const db = app.prisma;

  const workspaceRow = async (userId: string, id?: string) => {
    if (id) {
      const row = await ownedPlot(db, userId, id);
      if (!isWorkspace(row.config)) throw Object.assign(new Error("Plot space not found."), { statusCode: 404 });
      return row;
    }
    const rows = await db.plot.findMany({ where: { userId, deletedAt: null }, orderBy: { updatedAt: "desc" } });
    return rows.find((row) => isWorkspace(row.config)) ?? null;
  };

  const checkWorkspaceDatasets = async (userId: string, config: ReturnType<typeof workspaceSchema.parse>) => {
    const ids = [...new Set(config.datasetIds)];
    const count = await db.plotDataset.count({ where: { id: { in: ids }, userId, deletedAt: null } });
    if (count !== ids.length) throw Object.assign(new Error("A dataset in this plot space is not on your account."), { statusCode: 404 });
  };

  app.get("/api/plots/workspace", async (request) => {
    const { id } = z.object({ id: z.string().uuid().optional() }).parse(request.query);
    const existing = await workspaceRow(request.userId, id);
    if (existing) {
      const config = workspaceSchema.safeParse(existing.config);
      return { workspace: { id: existing.id, title: existing.title, config: config.success ? config.data : emptyWorkspace(), code: existing.code, updatedAt: existing.updatedAt.toISOString() } };
    }
    const row = await db.plot.create({
      data: { userId: request.userId, title: "Plots", config: emptyWorkspace() as unknown as Prisma.InputJsonValue },
    });
    return { workspace: { id: row.id, title: row.title, config: emptyWorkspace(), code: row.code, updatedAt: row.updatedAt.toISOString() } };
  });

  app.put("/api/plots/workspace", async (request, reply) => {
    const body = z.object({ id: z.string().uuid().optional(), config: workspaceSchema, code: z.string().max(100_000).optional(), title: z.string().max(200).optional() }).parse(request.body ?? {});
    await checkWorkspaceDatasets(request.userId, body.config);
    const existing = await workspaceRow(request.userId, body.id);
    const data = {
      config: body.config as unknown as Prisma.InputJsonValue,
      ...(body.code !== undefined ? { code: body.code } : {}),
      ...(body.title !== undefined ? { title: body.title.trim() || "Plots" } : {}),
    };
    const row = existing
      ? await db.plot.update({ where: { id: existing.id }, data })
      : await db.plot.create({ data: { userId: request.userId, title: data.title ?? "Plots", ...data } });
    return reply.send({ workspace: { id: row.id, title: row.title, config: body.config, code: row.code, updatedAt: row.updatedAt.toISOString() } });
  });

  app.get("/api/plots", async (request) => {
    const rows = await db.plot.findMany({
      where: { userId: request.userId, deletedAt: null },
      orderBy: { updatedAt: "desc" },
      take: 100,
      include: { dataset: { select: { id: true, name: true } } },
    });
    return { plots: rows.map(presentPlot) };
  });

  app.post("/api/plots", async (request, reply) => {
    const body = z.object({ title: z.string().max(200).optional(), datasetId: z.string().uuid().optional(), config: z.unknown().optional() }).parse(request.body ?? {});
    if (body.datasetId) {
      const dataset = await db.plotDataset.findFirst({ where: { id: body.datasetId, userId: request.userId, deletedAt: null } });
      if (!dataset) return reply.code(404).send({ error: "That dataset is not on your account." });
    }
    const config = isWorkspace(body.config)
      ? workspaceSchema.parse(body.config)
      : plotConfigSchema.parse({ ...defaultPlotConfig(), ...plotConfigSchema.partial().parse(body.config ?? {}) });
    if (isWorkspace(config)) await checkWorkspaceDatasets(request.userId, config);
    const row = await db.plot.create({
      data: { userId: request.userId, title: body.title?.trim() || "Untitled plot", datasetId: body.datasetId, config: config as unknown as Prisma.InputJsonValue },
      include: { dataset: { select: { id: true, name: true } } },
    });
    return reply.code(201).send({ plot: presentPlot(row) });
  });

  app.get("/api/plots/datasets", async (request) => {
    const rows = await db.plotDataset.findMany({
      where: { userId: request.userId, deletedAt: null },
      orderBy: { updatedAt: "desc" },
      take: 100,
      select: { id: true, name: true, format: true, columns: true, rowCount: true, sheet: true, sheets: true, updatedAt: true },
    });
    return { datasets: rows };
  });

  app.post("/api/plots/datasets", { ...limit }, async (request, reply) => {
    const body = z
      .object({
        name: z.string().max(200).optional(),
        filename: z.string().max(200).optional(),
        text: z.string().max(MAX_TEXT).optional(),
        url: z.string().max(2000).optional(),
        sheet: z.string().max(200).optional(),
        fileBase64: z.string().max(48_000_000).optional(),
        delimiter: z.string().max(4).optional(),
        columns: z.array(z.object({ name: z.string(), type: z.enum(["number", "date", "category", "text"]) })).max(64).optional(),
        rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))).max(200_000).optional(),
      })
      .parse(request.body ?? {});
    try {
      const dataset = await ingestDataset(db, request.userId, body);
      return reply.code(201).send({ dataset });
    } catch (error) {
      const failure = datasetPayload(error);
      return reply.code(failure.statusCode).send(failure.body);
    }
  });

  app.get("/api/plots/datasets/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const query = z.object({ rows: z.enum(["0", "1"]).optional(), preview: z.coerce.number().int().min(1).max(200).optional() }).parse(request.query);
    const row = await db.plotDataset.findFirst({ where: { id, userId: request.userId, deletedAt: null } });
    if (!row) return reply.code(404).send({ error: "That dataset is not on your account." });
    const table = (await loadOwnedTable(db, request.userId, id)).table;
    const take = query.rows === "1" ? table.rows.length : (query.preview ?? 80);
    return {
      dataset: {
        id: row.id,
        name: row.name,
        format: row.format,
        columns: table.columns,
        rowCount: row.rowCount,
        sheet: row.sheet,
        sheets: row.sheets,
        rows: table.rows.slice(0, take),
      },
    };
  });

  app.patch("/api/plots/datasets/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ columns: z.array(z.object({ name: z.string(), type: z.enum(["number", "date", "category", "text"]) })).min(1).max(64), name: z.string().max(200).optional() }).parse(request.body ?? {});
    await updateDatasetColumns(db, request.userId, id, body.columns, body.name);
    return { columns: body.columns };
  });

  app.post("/api/plots/datasets/:id/sheet", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ sheet: z.string().min(1).max(200) }).parse(request.body ?? {});
    try {
      return await reparseSheet(db, request.userId, id, body.sheet);
    } catch (error) {
      const failure = datasetPayload(error, "Could not read that sheet.");
      return reply.code(failure.statusCode).send(failure.body);
    }
  });

  app.delete("/api/plots/datasets/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    try {
      await deleteDataset(db, request.userId, id);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : "Not found." });
    }
    return reply.code(204).send();
  });

  app.get("/api/plots/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const row = await db.plot.findFirst({ where: { id, userId: request.userId, deletedAt: null }, include: { dataset: { select: { id: true, name: true } } } });
    if (!row) return reply.code(404).send({ error: "That plot is not on your account." });
    let spark: number[] = [];
    if (row.datasetId) {
      try {
        const loaded = await loadOwnedTable(db, request.userId, row.datasetId);
        const config = configOf(row.config);
        const series = buildSeries(loaded.table, config);
        spark = lttb(series[0]?.points ?? [], 48).map((point) => point.y ?? 0);
      } catch {
        spark = [];
      }
    }
    return { plot: presentPlot(row), spark };
  });

  app.patch("/api/plots/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        title: z.string().max(200).optional(),
        datasetId: z.string().uuid().nullable().optional(),
        config: z.unknown().optional(),
        code: z.string().max(100_000).optional(),
      })
      .parse(request.body ?? {});
    const current = await ownedPlot(db, request.userId, id);
    if (body.datasetId) {
      const dataset = await db.plotDataset.findFirst({ where: { id: body.datasetId, userId: request.userId, deletedAt: null } });
      if (!dataset) return reply.code(404).send({ error: "That dataset is not on your account." });
    }
    const parsed = body.config === undefined ? undefined : (isWorkspace(body.config) ? workspaceSchema.parse(body.config) : plotConfigSchema.parse(body.config));
    if (parsed && isWorkspace(parsed)) await checkWorkspaceDatasets(request.userId, parsed);
    const config = parsed as Prisma.InputJsonValue | undefined;
    const row = await db.plot.update({
      where: { id: current.id },
      data: {
        ...(body.title !== undefined ? { title: body.title.trim() || "Untitled plot" } : {}),
        ...(body.datasetId !== undefined ? { datasetId: body.datasetId } : {}),
        ...(config !== undefined ? { config } : {}),
        ...(body.code !== undefined ? { code: body.code } : {}),
      },
      include: { dataset: { select: { id: true, name: true } } },
    });
    return { plot: presentPlot(row) };
  });

  app.post("/api/plots/:id/duplicate", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const current = await ownedPlot(db, request.userId, id);
    const row = await db.plot.create({
      data: {
        userId: request.userId,
        title: `${current.title} copy`.slice(0, 200),
        datasetId: current.datasetId,
        config: current.config as Prisma.InputJsonValue,
        code: current.code,
      },
      include: { dataset: { select: { id: true, name: true } } },
    });
    return reply.code(201).send({ plot: presentPlot(row) });
  });

  app.delete("/api/plots/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const current = await ownedPlot(db, request.userId, id);
    await db.plot.update({ where: { id: current.id }, data: { deletedAt: new Date() } });
    return reply.code(204).send();
  });

  app.post("/api/plots/:id/export.csv", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const plot = await ownedPlot(db, request.userId, id);
    if (!plot.datasetId) return reply.code(400).send({ error: "This plot has no dataset." });
    const loaded = await loadOwnedTable(db, request.userId, plot.datasetId);
    const plotted = plottedRows(buildSeries(loaded.table, configOf(plot.config)));
    return { csv: tableToCsv(plotted.columns, plotted.rows), filename: `${plot.title.replace(/[^\w.-]+/g, "_") || "plot"}.csv` };
  });

  app.post("/api/plots/:id/matplotlib", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() }).parse(request.body ?? {});
    const plot = await ownedPlot(db, request.userId, id);
    const loaded = plot.datasetId ? await loadOwnedTable(db, request.userId, plot.datasetId) : null;
    const code = matplotlibSource({
      datasetName: loaded?.name ?? "data",
      columns: loaded?.table.columns ?? [],
      config: configOf(plot.config),
      accent: body.accent,
    });
    return { code };
  });

  app.post("/api/plots/:id/render", { ...limit }, async (request, reply) => {
    await requireHostAccess(request.userId, "Python plots");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({
      format: z.enum(["png", "svg", "pdf", "eps"]).default("pdf"),
      code: z.string().max(100_000).optional(),
      dpi: z.number().min(72).max(600).optional(),
      accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    }).parse(request.body ?? {});
    const plot = await ownedPlot(db, request.userId, id);
    const workspace = workspaceSchema.safeParse(plot.config);
    const datasets: Array<{ name: string; columns: string[]; rows: Array<Array<string | number | null>> }> = [];
    if (workspace.success) {
      const used = new Map<string, number>();
      for (const datasetId of workspace.data.datasetIds) {
        const loaded = await loadOwnedTable(db, request.userId, datasetId);
        const seen = used.get(loaded.name) ?? 0;
        used.set(loaded.name, seen + 1);
        const name = seen === 0 ? loaded.name : `${loaded.name} ${seen + 1}`;
        datasets.push({ name, columns: loaded.table.columns.map((column) => column.name), rows: loaded.table.rows });
      }
    } else if (plot.datasetId) {
      const loaded = await loadOwnedTable(db, request.userId, plot.datasetId);
      datasets.push({ name: loaded.name, columns: loaded.table.columns.map((column) => column.name), rows: loaded.table.rows });
    }
    if (!datasets.length) return reply.code(400).send({ error: "This plot has no dataset." });
    const code = body.code ?? (plot.code || (workspace.success
      ? workspaceBoilerplate(datasets.map((dataset) => dataset.name))
      : matplotlibSource({ datasetName: datasets[0]!.name, columns: datasets[0]!.columns.map((name) => ({ name, type: "number" as const })), config: configOf(plot.config), accent: body.accent })));
    try {
      const json = { userId: request.userId, code, datasets, format: body.format, dpi: body.dpi };
      // In process, the worker client starts its clock on `started`. The abort
      // here only covers the whole wait, so it has to include the queue.
      const result = (useInProcessRuntime()
        ? await runtime("/api/plots/run", { method: "POST", timeoutMs: PLOT_QUEUE_LIMIT_MS + PLOT_RUN_LIMIT_MS, json })
        : await fetchHostedPlotRun(json)) as {
        png?: string;
        svg?: string;
        pdf?: string;
        eps?: string;
        stdout: string;
        stderr: string;
        error?: string;
        line?: number;
        retry?: boolean;
      };
      if (result.error) {
        const failure = plotExportErrorReply(result.error, result.retry);
        if (failure.statusCode === 503) return reply.code(503).send({ error: failure.error, retry: true });
        return reply.code(400).send({ error: result.error, line: result.line, stderr: result.stderr, stdout: result.stdout });
      }
      const file = result[body.format];
      if (!file) return reply.code(400).send({ error: "The script finished without a figure. Call save() or plt.show().", stderr: result.stderr });
      return { format: body.format, data: file, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      return reply.code(503).send(plotRenderFailure(error));
    }
  });
}

const MAX_TEXT = 12_000_000;
