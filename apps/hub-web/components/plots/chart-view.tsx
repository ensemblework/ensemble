"use client";

import { useEffect, useRef, useState } from "react";
import { prepareSeries, type Frame, type PlotConfig } from "@ensemble/shared-types";
import { chartOption, type PlotTheme } from "@/lib/plots/option";
import { readPlotTheme } from "@/lib/plots/theme";

export { readPlotTheme, usePlotTheme } from "@/lib/plots/theme";

type EchartsModule = typeof import("echarts");
let echartsLoader: Promise<EchartsModule> | null = null;

function loadEcharts(): Promise<EchartsModule> {
  echartsLoader ??= import("echarts");
  return echartsLoader;
}

/** Warm the chart library after the canvas shell is on screen. Safari has no guarantee of requestIdleCallback. */
export function preloadEcharts(): () => void {
  const run = () => {
    void loadEcharts();
  };
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(run, { timeout: 1200 });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(run, 180);
  return () => window.clearTimeout(id);
}

function webKitCanvas(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /Safari/i.test(ua) && !/Chrome|Chromium|CriOS|Edg|Android/i.test(ua);
}


type ChartHandle = {
  setOption: (option: unknown, opts?: { notMerge?: boolean; lazyUpdate?: boolean; replaceMerge?: string[] }) => void;
  resize: () => void;
  dispose: () => void;
  on: (event: string, handler: (params: unknown) => void) => void;
  getDataURL: (opts: unknown) => string;
};

export function ChartView({
  frame,
  config,
  onRecolor,
  onBrush,
  variant = "studio",
  notices = [],
}: {
  frame: Frame;
  config: PlotConfig;
  onRecolor?: (key: string) => void;
  onBrush?: (range: { from: string; to: string } | null) => void;
  variant?: "studio" | "tile" | "focus";
  notices?: string[];
}) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<ChartHandle | null>(null);
  const painted = useRef(false);
  const latest = useRef({ frame, config, variant, onRecolor, onBrush });
  latest.current = { frame, config, variant, onRecolor, onBrush };
  const signature = JSON.stringify({ columns: frame.columns, rows: frame.rows, config, variant });
  const [warnings, setWarnings] = useState<string[]>([]);

  useEffect(() => {
    const node = host.current;
    if (!node) return;
    let disposed = false;
    let observer: ResizeObserver | null = null;
    let themeObserver: MutationObserver | null = null;
    let frameId = 0;
    const resize = () => {
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => chart.current?.resize());
    };
    const paint = (firstDraw: boolean) => {
      if (!chart.current) return;
      const current = latest.current;
      const prepared = prepareSeries(current.frame, current.config);
      setWarnings(prepared.warnings);
      const log = current.config.xLog || current.config.yLogLeft || current.config.yLogRight;
      const option = chartOption(current.frame, current.config, readPlotTheme(), {
        compact: current.variant === "tile",
        showTitle: current.variant === "studio",
      });
      const animate = firstDraw && !log;
      option.animation = animate;
      option.animationDuration = animate ? 240 : 0;
      option.animationDurationUpdate = 0;
      chart.current.setOption(option, { notMerge: true, lazyUpdate: false, replaceMerge: ["series"] });
      resize();
    };
    const boot = (attempt: number) => {
      const node = host.current;
      if (disposed || !node) return;
      if ((node.clientWidth < 2 || node.clientHeight < 2) && attempt < 24) {
        requestAnimationFrame(() => boot(attempt + 1));
        return;
      }
      void loadEcharts().then((echarts) => {
        if (disposed || !host.current || chart.current) return;
        const renderer = webKitCanvas() ? "svg" : "canvas";
        let instance: ReturnType<EchartsModule["init"]>;
        try {
          instance = echarts.init(host.current, undefined, { renderer });
        } catch {
          instance = echarts.init(host.current, undefined, { renderer: renderer === "canvas" ? "svg" : "canvas" });
        }
        (host.current as HTMLDivElement & { __plotChart?: typeof instance }).__plotChart = instance;
        chart.current = instance as unknown as ChartHandle;
        painted.current = false;
        instance.on("click", (params: unknown) => {
          const event = params as { name?: string; seriesName?: string };
          const key = event.name || event.seriesName;
          if (key) latest.current.onRecolor?.(key);
        });
        instance.on("brushEnd", (params: unknown) => {
          const areas = (params as { areas?: Array<{ coordRange?: unknown[] }> }).areas ?? [];
          const range = areas[0]?.coordRange;
          if (!range || range.length < 2) {
            latest.current.onBrush?.(null);
            return;
          }
          latest.current.onBrush?.({ from: String(range[0]), to: String(range[1]) });
        });
        paint(true);
        painted.current = true;
        observer = new ResizeObserver(resize);
        observer.observe(host.current);
        themeObserver = new MutationObserver(() => paint(false));
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
      }).catch(() => {
        if (!disposed && host.current) host.current.dataset.plotChartError = "1";
      });
    };
    boot(0);
    return () => {
      disposed = true;
      cancelAnimationFrame(frameId);
      observer?.disconnect();
      themeObserver?.disconnect();
      if (node) delete (node as HTMLDivElement & { __plotChart?: unknown }).__plotChart;
      chart.current?.dispose();
      chart.current = null;
      painted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!chart.current) return;
    const current = latest.current;
    const prepared = prepareSeries(current.frame, current.config);
    setWarnings(prepared.warnings);
    const option = chartOption(current.frame, current.config, readPlotTheme(), {
      compact: current.variant === "tile",
      showTitle: current.variant === "studio",
    });
    option.animation = false;
    option.animationDuration = 0;
    option.animationDurationUpdate = 0;
    chart.current.setOption(option, { notMerge: true, lazyUpdate: false, replaceMerge: ["series"] });
  }, [signature]);

  const fill = variant === "tile" || variant === "focus";
  const lines = variant === "focus" || variant === "tile" ? [] : [...notices, ...warnings];
  return (
    <div className={fill ? "absolute inset-0 overflow-hidden" : "relative h-full min-h-[420px] w-full"}>
      <div ref={host} className="h-full w-full" data-plot-chart />
      {lines.length ? (
        <ul className="pointer-events-none absolute bottom-1 left-2 right-2 max-h-24 space-y-0.5 overflow-hidden text-[11px] leading-4 text-warn" data-plot-warning>
          {lines.map((line) => <li key={line}>{line}</li>)}
        </ul>
      ) : null}
    </div>
  );
}

export async function exportChartPng(frame: Frame, config: PlotConfig, pixelRatio: number): Promise<Blob> {
  const echarts = await loadEcharts();
  const node = document.createElement("div");
  const inches = 6.5;
  node.style.cssText = `position:fixed;left:-10000px;top:0;width:${inches * 96}px;height:${3.4 * 96}px`;
  document.body.appendChild(node);
  const instance = echarts.init(node, undefined, { renderer: "canvas" });
  instance.setOption(chartOption(frame, config, readPlotTheme()));
  const url = instance.getDataURL({ type: "png", pixelRatio, backgroundColor: readPlotTheme().dark ? "#141210" : "#fffcf7" });
  instance.dispose();
  node.remove();
  const response = await fetch(url);
  return response.blob();
}

export async function exportChartSvg(frame: Frame, config: PlotConfig): Promise<string> {
  const echarts = await loadEcharts();
  const node = document.createElement("div");
  node.style.cssText = "position:fixed;left:-10000px;top:0;width:900px;height:520px";
  document.body.appendChild(node);
  const instance = echarts.init(node, undefined, { renderer: "svg" });
  instance.setOption(chartOption(frame, config, readPlotTheme()));
  const svg = node.querySelector("svg")?.outerHTML ?? "";
  instance.dispose();
  node.remove();
  return svg;
}
