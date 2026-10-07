"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import { chartFrame, isWorkspace, plotConfigSchema, workspaceSchema, type Frame, type PlotConfig } from "@ensemble/shared-types";
import { ApiError, api } from "@/lib/api";
import { MODULE_DENIED } from "@ensemble/shared-types/modules";
import { ChartView } from "./chart-view";

export function mountPlotOff(host: HTMLElement, label: string): void {
  host.replaceChildren();
  host.className = "mention mention-off";
  host.setAttribute("aria-disabled", "true");
  host.title = "Plots are not part of your template. The plot is still in your account.";
  host.textContent = `@${label || "Plot"} · not part of your template`;
}

export function inlinePlotRatio(chart: string, tile?: { w: number; h: number }): number {
  if (tile) return Math.min(3, Math.max(0.5, (tile.w * 80) / (tile.h * 78)));
  return ["heatmap", "pie", "donut"].includes(chart) ? 1 : 1.6;
}

type Figure = { id: string; title: string; frame: Frame; config: PlotConfig; ratio: number; warnings: string[] };

function InlinePlot({ id, label, onRemove }: { id: string; label: string; onRemove?: () => void }) {
  const [title, setTitle] = useState(label || "Plot");
  const [href, setHref] = useState(`/plots/${id.split("/")[0]}`);
  const [compact, setCompact] = useState(false);
  const [figures, setFigures] = useState<Figure[] | null>(null);
  const [error, setError] = useState("");
  const [off, setOff] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [plotId, encodedTile] = id.split("/");
      const { plot } = await api.plot(plotId!);
      if (cancelled) return;
      const tileId = encodedTile ? decodeURIComponent(encodedTile) : null;
      let next: Figure[];
      if (isWorkspace(plot.config)) {
        const config = workspaceSchema.parse(plot.config);
        const datasets = await Promise.all(config.datasetIds.map(async (datasetId) => (await api.plotDataset(datasetId, true)).dataset));
        const tiles = tileId ? config.tiles.filter((tile) => tile.id === tileId) : config.tiles;
        if (tileId && !tiles.length) throw new Error("This tile was removed from its plot space.");
        next = tiles.map((tile) => {
          const view = chartFrame(datasets, tile, config.links);
          view.config.series = view.config.series.map((series, index) => ({
            ...series,
            color: tile.series[index]?.color ?? series.color,
            lineStyle: tile.series[index]?.lineStyle ?? series.lineStyle,
          }));
          return { id: tile.id, title: tile.title, ...view, ratio: inlinePlotRatio(tile.chart, tile) };
        });
        if (cancelled) return;
        setTitle(tileId ? tiles[0]!.title || label : plot.title);
        setHref(`/plots?space=${plot.id}${encodedTile ? `&tile=${encodedTile}` : ""}`);
      } else {
        const config = plotConfigSchema.parse(plot.config);
        if (!plot.datasetId) next = [];
        else {
          const { dataset } = await api.plotDataset(plot.datasetId, true);
          next = [{ id: plot.id, title: plot.title, frame: { columns: dataset.columns, rows: dataset.rows }, config, ratio: inlinePlotRatio(config.chart), warnings: [] }];
        }
        if (cancelled) return;
        setTitle(plot.title || label || "Plot");
      }
      setFigures(next);
    };
    void load().catch((failure: unknown) => {
      if (cancelled) return;
      if (failure instanceof ApiError && failure.status === 404 && failure.message === MODULE_DENIED) setOff(true);
      else setError(failure instanceof Error ? failure.message : "Could not load this plot.");
    });
    return () => { cancelled = true; };
  }, [id, label]);

  if (off) return <span className="mention mention-off" aria-disabled="true">@{label || "Plot"} · not part of your template</span>;
  return (
    <div className="plot-inline" contentEditable={false}>
      <div className="diagram-inline-head">
        <span className="diagram-inline-title min-w-0 flex-1 truncate">{title}</span>
        <a href={href} className="diagram-inline-edit">Open</a>
        <button type="button" className="icon-btn" aria-label={compact ? "Expand plot" : "Compact plot"} aria-expanded={!compact} onClick={() => setCompact((value) => !value)}>
          {compact ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
        {onRemove ? <button type="button" className="icon-btn" aria-label="Remove plot from page" title="Remove from page" onClick={onRemove}><Trash2 size={14} /></button> : null}
      </div>
      {!compact ? (
        <div className="space-y-3 p-2">
          {error ? <p role="alert" className="text-[13px] text-danger">{error}</p> : figures === null ? <p className="p-3 text-[13px] text-muted">Loading plot…</p> : !figures.length ? <p className="p-3 text-[13px] text-muted">No chart yet. Open this plot to add data and choose columns.</p> : figures.map((figure) => (
            <div key={figure.id}>
              {figures.length > 1 ? <p className="mb-1 text-[12px] text-muted">{figure.title}</p> : null}
              <div className="relative w-full" style={{ aspectRatio: figure.ratio }}>
                <ChartView frame={figure.frame} config={figure.config} variant="tile" />
              </div>
              {figure.warnings.map((warning) => <p key={warning} className="text-[12px] text-warn">{warning}</p>)}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function mountPlotCard(host: HTMLElement, id: string, label: string, onRemove?: () => void): () => void {
  host.replaceChildren();
  host.className = "plot-mention";
  host.contentEditable = "false";
  const root = createRoot(host);
  root.render(<InlinePlot id={id} label={label} onRemove={onRemove} />);
  return () => queueMicrotask(() => root.unmount());
}
