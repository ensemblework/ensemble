"use client";

import dynamic from "next/dynamic";
import { useMemo, useRef, useId, useState } from "react";
import { tileSchema, type Frame, type LinkChoice, type PlotConfig, type PoolColumn, type PoolDataset, type WorkspaceTile } from "@ensemble/shared-types";
import { ChartView } from "@/components/plots/chart-view";
import { FigureOutput, RunButton, useFigureRun } from "@/components/plots/figure-run";
import { figureBytes } from "@/lib/plots/figure-file";
import { ColumnSelect } from "@/components/plots/column-select";
import { StyleTab } from "@/components/plots/studio";
import { useModalFocus } from "@/lib/modal-focus";
import { ModalScope, Toggle } from "@/components/ui";
import { renderPlot } from "@/lib/plots/render";
import { storedTileCode, tileScript, tileSource } from "@/lib/plots/tile-code";
import { usePlotTheme } from "@/lib/plots/theme";
import { useToast } from "@/components/toast";
import { Download, X } from "lucide-react";
import { SplitHandle, useSplit } from "@/components/plots/split";

const Code = dynamic(() => import("./code-pane").then((mod) => mod.PlotCodePane), { ssr: false });

const TABS = ["Encode", "Style", "Code", "Export"] as const;
const PANEL_KEY = "ensemble.plots.sidePanelShare";

export function FocusEditor({
  tile,
  columns,
  frame,
  config,
  warnings = [],
  datasets,
  links,
  workspaceId,
  onChange,
  onClose,
}: {
  tile: WorkspaceTile;
  columns: PoolColumn[];
  frame: Frame;
  config: PlotConfig;
  warnings?: string[];
  datasets: PoolDataset[];
  links: Record<string, LinkChoice>;
  workspaceId: string | null;
  onChange: (tile: WorkspaceTile) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const ref = useRef<HTMLDivElement>(null);
  const modalId = useId();
  const [tab, setTab] = useState<(typeof TABS)[number]>("Encode");
  const [closing, setClosing] = useState(false);
  const panelRow = useRef<HTMLDivElement>(null);
  const [panelShare, setPanelShare, panelDefault] = useSplit(PANEL_KEY, 0.32);

  const theme = usePlotTheme();
  // Typing in the Code tab changes only `tile.code`, which does not change the generated script.
  const settings = JSON.stringify({ ...tile, code: null });
  const generated = useMemo(
    () => tileSource(JSON.parse(settings) as WorkspaceTile, { datasets, links, accent: theme.accent, dark: theme.dark }),
    [settings, datasets, links, theme.accent, theme.dark],
  );
  const script = tileScript(tile, generated);
  const figure = useFigureRun(workspaceId);
  const [preview, setPreview] = useState<"chart" | "output">("output");
  const showOutput = tab === "Code" && preview === "output";
  const runCode = () => {
    setPreview("output");
    void figure.run(script.code);
  };
  const editCode = (value: string) => {
    if (value.length > 40_000) {
      toast("A tile's code can be up to 40,000 characters. Use the canvas Code view for a longer script.", { tone: "error" });
      return;
    }
    onChange(tileSchema.parse({ ...tile, code: storedTileCode(value, generated) }));
  };

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

  useModalFocus(ref, true, close);
  return (
    <ModalScope.Provider value={modalId}>
    <div ref={ref} data-modal-layer={modalId} role="dialog" aria-modal="true" aria-label={`Edit ${tile.title || "chart"}`} tabIndex={-1} className={`plot-focus fixed inset-0 z-[80] flex p-3 ${closing ? "is-closing" : ""}`} data-plot-focus onAnimationEnd={(event) => { if (closing && event.animationName === "plot-focus-out") onClose(); }}>
      <button type="button" className="plot-focus-veil absolute inset-0 border-0" aria-label="Close editor" onClick={close} />
      <div ref={panelRow} className="plot-focus-panel relative flex min-h-0 flex-1 overflow-hidden">
        <div className="plot-focus-preview flex min-w-0 flex-1 flex-col">
          <div className="pl-focus-head">
            <span className="min-w-0 flex-1 truncate pl-1 text-[14px] font-semibold" data-plot-focus-title="">{tile.title || "Tile"}</span>
            {tab === "Code" ? (
              <div className="pl-seg" role="radiogroup" aria-label="Preview">
                {([["output", "Code output"], ["chart", "Chart"]] as const).map(([value, label]) => (
                  <button key={value} type="button" role="radio" aria-checked={preview === value} className="pl-seg-btn" onClick={() => setPreview(value)}>{label}</button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="relative min-h-0 flex-1">
            {showOutput ? (
              <div className="absolute inset-0 p-3" data-plot-code-preview>
                <FigureOutput state={figure.state} placeholder="Run the code to draw its figure here." />
              </div>
            ) : (
              <ChartView frame={frame} config={config} variant="focus" />
            )}
          </div>
        </div>
        <aside
          className="relative flex shrink-0 flex-col border-l border-line"
          style={{ width: `${panelShare * 100}%`, minWidth: "min(280px, 60%)" }}
          data-plot-panel
          data-panel-share={Math.round(panelShare * 100)}
        >
          <SplitHandle container={panelRow} value={panelShare} fallback={panelDefault} side="right" label="Panel width" onChange={setPanelShare} className="pl-split-edge" />
          <div className="pl-focus-head pl-focus-tabs" data-plot-tabs>
            <div role="tablist" aria-label="Chart settings" className="pl-tabs">
              {TABS.map((name) => (
                <button key={name} type="button" role="tab" aria-selected={tab === name} aria-controls={`${modalId}-panel`} tabIndex={tab === name ? 0 : -1} onKeyDown={(event) => {
                  const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
                  if (!direction && event.key !== "Home" && event.key !== "End") return;
                  event.preventDefault();
                  const next = event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : (TABS.indexOf(name) + direction + TABS.length) % TABS.length;
                  setTab(TABS[next]!);
                  event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
                }} className="pl-tab" onClick={() => setTab(name)}>{name}</button>
              ))}
            </div>
            <button type="button" className="pl-icon-btn ml-auto" data-plot-close aria-label="Close" title="Close (Esc)" onClick={close}>
              <X size={16} aria-hidden />
            </button>
          </div>
          <div id={`${modalId}-panel`} role="tabpanel" aria-label={tab} className={`min-h-0 flex-1 ${tab === "Code" ? "flex flex-col overflow-hidden p-3" : "overflow-auto p-3"}`}>
            {script.edited && (tab === "Encode" || tab === "Style") ? (
              <p className="pl-note mb-3" data-plot-code-note>
                This tile&rsquo;s code is edited, so exports draw the code. Changes here show on the canvas only until you reset the code.
              </p>
            ) : null}
            {tab === "Encode" ? <Encode columns={columns} tile={tile} warnings={warnings} onChange={onChange} /> : null}
            {tab === "Style" ? <StyleTab config={config} update={apply} /> : null}
            {tab === "Code" ? (
              <div className="flex min-h-0 flex-1 flex-col gap-3" data-plot-code data-code-edited={script.edited ? "1" : "0"}>
                <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
                  {script.edited ? (
                    <p className="shrink-0 text-[12px] leading-4 text-muted">Edited. Export draws this code; Encode and Style no longer change it.</p>
                  ) : null}
                  <div className="min-h-0 flex-1">
                    <Code
                      value={script.code}
                      onChange={editCode}
                      onRun={runCode}
                      errorLine={figure.state.line}
                      errorText={figure.state.error}
                      actions={
                        <>
                          <RunButton running={figure.state.status === "running"} disabled={!workspaceId} onRun={runCode} />
                          {script.edited ? <button type="button" className="btn px-2 py-0.5 text-[12px]" data-plot-code-reset onClick={() => onChange(tileSchema.parse({ ...tile, code: null }))}>Reset to generated</button> : null}
                        </>
                      }
                    />
                  </div>
                </div>
              </div>
            ) : null}
            {tab === "Export" ? <TileExport workspaceId={workspaceId} code={script.code} edited={script.edited} toast={toast} /> : null}
          </div>
        </aside>
      </div>
    </div>
    </ModalScope.Provider>
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

function TileExport({ workspaceId, code, edited, toast }: { workspaceId: string | null; code: string; edited: boolean; toast: (text: string, opts?: { tone?: "error" }) => void }) {
  const run = async (format: "png" | "svg" | "pdf" | "eps") => {
    if (!workspaceId) return;
    try {
      const result = await renderPlot(workspaceId, { format, code });
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
      <p className="text-[12px] leading-5 text-muted">Download this tile{edited ? ", drawn by its edited code" : ""}. Export figure on the canvas saves every tile in one file.</p>
      <div className="grid grid-cols-4 gap-1.5">
        {(["png", "svg", "pdf", "eps"] as const).map((format) => (
          <button key={format} type="button" className="pl-btn justify-center" onClick={() => void run(format)}><Download size={13} aria-hidden />{format.toUpperCase()}</button>
        ))}
      </div>
    </div>
  );
}
