"use client";

import { chartFrame, isWorkspace, plotConfigSchema, workspaceSchema, type Frame, type PlotConfig } from "@ensemble/shared-types";
import { api } from "@/lib/api";

/** One chart of a saved plot, or one tile of a plot space, ready to draw. */
export type PlotFigure = { id: string; title: string; frame: Frame; config: PlotConfig; ratio: number; warnings: string[] };

export function inlinePlotRatio(chart: string, tile?: { w: number; h: number }): number {
  if (tile) return Math.min(3, Math.max(0.5, (tile.w * 80) / (tile.h * 78)));
  return ["heatmap", "pie", "donut"].includes(chart) ? 1 : 1.6;
}

/**
 * The charts a plot mention shows: `plotId` for a saved plot, `spaceId/tileId` for one tile of a
 * plot space, or a space id for all its tiles. Used by page cards and by page exports.
 */
export async function loadPlotFigures(id: string, label = ""): Promise<{ title: string; href: string; figures: PlotFigure[] }> {
  const [plotId, encodedTile] = id.split("/");
  const { plot } = await api.plot(plotId!);
  const tileId = encodedTile ? decodeURIComponent(encodedTile) : null;
  if (isWorkspace(plot.config)) {
    const config = workspaceSchema.parse(plot.config);
    const datasets = await Promise.all(config.datasetIds.map(async (datasetId) => (await api.plotDataset(datasetId, true)).dataset));
    const tiles = tileId ? config.tiles.filter((tile) => tile.id === tileId) : config.tiles;
    if (tileId && !tiles.length) throw new Error("This tile was removed from its plot space.");
    const figures = tiles.map((tile) => {
      const view = chartFrame(datasets, tile, config.links);
      view.config.series = view.config.series.map((series, index) => ({
        ...series,
        color: tile.series[index]?.color ?? series.color,
        lineStyle: tile.series[index]?.lineStyle ?? series.lineStyle,
      }));
      return { id: tile.id, title: tile.title, ...view, ratio: inlinePlotRatio(tile.chart, tile) };
    });
    return {
      title: tileId ? tiles[0]!.title || label : plot.title,
      href: `/plots?space=${plot.id}${encodedTile ? `&tile=${encodedTile}` : ""}`,
      figures,
    };
  }
  const config = plotConfigSchema.parse(plot.config);
  const figures: PlotFigure[] = [];
  if (plot.datasetId) {
    const { dataset } = await api.plotDataset(plot.datasetId, true);
    figures.push({ id: plot.id, title: plot.title, frame: { columns: dataset.columns, rows: dataset.rows }, config, ratio: inlinePlotRatio(config.chart), warnings: [] });
  }
  return { title: plot.title || label || "Plot", href: `/plots/${plot.id}`, figures };
}
