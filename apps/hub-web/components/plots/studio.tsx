"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CHART_TYPES,
  boilerplate,
  defaultPlotConfig,
  matplotlibSource,
  parseTableText,
  plotConfigSchema,
  type ColumnType,
  type PlotAnnotation,
  type PlotColumn,
  type PlotConfig,
  type SeriesEncoding,
} from "@ensemble/shared-types";
import { ChevronDown } from "lucide-react";
import { ChartView, exportChartPng, exportChartSvg, usePlotTheme } from "@/components/plots/chart-view";
import { ColumnSelect } from "@/components/plots/column-select";
import { useDelayedFlag } from "@/lib/motion/use-delayed-flag";
import { api } from "@/lib/api";
import { figureBytes } from "@/lib/plots/figure-file";
import { plottedCsv } from "@/lib/plots/option";
import { seriesSwatchColor } from "@/lib/plots/theme";
import { useToast } from "@/components/toast";
import { InlineEdit, Popover, Segmented, Toggle, cx } from "@/components/ui";

const CodePane = dynamic(() => import("./code-pane").then((mod) => mod.PlotCodePane), { ssr: false });

type Dataset = {
  id: string;
  name: string;
  format: string;
  columns: PlotColumn[];
  rowCount: number;
  sheet: string;
  sheets: string[];
  rows: Array<Array<string | number | null>>;
};

const TABS = ["Data", "Encode", "Style", "Code", "Export"] as const;

const CHART_LABEL: Record<(typeof CHART_TYPES)[number], string> = {
  line: "Line",
  area: "Area",
  "stacked-area": "Stacked area",
  bar: "Grouped bar",
  "stacked-bar": "Stacked bar",
  "stacked-bar-100": "100% stacked bar",
  "bar-horizontal": "Horizontal bar",
  "stacked-bar-horizontal": "Horizontal stacked bar",
  pie: "Pie",
  donut: "Donut",
  scatter: "Scatter",
  bubble: "Bubble",
  histogram: "Histogram",
  box: "Box",
  violin: "Violin",
  heatmap: "Heatmap",
  step: "Step",
  waterfall: "Waterfall",
  combo: "Combo",
};

const PALETTE_LABEL: Record<PlotConfig["palette"], string> = {
  "okabe-ito": "Okabe–Ito",
  tableau10: "Tableau 10",
  set2: "Set 2",
  viridis: "Viridis",
  rdbu: "RdBu",
  accent: "Accent",
};

const STYLE_FIELDS = [
  ["title", "Title"],
  ["subtitle", "Subtitle"],
  ["xTitle", "X axis"],
  ["yTitleLeft", "Left Y"],
  ["yTitleRight", "Right Y"],
] as const;

const LINE_KIND: Record<PlotAnnotation["kind"], string> = {
  hline: "Horizontal line",
  vline: "Vertical line",
  linear: "Straight line",
  band: "Band",
};

function download(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function bytesOf(file: File): Promise<Uint8Array> {
  return file.arrayBuffer().then((buffer) => new Uint8Array(buffer));
}

export function PlotStudio({ plotId }: { plotId: string }) {
  const toast = useToast();
  const client = useQueryClient();
  const plot = useQuery({ queryKey: ["plot", plotId], queryFn: () => api.plot(plotId) });
  const [config, setConfig] = useState<PlotConfig | null>(null);
  const [title, setTitle] = useState("");
  const [code, setCode] = useState("");
  const [tab, setTab] = useState<(typeof TABS)[number]>("Data");
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [busy, setBusy] = useState("");
  const [paste, setPaste] = useState("");
  const [url, setUrl] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [renderUrl, setRenderUrl] = useState<string | null>(null);
  const [errorText, setErrorText] = useState("");
  const saveTimer = useRef(0);
  const slow = useDelayedFlag(Boolean(busy));

  useEffect(() => {
    if (!plot.data) return;
    setConfig(plotConfigSchema.parse(plot.data.plot.config));
    setTitle(plot.data.plot.title);
    setCode(plot.data.plot.code);
    if (plot.data.plot.datasetId) {
      void api.plotDataset(plot.data.plot.datasetId, true).then((result) => setDataset(result.dataset as Dataset));
    }
  }, [plot.data]);

  useEffect(() => {
    if (!config || !plot.data) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void api.updatePlot(plotId, { title, config, code }).then(() => client.invalidateQueries({ queryKey: ["plots"] }));
    }, 700);
    return () => window.clearTimeout(saveTimer.current);
  }, [config, title, code, plotId, client, plot.data]);

  const frame = useMemo(() => (dataset ? { columns: dataset.columns, rows: dataset.rows } : null), [dataset]);

  const attach = async (body: Parameters<typeof api.createPlotDataset>[0]) => {
    setBusy("Reading the table");
    setWarnings([]);
    try {
      const created = await api.createPlotDataset(body);
      const full = await api.plotDataset(created.dataset.id, true);
      setDataset(full.dataset as Dataset);
      setWarnings(created.dataset.warnings ?? []);
      const columns = full.dataset.columns;
      const numeric = columns.filter((column) => column.type === "number");
      const x = columns.find((column) => column.type !== "number") ?? columns[0];
      setConfig((current) =>
        plotConfigSchema.parse({
          ...(current ?? defaultPlotConfig()),
          x: x?.name ?? null,
          series: numeric.slice(0, 2).map((column, index) => ({ y: column.name, axis: index === 0 ? "left" : "right" })),
        }),
      );
      await api.updatePlot(plotId, { datasetId: created.dataset.id });
      setTab("Encode");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not read that file.", { tone: "error" });
    } finally {
      setBusy("");
    }
  };

  const onFile = async (file: File) => {
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".pkl") || lower.endsWith(".pickle")) {
      toast("Pickle files can run code when opened. Export Parquet or Feather instead.", { tone: "error" });
      return;
    }
    const textLike = [".csv", ".tsv", ".txt", ".json", ".jsonl", ".ndjson"].some((ext) => lower.endsWith(ext));
    if (textLike) {
      const text = new TextDecoder().decode(await bytesOf(file));
      const format = lower.endsWith(".tsv") ? "tsv" : lower.endsWith(".json") || lower.endsWith(".jsonl") ? "json" : lower.endsWith(".txt") ? "txt" : "csv";
      const parsed = parseTableText(text, format === "json" ? "json" : format);
      setWarnings(parsed.warnings);
      await attach({ name: file.name.replace(/\.[^.]+$/, ""), filename: file.name, text, columns: parsed.columns, rows: parsed.rows });
      return;
    }
    const bytes = await bytesOf(file);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    await attach({ name: file.name.replace(/\.[^.]+$/, ""), filename: file.name, fileBase64: btoa(binary) });
  };

  const update = (patch: Partial<PlotConfig>) => setConfig((current) => (current ? plotConfigSchema.parse({ ...current, ...patch }) : current));

  const duplicate = useMutation({
    mutationFn: () => api.duplicatePlot(plotId),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: ["plots"] });
      window.location.href = `/plots/${result.plot.id}`;
    },
  });

  if (!config) {
    return <div className="px-8 pt-8 text-[14px] text-muted">{plot.isError ? "That plot is not on your account." : slow ? "Opening the plot…" : ""}</div>;
  }

  const setType = async (column: PlotColumn, type: ColumnType) => {
    if (!dataset) return;
    const columns = dataset.columns.map((item) => (item.name === column.name ? { ...item, type } : item));
    setDataset({ ...dataset, columns });
    await api.updatePlotDataset(dataset.id, { columns });
  };

  return (
    <div className="flex h-[calc(100dvh-4.5rem)] min-h-0 flex-col px-4 pb-4 pt-3" data-plot-studio>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Link href="/plots" className="text-[12.5px] text-muted hover:text-ink">Plots</Link>
        <InlineEdit value={title} placeholder="Untitled plot" onSave={setTitle} className="display min-w-0 flex-1 text-[28px] leading-none" />
        <span className="text-[12px] text-faint">{busy || (dataset ? "Saved" : "New")}</span>
        <button type="button" className="btn" onClick={() => duplicate.mutate()}>Duplicate</button>
      </div>
      <div className="mb-2 flex gap-1 overflow-x-auto" role="tablist">
        {TABS.map((item) => (
          <button key={item} type="button" role="tab" aria-selected={tab === item} className={`rounded-md px-2.5 py-1 text-[12px] ${tab === item ? "bg-accent-soft font-medium text-ink" : "text-muted hover:text-ink"}`} onClick={() => setTab(item)}>
            {item}
          </button>
        ))}
      </div>
      {tab === "Code" ? (
        <CodeTab
          code={code || boilerplate(dataset?.name || "data")}
          onChange={setCode}
          datasetName={dataset?.name}
          onRun={async () => {
            setBusy("Running the script");
            setErrorText("");
            try {
              const result = await api.renderPlot(plotId, { format: "png", code: code || boilerplate(dataset?.name || "data") });
              if (renderUrl) URL.revokeObjectURL(renderUrl);
              const blob = await (await fetch(`data:image/png;base64,${result.data}`)).blob();
              setRenderUrl(URL.createObjectURL(blob));
            } catch (error) {
              setErrorText(error instanceof Error ? error.message : "The script failed.");
            } finally {
              setBusy("");
            }
          }}
          onExport={async (format) => {
            setBusy("Rendering");
            try {
              const result = await api.renderPlot(plotId, { format, code: code || boilerplate(dataset?.name || "data") });
              const blob = figureBytes(format, result.data);
              download(`${title || "plot"}.${format}`, blob);
            } catch (error) {
              toast(error instanceof Error ? error.message : "Render failed.", { tone: "error" });
            } finally {
              setBusy("");
            }
          }}
          preview={renderUrl}
          errorText={errorText}
        />
      ) : null}
      <div className={cx("grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_340px]", tab === "Code" && "hidden")}>
        <section className="tile flex min-h-0 flex-col overflow-hidden rounded-xl bg-panel">
          {!frame ? (
            <DropZone busy={busy} slow={slow} paste={paste} setPaste={setPaste} url={url} setUrl={setUrl} onFile={onFile} onPaste={() => void attach({ text: paste, filename: "pasted.csv" })} onUrl={() => void attach({ url })} />
          ) : (
            <div className="min-h-0 flex-1 p-1">
              <ChartView
                frame={frame}
                config={config}
                onRecolor={(key) => {
                  const palette = ["#E69F00", "#56B4E9", "#009E73", "#0072B2", "#D55E00", "#CC79A7"];
                  const next = palette[(Object.keys(config.colors).length + 1) % palette.length]!;
                  update({ colors: { ...config.colors, [key]: next } });
                }}
                onBrush={(range) => {
                  if (!range || !config.x) return;
                  update({ filter: { column: config.x, op: "gt", value: range.from } });
                  toast(`Brushed ${range.from} to ${range.to}. The filter uses the start of that range.`);
                }}
              />
            </div>
          )}
          {warnings.length ? <p className="px-4 pb-3 text-[12.5px] text-warn">{warnings.join(" ")}</p> : null}
        </section>
        <aside className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-panel">
          <div className="min-h-0 flex-1 overflow-auto p-3 text-[13px]">
            {tab === "Data" && dataset ? (
              <DataTab dataset={dataset} onType={setType} onSheet={(sheet) => void api.plotSheet(dataset.id, sheet).then(() => api.plotDataset(dataset.id, true)).then((result) => setDataset(result.dataset as Dataset))} />
            ) : null}
            {tab === "Data" && !dataset ? <p className="text-muted">Drop a file to see the columns.</p> : null}
            {tab === "Encode" && dataset ? <EncodeTab dataset={dataset} config={config} update={update} /> : null}
            {tab === "Style" ? <StyleTab config={config} update={update} /> : null}
            {tab === "Export" && frame ? (
              <ExportTab
                config={config}
                update={update}
                datasetName={dataset?.name || "data"}
                columns={dataset?.columns ?? []}
                onPng={async (ratio) => download(`${title || "plot"}.png`, await exportChartPng(frame, config, ratio))}
                onSvg={async () => download(`${title || "plot"}.svg`, new Blob([await exportChartSvg(frame, config)], { type: "image/svg+xml" }))}
                onCsv={() => download(`${title || "plot"}.csv`, new Blob([plottedCsv(frame, config)], { type: "text/csv" }))}
                onCopy={async () => {
                  const blob = await exportChartPng(frame, config, 2);
                  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
                  toast("Copied the chart.");
                }}
                onServer={async (format, source) => {
                  setBusy("Rendering");
                  try {
                    const result = await api.renderPlot(plotId, { format, code: source });
                    const blob = figureBytes(format, result.data);
                    download(`${title || "plot"}.${format}`, blob);
                  } catch (error) {
                    toast(error instanceof Error ? error.message : "Render failed.", { tone: "error" });
                  } finally {
                    setBusy("");
                  }
                }}
              />
            ) : null}
          </div>
        </aside>
      </div>
    </div>
  );
}

function DropZone({
  busy,
  slow,
  paste,
  setPaste,
  url,
  setUrl,
  onFile,
  onPaste,
  onUrl,
}: {
  busy: string;
  slow: boolean;
  paste: string;
  setPaste: (value: string) => void;
  url: string;
  setUrl: (value: string) => void;
  onFile: (file: File) => void;
  onPaste: () => void;
  onUrl: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-10"
      data-plot-drop
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        const file = event.dataTransfer.files[0];
        if (file) onFile(file);
      }}
    >
      <div className="max-w-md text-center">
        <h2 className="display text-[28px] leading-none">Drop a table</h2>
        <p className="mt-2 text-[13.5px] leading-5 text-muted">CSV, TSV, TXT, Excel, Numbers, ODS, JSON, Parquet, or Feather. Or paste a public Sheets, Drive, or OneDrive link.</p>
      </div>
      <button type="button" className="btn-primary" onClick={() => input.current?.click()}>Choose a file</button>
      <input ref={input} data-plot-file type="file" className="hidden" accept=".csv,.tsv,.txt,.xlsx,.xls,.xlsm,.ods,.numbers,.json,.jsonl,.parquet,.feather,.arrow,.pkl,.pickle" onChange={(event) => { const file = event.target.files?.[0]; if (file) onFile(file); }} />
      {slow ? <p className="text-[12.5px] text-muted">{busy}…</p> : null}
      <textarea value={paste} onChange={(event) => setPaste(event.target.value)} placeholder="Or paste rows here" aria-label="Paste data" className="field h-24 w-full max-w-lg resize-none" />
      <button type="button" className="btn" disabled={!paste.trim()} onClick={onPaste}>Use pasted data</button>
      <div className="flex w-full max-w-lg gap-2">
        <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://docs.google.com/spreadsheets/…" aria-label="Sheet link" className="field flex-1" />
        <button type="button" className="btn" disabled={!url.trim()} onClick={onUrl}>Import</button>
      </div>
    </div>
  );
}

function FieldSelect({ label, value, options, onChange, bare = false }: { label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void; bare?: boolean }) {
  const current = options.find((option) => option.value === value)?.label ?? value;
  return (
    <div className={bare ? "shrink-0" : "block"}>
      {bare ? null : <div className="mb-1 text-[12px] text-muted">{label}</div>}
      <Popover className={bare ? "" : "block w-full"} width={bare ? 160 : 280} trigger={(open, toggle) => (
        <button type="button" aria-label={label} aria-haspopup="listbox" aria-expanded={open} className={cx("field flex items-center justify-between gap-2 text-left", bare ? "px-2 py-0.5 text-[12px]" : "w-full")} onClick={toggle}>
          <span className="truncate">{current || "Choose"}</span>
          <ChevronDown size={13} className="shrink-0 text-muted" />
        </button>
      )}>
        {(close) => (
          <div role="listbox" aria-label={label}>
            {options.map((option) => (
              <button key={option.value} type="button" role="option" aria-selected={option.value === value} className={cx("flex w-full rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-hover", option.value === value && "bg-hover font-medium")} onClick={() => { onChange(option.value); close(); }}>
                {option.label}
              </button>
            ))}
          </div>
        )}
      </Popover>
    </div>
  );
}

function DataTab({ dataset, onType, onSheet }: { dataset: Dataset; onType: (column: PlotColumn, type: ColumnType) => void; onSheet: (sheet: string) => void }) {
  const preview = dataset.rows.slice(0, 8);
  return (
    <div className="space-y-3" data-plot-preview>
      <div className="text-[12.5px] text-muted">{dataset.name} · {dataset.rowCount.toLocaleString()} rows · {dataset.format}</div>
      {dataset.sheets.length > 1 ? <FieldSelect label="Sheet" value={dataset.sheet} options={dataset.sheets.map((sheet) => ({ value: sheet, label: sheet }))} onChange={onSheet} /> : null}
      <div className="overflow-auto">
        <table className="w-full text-left text-[12px]">
          <thead>
            <tr>{dataset.columns.map((column) => (
              <th key={column.name} className="border-b border-line px-1 py-1 font-medium">
                <div>{column.name}</div>
                <FieldSelect bare label={`${column.name} type`} value={column.type} options={[{ value: "number", label: "Number" }, { value: "date", label: "Date" }, { value: "category", label: "Category" }, { value: "text", label: "Text" }]} onChange={(value) => onType(column, value as ColumnType)} />
              </th>
            ))}</tr>
          </thead>
          <tbody>
            {preview.map((row, index) => (
              <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex} className="border-b border-line px-1 py-1 text-muted">{cell === null ? "" : String(cell)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EncodeTab({ dataset, config, update }: { dataset: Dataset; config: PlotConfig; update: (patch: Partial<PlotConfig>) => void }) {
  const names = dataset.columns.map((column) => column.name);
  return (
    <div className="space-y-3">
      <FieldSelect label="Chart type" value={config.chart} options={CHART_TYPES.map((type) => ({ value: type, label: CHART_LABEL[type] }))} onChange={(value) => update({ chart: value as PlotConfig["chart"] })} />
      <ColumnSelect
        label="X axis"
        columns={dataset.columns.map((column) => ({ id: column.name, name: column.name, type: column.type }))}
        selected={config.x ? [config.x] : []}
        multiple={false}
        onChange={(ids) => update({ x: ids[0] ?? null })}
      />
      <ColumnSelect
        label="Y series"
        columns={dataset.columns.map((column) => ({ id: column.name, name: column.name, type: column.type }))}
        selected={config.series.map((series) => series.y)}
        multiple
        onChange={(ids) => update({ series: ids.map((name) => config.series.find((series) => series.y === name) ?? { y: name, axis: "left" as const }) })}
        axisOf={(id) => config.series.find((series) => series.y === id)?.axis ?? "left"}
        onAxis={(id, axis) => update({ series: config.series.map((series) => series.y === id ? { ...series, axis } : series) })}
      />
      <p className="text-[11px] leading-4 text-faint">Count can tally a text column. A category or a non-positive value on a log axis is left off the chart.</p>
      {(config.chart === "pie" || config.chart === "donut") && config.series.length > 1 ? <p className="text-[12px] leading-4 text-muted">Each series is drawn as its own pie.</p> : null}
      {(config.chart === "pie" || config.chart === "donut") ? (
        <div>
          <div className="mb-1 text-[12px] text-muted">Slice labels</div>
          <Segmented label="Slice labels" value={config.pieLabels} options={[{ id: "name", label: "Name" }, { id: "percent", label: "Percent" }, { id: "both", label: "Both" }]} onChange={(value) => update({ pieLabels: value })} />
        </div>
      ) : null}
      <FieldSelect label="Colour by" value={config.colorBy ?? ""} options={[{ value: "", label: "None" }, ...names.map((name) => ({ value: name, label: name }))]} onChange={(value) => update({ colorBy: value || null })} />
      <FieldSelect label="Aggregation" value={config.agg} options={[{ value: "none", label: "None" }, { value: "sum", label: "Sum" }, { value: "mean", label: "Mean" }, { value: "count", label: "Count" }, { value: "median", label: "Median" }]} onChange={(value) => update({ agg: value as PlotConfig["agg"] })} />
      <FieldSelect label="Sort" value={config.sort} options={[{ value: "none", label: "None" }, { value: "x-asc", label: "X ascending" }, { value: "x-desc", label: "X descending" }, { value: "y-asc", label: "Y ascending" }, { value: "y-desc", label: "Y descending" }]} onChange={(value) => update({ sort: value as PlotConfig["sort"] })} />
      <div className="flex flex-wrap gap-3">
        <span className="flex items-center gap-2 text-[12px]"><Toggle checked={config.xLog} label="Log X" onChange={(value) => update({ xLog: value })} /> Log X</span>
        <span className="flex items-center gap-2 text-[12px]"><Toggle checked={config.yLogLeft} label="Log left" onChange={(value) => update({ yLogLeft: value })} /> Log left</span>
        <span className="flex items-center gap-2 text-[12px]"><Toggle checked={config.yLogRight} label="Log right" onChange={(value) => update({ yLogRight: value })} /> Log right</span>
      </div>
      <FilterFields config={config} names={names} update={update} />
    </div>
  );
}

function FilterFields({ config, names, update }: { config: PlotConfig; names: string[]; update: (patch: Partial<PlotConfig>) => void }) {
  const filter = config.filter;
  return (
    <div className="space-y-1">
      <div className="text-muted">Filter</div>
      <div className="flex flex-wrap gap-1">
        <FieldSelect bare label="Filter column" value={filter?.column ?? ""} options={[{ value: "", label: "None" }, ...names.map((name) => ({ value: name, label: name }))]} onChange={(value) => update({ filter: value ? { column: value, op: filter?.op ?? "eq", value: filter?.value ?? "" } : null })} />
        <FieldSelect bare label="Filter operator" value={filter?.op ?? "eq"} options={[{ value: "eq", label: "equals" }, { value: "contains", label: "contains" }, { value: "gt", label: "above" }, { value: "lt", label: "below" }]} onChange={(value) => filter && update({ filter: { ...filter, op: value as NonNullable<PlotConfig["filter"]>["op"] } })} />
        <input className="field w-20" aria-label="Filter value" value={filter?.value ?? ""} onChange={(event) => filter && update({ filter: { ...filter, value: event.target.value } })} />
      </div>
    </div>
  );
}

function Caption({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-0.5 text-[11px] leading-4 text-muted">{label}</div>
      {children}
    </div>
  );
}

function GridTickControls({ config, update }: { config: PlotConfig; update: (patch: Partial<PlotConfig>) => void }) {
  const gridX = config.gridX ?? config.grid;
  const gridY = config.gridY ?? config.grid;
  const lineStyle = [
    { value: "solid", label: "Solid" },
    { value: "dashed", label: "Dashed" },
    { value: "dotted", label: "Dotted" },
    { value: "dashdot", label: "Dash-dot" },
  ];
  const formats = [
    { value: "auto", label: "Auto" },
    { value: "number", label: "Number" },
    { value: "compact", label: "Compact" },
    { value: "percent", label: "Percent" },
  ];
  const modes = [
    { value: "auto", label: "Auto" },
    { value: "step", label: "Fixed step" },
    { value: "max", label: "Max ticks" },
  ];
  return (
    <div className="space-y-2 rounded-md border border-line p-2" data-grid-controls>
      <div className="text-[12px] font-medium">Grid</div>
      <div className="grid grid-cols-2 gap-2">
        <span className="flex h-7 items-center gap-2 text-[12px]"><Toggle checked={gridX} label="Major X grid" onChange={(value) => update({ gridX: value })} /> Major X</span>
        <span className="flex h-7 items-center gap-2 text-[12px]"><Toggle checked={gridY} label="Major Y grid" onChange={(value) => update({ gridY: value })} /> Major Y</span>
        <span className="flex h-7 items-center gap-2 text-[12px]"><Toggle checked={config.gridXMinor} label="Minor X grid" onChange={(value) => update({ gridXMinor: value, xMinorTicks: value || config.xMinorTicks })} /> Minor X</span>
        <span className="flex h-7 items-center gap-2 text-[12px]"><Toggle checked={config.gridYMinor} label="Minor Y grid" onChange={(value) => update({ gridYMinor: value, yMinorTicks: value || config.yMinorTicks })} /> Minor Y</span>
      </div>
      <label className="flex h-8 items-center justify-between text-[12px]">Minor divisions
        <input type="number" min={2} max={20} className="field w-16" aria-label="Minor divisions" value={config.minorDivisions} onChange={(event) => update({ minorDivisions: Number(event.target.value) })} />
      </label>
      <div className="text-[11px] text-muted">Major line</div>
      <div className="grid grid-cols-3 gap-1">
        <Caption label="Style"><FieldSelect bare label="Grid style" value={config.gridStyle} options={lineStyle} onChange={(value) => update({ gridStyle: value as PlotConfig["gridStyle"] })} /></Caption>
        <Caption label="Width"><input type="number" min={0.02} max={4} step={0.05} className="field w-full" aria-label="Grid width" value={config.gridWidth} onChange={(event) => update({ gridWidth: Number(event.target.value) })} /></Caption>
        <Caption label="Opacity"><input type="number" min={0} max={1} step={0.05} className="field w-full" aria-label="Grid alpha" value={config.gridAlpha} onChange={(event) => update({ gridAlpha: Number(event.target.value) })} /></Caption>
      </div>
      <div className="text-[11px] text-muted">Minor line</div>
      <div className="grid grid-cols-3 gap-1">
        <Caption label="Style"><FieldSelect bare label="Minor grid style" value={config.minorGridStyle} options={lineStyle} onChange={(value) => update({ minorGridStyle: value as PlotConfig["minorGridStyle"] })} /></Caption>
        <Caption label="Width"><input type="number" min={0.02} max={2} step={0.05} className="field w-full" aria-label="Minor grid width" value={config.minorGridWidth} onChange={(event) => update({ minorGridWidth: Number(event.target.value) })} /></Caption>
        <Caption label="Opacity"><input type="number" min={0} max={1} step={0.05} className="field w-full" aria-label="Minor grid alpha" value={config.minorGridAlpha} onChange={(event) => update({ minorGridAlpha: Number(event.target.value) })} /></Caption>
      </div>
      <div className="text-[12px] font-medium" data-tick-controls>Ticks</div>
      {(["x", "y"] as const).map((side) => {
        const mode = side === "x" ? config.xTicks : config.yTicks;
        const step = side === "x" ? config.xTickStep : config.yTickStep;
        const max = side === "x" ? config.xTickMax : config.yTickMax;
        const minor = side === "x" ? config.xMinorTicks : config.yMinorTicks;
        const format = (side === "x" ? config.xTickFormat : config.yTickFormat) ?? config.tickFormat;
        const rotate = side === "x" ? config.xTickRotate : config.yTickRotate;
        const label = side === "x" ? "X" : "Y";
        return (
          <div key={side} className="space-y-1">
            <div className="text-[11px] text-muted">{label} ticks</div>
            <div className="grid grid-cols-2 gap-1">
            <Caption label="Mode"><FieldSelect bare label={`${label} ticks`} value={mode} options={modes} onChange={(value) => update(side === "x" ? { xTicks: value as PlotConfig["xTicks"] } : { yTicks: value as PlotConfig["yTicks"] })} /></Caption>
            {mode === "step" ? (
              <Caption label="Step"><input type="number" min={0.0001} step="any" className="field w-full" aria-label={`${label} tick step`} value={step ?? ""} placeholder="Step" onChange={(event) => update(side === "x" ? { xTickStep: event.target.value === "" ? null : Number(event.target.value) } : { yTickStep: event.target.value === "" ? null : Number(event.target.value) })} /></Caption>
            ) : (
              <Caption label="Count"><input type="number" min={2} max={40} className="field w-full" aria-label={`${label} max ticks`} value={max} onChange={(event) => update(side === "x" ? { xTickMax: Number(event.target.value) } : { yTickMax: Number(event.target.value) })} /></Caption>
            )}
            </div>
            <div className="grid grid-cols-2 gap-1">
            <span className="flex h-8 items-center gap-2 text-[12px]"><Toggle checked={minor} label={`${label} minor ticks`} onChange={(value) => update(side === "x" ? { xMinorTicks: value } : { yMinorTicks: value })} /> Minor</span>
            <FieldSelect bare label={`${label} tick format`} value={format} options={formats} onChange={(value) => update(side === "x" ? { xTickFormat: value as PlotConfig["tickFormat"] } : { yTickFormat: value as PlotConfig["tickFormat"] })} />
            <label className="col-span-2 flex h-8 items-center justify-between text-[12px] text-muted">{label} rotation
              <input type="number" min={-90} max={90} className="field w-16" aria-label={`${label} tick rotation`} value={rotate} onChange={(event) => update(side === "x" ? { xTickRotate: Number(event.target.value) } : { yTickRotate: Number(event.target.value) })} />
            </label>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function StyleTab({ config, update }: { config: PlotConfig; update: (patch: Partial<PlotConfig>) => void }) {
  const theme = usePlotTheme();
  return (
    <div className="space-y-2">
      <p className="text-[12px] leading-4 text-muted">Depth effects stay off. Extruded bars and tilted pies make values harder to read.</p>
      {STYLE_FIELDS.map(([key, label]) => (
        <label key={key} className="block">{label}
          <input className="field mt-1 w-full" aria-label={label} value={config[key]} onChange={(event) => update({ [key]: event.target.value })} />
        </label>
      ))}
      <FieldSelect label="Palette" value={config.palette} options={(Object.keys(PALETTE_LABEL) as Array<PlotConfig["palette"]>).map((palette) => ({ value: palette, label: PALETTE_LABEL[palette] }))} onChange={(value) => update({ palette: value as PlotConfig["palette"] })} />
      <p className="text-[11px] leading-4 text-faint">Accent uses the colour set in your appearance. A chart with one series uses it too.</p>
      <FieldSelect label="Legend" value={config.legend} options={[{ value: "bottom", label: "Bottom" }, { value: "top", label: "Top" }, { value: "left", label: "Left" }, { value: "right", label: "Right" }, { value: "none", label: "Hidden" }]} onChange={(value) => update({ legend: value as PlotConfig["legend"] })} />
      <FieldSelect label="Tick format" value={config.tickFormat} options={[{ value: "auto", label: "Auto" }, { value: "number", label: "Number" }, { value: "compact", label: "Compact" }, { value: "percent", label: "Percent" }]} onChange={(value) => update({ tickFormat: value as PlotConfig["tickFormat"] })} />
      <label className="flex items-center justify-between">Font size
        <input type="number" min={8} max={18} className="field w-16" aria-label="Font size" value={config.fontSize} onChange={(event) => update({ fontSize: Number(event.target.value) })} />
      </label>
      <div className="grid grid-cols-2 gap-2">
        {(["yMinLeft", "yMaxLeft", "yMinRight", "yMaxRight"] as const).map((key) => (
          <label key={key} className="block text-[12px] text-muted">{key === "yMinLeft" ? "Left min" : key === "yMaxLeft" ? "Left max" : key === "yMinRight" ? "Right min" : "Right max"}
            <input className="field mt-1 w-full" aria-label={key === "yMinLeft" ? "Left min" : key === "yMaxLeft" ? "Left max" : key === "yMinRight" ? "Right min" : "Right max"} value={config[key] ?? ""} placeholder="Auto" onChange={(event) => update({ [key]: event.target.value.trim() === "" ? null : Number(event.target.value) })} />
          </label>
        ))}
      </div>
      <GridTickControls config={config} update={update} />
      {config.chart === "box" ? (
        <div className="space-y-1 rounded-md border border-line p-2" data-box-controls>
          <div className="text-[12px] font-medium">Box plot</div>
          <span className="flex items-center gap-2"><Toggle checked={config.boxOutliers} label="Outliers" onChange={(value) => update({ boxOutliers: value })} /> Outliers</span>
          <span className="flex items-center gap-2"><Toggle checked={config.boxNotch} label="Notches" onChange={(value) => update({ boxNotch: value })} /> Notches</span>
          <span className="flex items-center gap-2"><Toggle checked={config.boxJitter} label="Jittered points" onChange={(value) => update({ boxJitter: value })} /> Jittered points</span>
          <label className="flex items-center justify-between text-[12px]">Whiskers (IQR)
            <input type="number" min={0} max={5} step={0.1} className="field w-16" aria-label="Whiskers" value={config.boxWhisker} onChange={(event) => update({ boxWhisker: Number(event.target.value) })} />
          </label>
        </div>
      ) : null}
      {config.series.map((series, seriesIndex) => (
        <div key={series.y} className="rounded-md border border-line p-2">
          <div className="mb-1 font-medium">{series.y}</div>
          <div className="flex flex-wrap gap-2">
            <input type="color" aria-label={`${series.y} colour`} className="h-7 w-10 cursor-pointer rounded-md border border-line bg-raised" value={seriesSwatchColor(config, seriesIndex, theme)} onChange={(event) => update({ series: config.series.map((item) => item.y === series.y ? { ...item, color: event.target.value } : item) })} />
            <FieldSelect bare label={`${series.y} line`} value={series.lineStyle ?? "solid"} options={[{ value: "solid", label: "Solid" }, { value: "dashed", label: "Dashed" }, { value: "dotted", label: "Dotted" }, { value: "dashdot", label: "Dash-dot" }]} onChange={(value) => update({ series: config.series.map((item) => item.y === series.y ? { ...item, lineStyle: value as SeriesEncoding["lineStyle"] } : item) })} />
            <FieldSelect bare label={`${series.y} marker`} value={series.marker ?? "auto"} options={[{ value: "auto", label: "Auto" }, { value: "none", label: "None" }, { value: "circle", label: "Circle" }, { value: "rect", label: "Square" }, { value: "triangle", label: "Triangle" }, { value: "diamond", label: "Diamond" }]} onChange={(value) => update({ series: config.series.map((item) => item.y === series.y ? { ...item, marker: value as SeriesEncoding["marker"] } : item) })} />
            <input type="number" min={0.5} max={6} step={0.25} className="field w-16" aria-label={`${series.y} width`} value={series.width ?? 1.5} onChange={(event) => update({ series: config.series.map((item) => item.y === series.y ? { ...item, width: Number(event.target.value) } : item) })} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function LinesTab({ config, update }: { config: PlotConfig; update: (patch: Partial<PlotConfig>) => void }) {
  const add = (kind: PlotAnnotation["kind"]) => {
    const id = Math.random().toString(36).slice(2, 8);
    const next: PlotAnnotation =
      kind === "hline" ? { id, kind, y: 10000, axis: "left", label: "Threshold", color: "#D55E00", style: "dashed" }
      : kind === "vline" ? { id, kind, x: 0, label: "Mark", color: "#0072B2", style: "dashed" }
      : kind === "linear" ? { id, kind, m: 1, c: 0, axis: "left", label: "y = x", color: "#009E73", style: "solid" }
      : { id, kind: "band", orientation: "horizontal", from: 0, to: 1, axis: "left", label: "Band", color: "#56B4E9" };
    update({ annotations: [...config.annotations, next] });
  };
  return (
    <div className="space-y-2" data-plot-annotations>
      <div className="flex flex-wrap gap-1">
        <button type="button" className="btn" onClick={() => add("hline")}>Horizontal</button>
        <button type="button" className="btn" onClick={() => add("vline")}>Vertical</button>
        <button type="button" className="btn" onClick={() => add("linear")}>y = mx + c</button>
        <button type="button" className="btn" onClick={() => add("band")}>Band</button>
      </div>
      {config.annotations.map((note) => (
        <div key={note.id} className="space-y-1 rounded-md border border-line p-2">
          <div className="flex items-center justify-between">
            <span className="font-medium">{LINE_KIND[note.kind]}</span>
            <button type="button" className="text-[12px] text-danger" onClick={() => update({ annotations: config.annotations.filter((item) => item.id !== note.id) })}>Remove</button>
          </div>
          <input className="field w-full" aria-label="Annotation label" value={note.label} onChange={(event) => update({ annotations: config.annotations.map((item) => item.id === note.id ? { ...item, label: event.target.value } : item) })} />
          <label className="flex items-center gap-2 text-[12px] text-muted">Colour
            <input type="color" aria-label="Line colour" className="h-7 w-10 cursor-pointer rounded-md border border-line bg-raised" value={note.color} onChange={(event) => update({ annotations: config.annotations.map((item) => item.id === note.id ? { ...item, color: event.target.value } : item) })} />
          </label>
          {note.kind === "hline" ? (
            <>
              <input className="field w-full" aria-label="Y value" type="number" value={note.y} onChange={(event) => update({ annotations: config.annotations.map((item) => item.id === note.id && item.kind === "hline" ? { ...item, y: Number(event.target.value) } : item) })} />
              <FieldSelect label="Line axis" value={note.axis} options={[{ value: "left", label: "Left axis" }, { value: "right", label: "Right axis" }]} onChange={(value) => update({ annotations: config.annotations.map((item) => item.id === note.id && item.kind === "hline" ? { ...item, axis: value as "left" | "right" } : item) })} />
            </>
          ) : null}
          {note.kind === "vline" ? <input className="field w-full" aria-label="X value" value={String(note.x)} onChange={(event) => update({ annotations: config.annotations.map((item) => item.id === note.id && item.kind === "vline" ? { ...item, x: Number.isFinite(Number(event.target.value)) && event.target.value.trim() !== "" ? Number(event.target.value) : event.target.value } : item) })} /> : null}
          {note.kind !== "band" ? (
            <FieldSelect label="Line style" value={note.style} options={[{ value: "solid", label: "Solid" }, { value: "dashed", label: "Dashed" }, { value: "dotted", label: "Dotted" }, { value: "dashdot", label: "Dash-dot" }]} onChange={(value) => update({ annotations: config.annotations.map((item) => item.id === note.id && item.kind !== "band" ? { ...item, style: value as typeof item.style } : item) })} />
          ) : null}
          {note.kind === "linear" ? (
            <div className="flex gap-1">
              <input className="field" aria-label="Slope" type="number" value={note.m} onChange={(event) => update({ annotations: config.annotations.map((item) => item.id === note.id && item.kind === "linear" ? { ...item, m: Number(event.target.value) } : item) })} />
              <input className="field" aria-label="Intercept" type="number" value={note.c} onChange={(event) => update({ annotations: config.annotations.map((item) => item.id === note.id && item.kind === "linear" ? { ...item, c: Number(event.target.value) } : item) })} />
            </div>
          ) : null}
          {note.kind === "band" ? (
            <div className="flex gap-1">
              <input className="field" aria-label="Band from" type="number" value={note.from} onChange={(event) => update({ annotations: config.annotations.map((item) => item.id === note.id && item.kind === "band" ? { ...item, from: Number(event.target.value) } : item) })} />
              <input className="field" aria-label="Band to" type="number" value={note.to} onChange={(event) => update({ annotations: config.annotations.map((item) => item.id === note.id && item.kind === "band" ? { ...item, to: Number(event.target.value) } : item) })} />
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function CodeTab({ code, onChange, onRun, onExport, preview, errorText, datasetName }: { code: string; onChange: (value: string) => void; onRun: () => void; onExport: (format: "png" | "pdf") => void; preview: string | null; errorText: string; datasetName?: string }) {
  return (
    <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-2" data-plot-code>
      <div className="flex min-h-0 flex-col gap-2 rounded-xl border border-line bg-panel p-3">
        <p className="shrink-0 text-[12px] text-muted">load({datasetName ? `"${datasetName}"` : '"name"'}) reads the dataset on this plot. No file path is shown. save() or plt.show() captures the figure.</p>
        <div className="min-h-[280px] flex-1">
          <CodePane value={code} onChange={onChange} />
        </div>
        <button type="button" className="btn-primary shrink-0 self-start" onClick={onRun}>Run</button>
        {errorText ? <pre className="shrink-0 whitespace-pre-wrap text-[12px] text-danger">{errorText}</pre> : null}
      </div>
      <div className="flex min-h-0 flex-col gap-2 rounded-xl border border-line bg-panel p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[13px] font-medium">Figure</span>
          <div className="flex gap-1">
            <button type="button" className="btn" onClick={() => onExport("png")}>PNG</button>
            <button type="button" className="btn" onClick={() => onExport("pdf")}>PDF</button>
          </div>
        </div>
        {preview ? <img src={preview} alt="Figure from the script" data-plot-figure className="min-h-0 w-full flex-1 rounded-md border border-line object-contain" /> : <p className="text-[13px] text-muted">Run the script to draw the figure here.</p>}
      </div>
    </div>
  );
}

function ExportTab({
  config,
  update,
  datasetName,
  columns,
  onPng,
  onSvg,
  onCsv,
  onCopy,
  onServer,
}: {
  config: PlotConfig;
  update: (patch: Partial<PlotConfig>) => void;
  datasetName: string;
  columns: PlotColumn[];
  onPng: (ratio: number) => Promise<void>;
  onSvg: () => Promise<void>;
  onCsv: () => void;
  onCopy: () => Promise<void>;
  onServer: (format: "png" | "svg" | "pdf" | "eps", source: string) => Promise<void>;
}) {
  const [dpi, setDpi] = useState(300);
  const theme = usePlotTheme();
  const source = matplotlibSource({ datasetName, columns, config, accent: theme.accent, dark: theme.dark });
  return (
    <div className="space-y-3" data-plot-export>
      <p className="text-[12px] text-muted">Matplotlib export. Size is in inches.</p>
      <div className="flex gap-2">
        <label className="text-[12px] text-muted">Width (in)
          <input type="number" min={1} max={12} step={0.05} className="field mt-1 w-full" aria-label="Width inches" value={config.widthIn} onChange={(event) => update({ figure: "custom", widthIn: Number(event.target.value) })} />
        </label>
        <label className="text-[12px] text-muted">Height (in)
          <input type="number" min={1} max={12} step={0.05} className="field mt-1 w-full" aria-label="Height inches" value={config.heightIn} onChange={(event) => update({ figure: "custom", heightIn: Number(event.target.value) })} />
        </label>
      </div>
      <FieldSelect label="Figure font" value={config.fontFamily} options={[{ value: "serif", label: "Serif" }, { value: "sans", label: "Sans" }]} onChange={(value) => update({ fontFamily: value as PlotConfig["fontFamily"] })} />
      <div className="flex flex-wrap gap-1">
        <button type="button" className="btn" onClick={() => void onPng(1)}>PNG 1×</button>
        <button type="button" className="btn" onClick={() => void onPng(2)}>PNG 2×</button>
        <button type="button" className="btn" onClick={() => void onPng(4)}>PNG 4×</button>
        <button type="button" className="btn" onClick={() => void onSvg()}>SVG</button>
        <button type="button" className="btn" onClick={onCsv}>CSV</button>
        <button type="button" className="btn" onClick={() => void onCopy()}>Copy image</button>
      </div>
      <label className="flex items-center gap-2">DPI
        <input type="number" min={72} max={600} className="field w-20" aria-label="DPI" value={dpi} onChange={(event) => setDpi(Number(event.target.value))} />
        <button type="button" className="btn" onClick={() => void onPng(Math.max(1, dpi / 96))}>PNG at {dpi} DPI</button>
      </label>
      <div className="flex flex-wrap gap-1">
        <button type="button" className="btn" onClick={() => void onServer("pdf", source)}>Matplotlib PDF</button>
        <button type="button" className="btn" onClick={() => void onServer("svg", source)}>Matplotlib SVG</button>
        <button type="button" className="btn" onClick={() => void onServer("png", source)}>Matplotlib PNG</button>
        <button type="button" className="btn" onClick={() => void onServer("eps", source)}>EPS</button>
      </div>
      <pre className="max-h-64 overflow-auto whitespace-pre rounded-md border border-line bg-raised p-2.5 font-mono text-[11px] leading-5">{source}</pre>
      <button type="button" className="btn" onClick={() => void navigator.clipboard.writeText(source)}>Copy matplotlib</button>
    </div>
  );
}
