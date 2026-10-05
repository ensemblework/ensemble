"use client";

import { useEffect, useMemo, useState } from "react";
import { chartFrame, matplotlibPanels, type LinkChoice, type PoolDataset, type WorkspaceTile } from "@ensemble/shared-types";
import { PlotDialog } from "@/components/plots/plot-dialog";
import { Toggle } from "@/components/ui";
import { api } from "@/lib/api";
import { usePlotTheme } from "@/lib/plots/theme";
import { figureBytes } from "@/lib/plots/figure-file";
import { useToast } from "@/components/toast";

export function ExportDialog({
  open,
  workspaceId,
  tiles,
  datasets,
  links,
  onClose,
}: {
  open: boolean;
  workspaceId: string | null;
  tiles: WorkspaceTile[];
  datasets: PoolDataset[];
  links: Record<string, LinkChoice>;
  onClose: () => void;
}) {
  const toast = useToast();
  const theme = usePlotTheme();
  const [order, setOrder] = useState<string[]>([]);
  const [widthIn, setWidthIn] = useState(7);
  const [heightIn, setHeightIn] = useState(4.2);
  const [dpi, setDpi] = useState(150);
  const [fontSize, setFontSize] = useState(9);
  const [columns, setColumns] = useState(2);
  const [legend, setLegend] = useState(true);
  const [preview, setPreview] = useState<string | null>(null);
  const [errorText, setErrorText] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setOrder(tiles.map((tile) => tile.id));
    const rows = Math.ceil(Math.max(tiles.length, 1) / 2);
    setHeightIn(Number(Math.min(12, Math.max(4.2, rows * 2.8)).toFixed(1)));
  }, [open, tiles]);

  const panels = useMemo(() => {
    const byId = new Map(tiles.map((tile) => [tile.id, tile]));
    return order.flatMap((id) => {
      const tile = byId.get(id);
      if (!tile) return [];
      const view = chartFrame(datasets, tile, links);
      if (!view.config.x || !view.config.series.length) return [];
      const drawn = view.config.series[0];
      return [{
        id,
        title: tile.title || "",
        datasetName: datasets[0]?.name ?? "data",
        x: view.config.x ?? "",
        ys: view.config.series.map((series) => series.y),
        yTitle: view.config.yTitleLeft || view.config.series[0]?.y || "",
        chart: tile.chart,
        palette: view.config.palette,
        xLog: tile.xLog,
        yLog: tile.yLogLeft,
        boxNotch: view.config.boxNotch,
        boxOutliers: view.config.boxOutliers,
        boxWhisker: view.config.boxWhisker,
        columns: view.frame.columns.map((column) => column.name),
        rows: view.frame.rows,
        error: drawn?.error,
        errorKind: drawn?.errorKind,
        series: view.config.series.map((series) => ({ y: series.y, color: series.color, error: series.error, errorKind: series.errorKind })),
      }];
    });
  }, [order, tiles, datasets, links]);

  const code = useMemo(
    () => matplotlibPanels(panels, { widthIn, heightIn, dpi, fontSize, columns, legend, accent: theme.accent, dark: theme.dark }),
    [panels, widthIn, heightIn, dpi, fontSize, columns, legend, theme.accent, theme.dark],
  );

  useEffect(() => {
    if (!open || !workspaceId || !panels.length) return;
    let live = true;
    setErrorText("");
    const timer = window.setTimeout(() => {
      void api.renderPlot(workspaceId, { format: "png", code }).then((result) => {
        if (!live) return;
        setPreview(`data:image/png;base64,${result.data}`);
        setErrorText("");
      }).catch((error: unknown) => {
        if (!live) return;
        setPreview(null);
        setErrorText(error instanceof Error ? error.message : "The preview did not render.");
      });
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [open, workspaceId, code, panels.length, attempt]);

  const download = async (format: "pdf" | "svg" | "png" | "eps") => {
    if (!workspaceId) return;
    setBusy(true);
    try {
      const result = await api.renderPlot(workspaceId, { format, code });
      const blob = figureBytes(format, result.data);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `figure.${format}`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast(error instanceof Error ? error.message : "The figure did not render.", { tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const move = (id: string, direction: -1 | 1) => {
    setOrder((current) => {
      const index = current.indexOf(id);
      const next = index + direction;
      if (index < 0 || next < 0 || next >= current.length) return current;
      const copy = [...current];
      const [item] = copy.splice(index, 1);
      copy.splice(next, 0, item!);
      return copy;
    });
  };

  return (
    <PlotDialog open={open} onClose={onClose} title="Export figure" width={920}>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_240px]" data-export-dialog>
        <div className="overflow-hidden rounded-lg border border-line" style={{ background: "var(--raised)" }} data-export-preview>
          {preview ? <img src={preview} alt="Multi-panel figure preview" className="mx-auto block max-h-[520px] max-w-full" /> : errorText ? (
            <div className="max-w-sm px-4 py-8 text-center">
              <p className="text-[13px] text-danger">{errorText}</p>
              <button type="button" className="btn mt-3" onClick={() => setAttempt((value) => value + 1)}>Retry</button>
            </div>
          ) : <p className="px-4 py-8 text-center text-[13px] text-muted">{panels.length ? "Rendering the preview…" : "Add a tile with columns first."}</p>}
        </div>
        <div className="space-y-3 text-[13px]">
          <p className="text-[12px] text-muted">Matplotlib export. Size is in inches.</p>
          <label className="block text-[12px] text-muted">Width (in)
            <input type="number" min={1} max={12} step={0.1} className="field mt-1 w-full" aria-label="Figure width inches" value={widthIn} onChange={(event) => setWidthIn(Number(event.target.value))} />
          </label>
          <label className="block text-[12px] text-muted">Height (in)
            <input type="number" min={1} max={12} step={0.1} className="field mt-1 w-full" aria-label="Figure height inches" value={heightIn} onChange={(event) => setHeightIn(Number(event.target.value))} />
          </label>
          <label className="block text-[12px] text-muted">DPI
            <input type="number" min={72} max={600} className="field mt-1 w-full" aria-label="Figure DPI" value={dpi} onChange={(event) => setDpi(Number(event.target.value))} />
          </label>
          <label className="block text-[12px] text-muted">Font size
            <input type="number" min={8} max={18} className="field mt-1 w-full" aria-label="Figure font size" value={fontSize} onChange={(event) => setFontSize(Number(event.target.value))} />
          </label>
          <div>
            <div className="mb-1 text-[12px] text-muted">Panels per row</div>
            <div className="flex gap-1">
              {[1, 2, 3].map((count) => (
                <button key={count} type="button" className={`rounded-md px-2 py-1 ${columns === count ? "bg-accent-soft" : "text-muted"}`} onClick={() => setColumns(count)}>{count}</button>
              ))}
            </div>
          </div>
          <span className="flex items-center gap-2"><Toggle checked={legend} label="Shared legend" onChange={setLegend} /> Shared legend</span>
          <div>
            <div className="mb-1 text-[12px] text-muted">Panel order</div>
            <ol className="space-y-1">
              {order.map((id) => {
                const tile = tiles.find((item) => item.id === id);
                return (
                  <li key={id} className="flex items-center gap-1">
                    <span className="min-w-0 flex-1 truncate">{tile?.title || "Tile"}</span>
                    <button type="button" className="btn px-2 py-0.5 text-[12px]" onClick={() => move(id, -1)} aria-label={`Move ${tile?.title || "tile"} up`}>Up</button>
                    <button type="button" className="btn px-2 py-0.5 text-[12px]" onClick={() => move(id, 1)} aria-label={`Move ${tile?.title || "tile"} down`}>Down</button>
                  </li>
                );
              })}
            </ol>
          </div>
          <div className="flex flex-wrap gap-1">
            {(["pdf", "svg", "png", "eps"] as const).map((format) => (
              <button key={format} type="button" className="btn-primary" disabled={busy || !panels.length} data-export-format={format} onClick={() => void download(format)}>{format.toUpperCase()}</button>
            ))}
          </div>
        </div>
      </div>
    </PlotDialog>
  );
}
