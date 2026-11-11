"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import { ApiError } from "@/lib/api";
import { inlinePlotRatio, loadPlotFigures, type PlotFigure } from "@/lib/plots/figures";
import { ChartView } from "./chart-view";
import { createHeightHandle, storedEmbedHeight } from "../editor/embed-resize";

const PLOT_MIN_HEIGHT = 180;

export function mountPlotOff(host: HTMLElement, label: string): void {
  host.replaceChildren();
  host.className = "mention mention-off";
  host.setAttribute("aria-disabled", "true");
  host.title = "Plots are not part of your template. The plot is still in your account.";
  host.textContent = `@${label || "Plot"} · not part of your template`;
}

export { inlinePlotRatio };

type Figure = PlotFigure;

type InlinePlotProps = { id: string; label: string; onRemove?: () => void; height?: number | null; onResize?: (height: number) => void };

function InlinePlot({ id, label, onRemove, height: storedHeight = null, onResize }: InlinePlotProps) {
  const [height, setHeight] = useState<number | null>(() => storedEmbedHeight(storedHeight, PLOT_MIN_HEIGHT));
  const heightRef = useRef(height);
  heightRef.current = height;
  const stageRef = useRef<HTMLDivElement>(null);
  const handleHost = useRef<HTMLDivElement>(null);
  const commitRef = useRef(onResize);
  commitRef.current = onResize;
  useEffect(() => setHeight(storedEmbedHeight(storedHeight, PLOT_MIN_HEIGHT)), [storedHeight]);
  const [title, setTitle] = useState(label || "Plot");
  const [href, setHref] = useState(`/plots/${id.split("/")[0]}`);
  const [compact, setCompact] = useState(false);
  const [figures, setFigures] = useState<Figure[] | null>(null);
  const [error, setError] = useState("");
  const [off, setOff] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const loaded = await loadPlotFigures(id, label);
      if (cancelled) return;
      setTitle(loaded.title || label || "Plot");
      setHref(loaded.href);
      setFigures(loaded.figures);
    };
    void load().catch((failure: unknown) => {
      if (cancelled) return;
      if (failure instanceof ApiError && failure.moduleOff) setOff(true);
      else setError(failure instanceof Error ? failure.message : "Could not load this plot.");
    });
    return () => { cancelled = true; };
  }, [id, label]);

  const resizable = Boolean(onResize);
  useEffect(() => {
    const host = handleHost.current;
    if (!host || !resizable) return;
    const handle = createHeightHandle({
      label: `Resize ${label || "plot"}`,
      min: PLOT_MIN_HEIGHT,
      read: () => heightRef.current ?? stageRef.current?.querySelector<HTMLElement>("[data-plot-figure]")?.clientHeight ?? 320,
      apply: (next) => {
        heightRef.current = next;
        setHeight(next);
      },
      commit: (next) => commitRef.current?.(next),
    });
    host.append(handle);
    return () => handle.remove();
  }, [resizable, label, compact]);

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
        <div ref={stageRef} className="space-y-3 p-2">
          {error ? <p role="alert" className="text-[13px] text-danger">{error}</p> : figures === null ? <p className="p-3 text-[13px] text-muted">Loading plot…</p> : !figures.length ? <p className="p-3 text-[13px] text-muted">No chart yet. Open this plot to add data and choose columns.</p> : figures.map((figure) => (
            <div key={figure.id}>
              {figures.length > 1 ? <p className="mb-1 text-[12px] text-muted">{figure.title}</p> : null}
              <div className="relative w-full" data-plot-figure style={height ? { height } : { aspectRatio: figure.ratio }}>
                <ChartView frame={figure.frame} config={figure.config} variant="tile" />
              </div>
              {figure.warnings.map((warning) => <p key={warning} className="text-[12px] text-warn">{warning}</p>)}
            </div>
          ))}
        </div>
      ) : null}
      {!compact && resizable ? <div ref={handleHost} /> : null}
    </div>
  );
}

export type PlotCardHandle = { destroy: () => void; setHeight: (height: number | null) => void };

export function mountPlotCard(
  host: HTMLElement,
  id: string,
  label: string,
  onRemove?: () => void,
  options: { height?: number | null; onResize?: (height: number) => void } = {},
): PlotCardHandle {
  host.replaceChildren();
  host.className = "plot-mention";
  host.contentEditable = "false";
  const root = createRoot(host);
  const render = (height: number | null) =>
    root.render(<InlinePlot id={id} label={label} onRemove={onRemove} height={height} onResize={options.onResize} />);
  render(options.height ?? null);
  return {
    destroy: () => queueMicrotask(() => root.unmount()),
    setHeight: render,
  };
}
