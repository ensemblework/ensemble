"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { matplotlibSource, parseRef, seedSummaryFor, tileSchema, type Frame, type PlotConfig, type PoolColumn, type WorkspaceTile } from "@ensemble/shared-types";
import { ChartView } from "@/components/plots/chart-view";
import { figureBytes } from "@/lib/plots/figure-file";
import { ColumnSelect } from "@/components/plots/column-select";
import { StyleTab } from "@/components/plots/studio";
import { Toggle } from "@/components/ui";
import { api } from "@/lib/api";
import { usePlotTheme } from "@/lib/plots/theme";
import { useToast } from "@/components/toast";

const Code = dynamic(() => import("./code-pane").then((mod) => mod.PlotCodePane), { ssr: false });

const TABS = ["Encode", "Style", "Code", "Export"] as const;
const PANEL_KEY = "ensemble.plots.sidePanel";
const PANEL_MIN = 280;
const PANEL_MAX = 560;

function readPanelWidth(): number {
  if (typeof window === "undefined") return 340;
  const raw = window.localStorage.getItem(PANEL_KEY);
  // Number(null) is 0, which would clamp a first-time user to the narrowest panel.
  const stored = raw === null || raw === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(stored)) return 340;
  return Math.min(PANEL_MAX, Math.max(PANEL_MIN, stored));
}

export function FocusEditor({
  tile,
  columns,
  frame,
  config,
  warnings = [],
  code: _code,
  workspaceId,
  datasetName,
  onChange,
  onCode,
  onClose,
}: {
  tile: WorkspaceTile;
  columns: PoolColumn[];
  frame: Frame;
  config: PlotConfig;
  warnings?: string[];
  code: string;
  workspaceId: string | null;
  datasetName: string;
  onChange: (tile: WorkspaceTile) => void;
  onCode: (code: string) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [tab, setTab] = useState<(typeof TABS)[number]>("Encode");
  const [closing, setClosing] = useState(false);
  const [panelWidth, setPanelWidth] = useState(readPanelWidth);
  const [fullScreen, setFullScreen] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector("[data-popover]")) return;
      if (fullScreen) {
        event.preventDefault();
        setFullScreen(false);
        return;
      }
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) onClose();
      else setClosing(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullScreen, onClose]);

  const theme = usePlotTheme();
  const generated = useMemo(() => {
    const typed = [
      ...(config.x ? [{ name: config.x, type: (columns.find((column) => column.name === config.x)?.type ?? "number") as "number" | "category" | "date" | "text" }] : []),
      ...config.series.map((series) => ({
        name: series.y,
        type: (columns.find((column) => column.name === series.y)?.type ?? "number") as "number" | "category" | "date" | "text",
      })),
    ];
    const yPart = tile.yRefs[0] ? parseRef(tile.yRefs[0]) : null;
    const summary = tile.seedRef && yPart
      ? seedSummaryFor({
          columns: columns.filter((column) => !yPart.datasetId || column.datasetId === yPart.datasetId),
          x: config.x,
          y: yPart.name,
          seed: parseRef(tile.seedRef).name,
          series: config.series,
        })
      : null;
    return matplotlibSource({
      datasetName,
      columns: typed,
      config,
      accent: theme.accent,
      dark: theme.dark,
      rows: frame.rows,
      rowColumns: frame.columns.map((column) => column.name),
      summary,
    });
  }, [columns, config, datasetName, frame.columns, frame.rows, theme.accent, theme.dark, tile.seedRef, tile.yRefs]);

  const apply = (patch: Partial<PlotConfig>) => {
    const series = patch.series
      ? patch.series.map((series, index) => ({ ...tile.series[index], ...series }))
      : tile.series;
    onChange(tileSchema.parse({ ...tile, ...patch, series }));
  };

  const close = () => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      onClose();
      return;
    }
    setClosing(true);
  };

  return (
    <div className={`plot-focus fixed inset-0 z-[80] flex p-3 ${closing ? "is-closing" : ""}`} data-plot-focus onAnimationEnd={(event) => { if (closing && event.animationName === "plot-focus-out") onClose(); }}>
      <button type="button" className="plot-focus-veil absolute inset-0 border-0" aria-label="Close editor" onClick={close} />
      <div className="plot-focus-panel relative flex min-h-0 flex-1 overflow-hidden rounded-xl border border-line shadow-pop" style={{ background: "var(--panel)" }}>
        <div className={`min-w-0 flex-1 flex-col ${fullScreen ? "hidden" : "flex"}`}>
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <button type="button" className="btn" onClick={close}>Back</button>
            <span className="min-w-0 truncate text-[14px] font-medium">{tile.title || "Tile"}</span>
          </div>
          <div className="relative min-h-0 flex-1">
            <ChartView frame={frame} config={config} variant="focus" />
          </div>
        </div>
        <aside
          className={`flex flex-col ${fullScreen ? "min-w-0 flex-1" : "relative shrink-0 border-l border-line"}`}
          style={fullScreen ? { background: "var(--panel)" } : { width: panelWidth }}
          data-plot-panel
          data-panel-width={panelWidth}
        >
          {fullScreen ? null : (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Panel width"
              aria-valuemin={PANEL_MIN}
              aria-valuemax={PANEL_MAX}
              aria-valuenow={panelWidth}
              data-plot-panel-resize
              className="absolute inset-y-0 left-0 z-10 w-2 cursor-col-resize"
              onPointerDown={(event) => {
                event.preventDefault();
                const startX = event.clientX;
                const start = panelWidth;
                const move = (ev: PointerEvent) => {
                  const next = Math.min(PANEL_MAX, Math.max(PANEL_MIN, start + (startX - ev.clientX)));
                  setPanelWidth(next);
                };
                const up = (ev: PointerEvent) => {
                  const next = Math.min(PANEL_MAX, Math.max(PANEL_MIN, start + (startX - ev.clientX)));
                  setPanelWidth(next);
                  window.localStorage.setItem(PANEL_KEY, String(next));
                  window.removeEventListener("pointermove", move);
                  window.removeEventListener("pointerup", up);
                };
                window.addEventListener("pointermove", move);
                window.addEventListener("pointerup", up);
              }}
            />
          )}
          <div className="flex h-11 flex-nowrap items-center gap-2 overflow-hidden border-b border-line px-2" data-plot-tabs>
            {fullScreen ? (
              <button type="button" className="btn shrink-0" data-plot-back onClick={close}>Back</button>
            ) : null}
            {fullScreen ? <span className="min-w-0 max-w-[16rem] shrink truncate text-[14px] font-medium" data-plot-focus-title="">{tile.title || "Tile"}</span> : null}
            <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-0.5 overflow-hidden">
              {TABS.map((name) => (
                <button key={name} type="button" role="tab" aria-selected={tab === name} className={`shrink-0 whitespace-nowrap rounded-md px-1.5 py-1 text-[12px] ${tab === name ? "bg-accent-soft" : "text-muted"}`} onClick={() => setTab(name)}>{name}</button>
              ))}
            </div>
            <button
              type="button"
              className={`btn ml-auto shrink-0 whitespace-nowrap ${fullScreen ? "px-2 py-0.5 text-[12px]" : "grid h-7 w-7 place-items-center p-0"}`}
              data-plot-fullscreen={fullScreen ? "1" : "0"}
              aria-label={fullScreen ? "Exit full screen" : "Full screen"}
              title={fullScreen ? "Exit full screen" : "Full screen"}
              onClick={() => setFullScreen((value) => !value)}
            >
              {fullScreen ? "Exit full screen" : (
                <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden>
                  <path d="M3 6.5V3h3.5M10 3h3v3.5M13 10v3H9.5M6.5 13H3v-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          </div>
          <div className={`min-h-0 flex-1 ${tab === "Code" ? "flex flex-col overflow-hidden p-3" : "overflow-auto p-3"}`}>
            {tab === "Encode" ? <Encode columns={columns} tile={tile} warnings={warnings} onChange={onChange} /> : null}
            {tab === "Style" ? <StyleTab config={config} update={apply} /> : null}
            {tab === "Code" ? (
              <div className="flex min-h-0 flex-1 flex-col" data-plot-code>
                <Code value={generated} onChange={onCode} />
              </div>
            ) : null}
            {tab === "Export" ? <TileExport workspaceId={workspaceId} code={generated} toast={toast} /> : null}
          </div>
        </aside>
      </div>
      <style>{`
        .plot-focus-veil { background: rgb(var(--bg-rgb) / 0.55); animation: plot-veil 180ms linear; }
        .plot-focus-panel { animation: plot-focus-in 240ms cubic-bezier(0.2, 0.8, 0.2, 1); }
        .plot-focus.is-closing .plot-focus-veil { animation: plot-veil 160ms linear reverse forwards; }
        .plot-focus.is-closing .plot-focus-panel { animation: plot-focus-out 180ms cubic-bezier(0.4, 0, 0.2, 1) forwards; }
        @keyframes plot-veil { from { opacity: 0; } to { opacity: 1; } }
        @keyframes plot-focus-in { from { transform: scale(0.94); } to { transform: none; } }
        @keyframes plot-focus-out { from { transform: none; } to { transform: scale(0.96); } }
        @media (prefers-reduced-motion: reduce) {
          .plot-focus-veil, .plot-focus-panel, .plot-focus.is-closing .plot-focus-veil, .plot-focus.is-closing .plot-focus-panel { animation: none; }
        }
      `}</style>
    </div>
  );
}

function Encode({ columns, tile, warnings, onChange }: { columns: PoolColumn[]; tile: WorkspaceTile; warnings: string[]; onChange: (tile: WorkspaceTile) => void }) {
  const set = (patch: Partial<WorkspaceTile>) => onChange(tileSchema.parse({ ...tile, ...patch }));
  const setY = (ids: string[]) => {
    const series = ids.map((ref) => {
      const previous = tile.series[tile.yRefs.indexOf(ref)];
      const column = columns.find((item) => item.id === ref);
      return previous ?? { y: column?.name ?? "y", axis: "left" as const };
    });
    set({ yRefs: ids, series });
  };
  return (
    <div className="space-y-3 text-[13px]" data-plot-encode>
      <p className="text-[12px] text-muted">Pick the columns to draw. A series that cannot sit on this axis is left off the chart.</p>
      <ColumnSelect label="X axis" columns={columns} selected={tile.xRef ? [tile.xRef] : []} multiple={false} onChange={(ids) => set({ xRef: ids[0] ?? null })} />
      <ColumnSelect
        label="Y series"
        columns={columns}
        selected={tile.yRefs}
        multiple
        onChange={setY}
        axisOf={(id) => tile.series[tile.yRefs.indexOf(id)]?.axis ?? "left"}
        onAxis={(id, axis) => {
          const index = tile.yRefs.indexOf(id);
          if (index < 0) return;
          set({ series: tile.series.map((series, seriesIndex) => seriesIndex === index ? { ...series, axis } : series) });
        }}
      />
      <div className="flex flex-wrap gap-3 text-[12px]" data-log-axes>
        <span className="flex items-center gap-2"><Toggle checked={tile.xLog} label="Log X" onChange={(value) => set({ xLog: value })} /> Log X</span>
        <span className="flex items-center gap-2"><Toggle checked={tile.yLogLeft} label="Log left" onChange={(value) => set({ yLogLeft: value })} /> Log left</span>
        <span className="flex items-center gap-2"><Toggle checked={tile.yLogRight} label="Log right" onChange={(value) => set({ yLogRight: value })} /> Log right</span>
      </div>
      <ul className="space-y-1 text-[11px] leading-4 text-warn" data-plot-warning>
        {warnings.map((warning) => <li key={warning}>{warning}</li>)}
      </ul>
    </div>
  );
}

function TileExport({ workspaceId, code, toast }: { workspaceId: string | null; code: string; toast: (text: string, opts?: { tone?: "error" }) => void }) {
  const run = async (format: "png" | "svg" | "pdf" | "eps") => {
    if (!workspaceId) return;
    try {
      const result = await api.renderPlot(workspaceId, { format, code });
      const blob = figureBytes(format, result.data);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `tile.${format}`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Export failed.", { tone: "error" });
    }
  };
  return (
    <div className="space-y-2" data-plot-export>
      <p className="text-[12px] text-muted">Download this tile. Export figure on the canvas saves every tile in one file.</p>
      <div className="flex flex-wrap gap-1">
        {(["png", "svg", "pdf", "eps"] as const).map((format) => (
          <button key={format} type="button" className="btn" onClick={() => void run(format)}>{format.toUpperCase()}</button>
        ))}
      </div>
    </div>
  );
}
