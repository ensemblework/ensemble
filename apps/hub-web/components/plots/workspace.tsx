"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  chartFrame,
  duplicateGroups,
  moveItem,
  placeNew,
  poolColumns,
  resizeItem,
  tileSchema,
  workspaceBoilerplate,
  workspaceSchema,
  emptyWorkspace,
  isWorkspace,
  type LinkChoice,
  type PackItem,
  type PoolDataset,
  type WorkspaceConfig,
  type WorkspaceTile,
} from "@ensemble/shared-types";
import { AddTileDialog } from "@/components/plots/add-tile";
import { UploadDialog } from "@/components/plots/upload-dialog";
import { ExportDialog } from "@/components/plots/export-dialog";
import { InlineEdit, Popover } from "@/components/ui";
import { seriesSwatchColor, usePlotTheme } from "@/lib/plots/theme";
import { api } from "@/lib/api";
import { PLOTS_WORKSPACE_KEY, plotsWorkspaceOwner, readPlotsWorkspaceCache, writePlotsWorkspaceCache } from "@/lib/tab-session";
import { useToast } from "@/components/toast";

const CodePane = dynamic(() => import("./code-pane").then((mod) => mod.PlotCodePane), { ssr: false });
const ChartView = dynamic(() => import("./chart-view").then((mod) => mod.ChartView), { ssr: false });
const FocusEditor = dynamic(() => import("./focus-editor").then((mod) => mod.FocusEditor), { ssr: false });

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The plots workspace took too long to answer.")), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const ROW = 78;
const GUTTER = 12;

function packOf(tiles: WorkspaceTile[]) {
  return tiles.map((tile) => ({ id: tile.id, x: tile.col, y: tile.row, w: tile.w, h: tile.h }));
}

function withPack(tiles: WorkspaceTile[], packed: Array<{ id: string; x: number; y: number; w: number; h: number }>): WorkspaceTile[] {
  return tiles.map((tile) => {
    const item = packed.find((entry) => entry.id === tile.id);
    return item ? { ...tile, col: item.x, row: item.y, w: item.w, h: item.h } : tile;
  });
}

class PlotBoundary extends Component<{ children: ReactNode }, { message: string | null }> {
  state = { message: null as string | null };
  static getDerivedStateFromError(error: Error) {
    return { message: error.message || "The canvas didn’t open." };
  }
  render() {
    if (!this.state.message) return this.props.children;
    return (
      <div className="px-8 py-8" data-plot-error>
        <p className="text-[14px] font-medium text-ink">The canvas didn’t open.</p>
        <p className="mt-1 max-w-md text-[13px] text-muted">{this.state.message}</p>
        <button type="button" className="btn mt-3" onClick={() => this.setState({ message: null })}>
          Try again
        </button>
      </div>
    );
  }
}

function PlotWorkspaceInner() {
  const toast = useToast();
  const client = useQueryClient();
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000 });
  const userId = shell.data?.space?.id ?? shell.data?.user.id ?? null;
  const [spaceId, setSpaceId] = useState<string | undefined>(() => typeof window === "undefined" ? undefined : new URLSearchParams(window.location.search).get("space") ?? undefined);
  const spaces = useQuery({ queryKey: ["plots"], queryFn: api.plots });
  const workspace = useQuery({
    queryKey: ["plot-workspace", spaceId],
    queryFn: () => withTimeout(api.plotWorkspace(spaceId), 12_000),
    retry: 1,
    networkMode: "always",
    staleTime: 30_000,
    placeholderData: () => (typeof window === "undefined" || spaceId ? undefined : readPlotsWorkspaceCache(window.sessionStorage, userId)),
  });
  const [config, setConfig] = useState<WorkspaceConfig | null>(null);
  const [code, setCode] = useState("");
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [title, setTitle] = useState("Plots");
  const [switching, setSwitching] = useState(false);
  const saveFlight = useRef(Promise.resolve());
  const [uploadOpen, setUploadOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(() => typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("tile"));
  const [codeOpen, setCodeOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [linksHidden, setLinksHidden] = useState(false);
  const [preview, setPreview] = useState<PackItem[] | null>(null);
  const [ghost, setGhost] = useState<PackItem | null>(null);
  const hydrated = useRef(false);
  const fromServer = useRef(false);
  const savedSnapshot = useRef("");
  const canvasRef = useRef<HTMLDivElement>(null);
  const tilesRef = useRef<WorkspaceTile[]>([]);
  const cellRef = useRef(80);
  const [width, setWidth] = useState(960);

  useEffect(() => {
    const owner = typeof window === "undefined" ? null : plotsWorkspaceOwner(window.sessionStorage);
    if (userId && owner && owner !== userId) {
      try {
        sessionStorage.removeItem(PLOTS_WORKSPACE_KEY);
      } catch {
        // private mode
      }
      hydrated.current = false;
      fromServer.current = false;
      void client.resetQueries({ queryKey: ["plot-workspace"] });
      return;
    }
    const row = workspace.data?.workspace;
    if (!row) return;
    if (workspace.isFetched) fromServer.current = true;
    if (hydrated.current && !workspace.isFetched) return;
    const parsed = workspaceSchema.safeParse(row.config);
    const nextConfig = parsed.success ? parsed.data : emptyWorkspace();
    const nextCode = row.code || "";
    savedSnapshot.current = JSON.stringify({ config: nextConfig, code: nextCode });
    setConfig(nextConfig);
    setCode(nextCode);
    setWorkspaceId(row.id);
    setTitle(row.title);
    hydrated.current = true;
    if (!workspace.isFetched || !workspace.data) return;
    writePlotsWorkspaceCache(window.sessionStorage, userId, workspace.data);
  }, [workspace.data, workspace.isFetched, client, userId]);

  useEffect(() => {
    if (!config) return;
    const warm = () => {
      void import("echarts");
    };
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(warm, { timeout: 1200 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(warm, 180);
    return () => window.clearTimeout(id);
  }, [config]);

  useEffect(() => {
    const node = canvasRef.current;
    if (!node) return;
    const measure = () => setWidth(node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [config]);

  useEffect(() => {
    if (!hydrated.current || !fromServer.current || !config || !workspaceId || switching) return;
    const snapshot = JSON.stringify({ config, code });
    if (snapshot === savedSnapshot.current) return;
    const timer = window.setTimeout(() => {
      savedSnapshot.current = snapshot;
      saveFlight.current = saveFlight.current.then(async () => {
        await api.savePlotWorkspace({ id: workspaceId, config, code });
      }).catch((error: Error) => {
        savedSnapshot.current = "";
        toast(error.message, { tone: "error" });
      });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [config, code, workspaceId, switching, toast]);

  const openSpace = async (id?: string, create = false) => {
    if (switching) return;
    setSwitching(true);
    try {
      await saveFlight.current;
      if (workspaceId && config) await api.savePlotWorkspace({ id: workspaceId, config, code });
      const nextId = create ? (await api.createPlotSpace()).plot.id : id;
      hydrated.current = false;
      fromServer.current = false;
      savedSnapshot.current = "";
      setConfig(null);
      setWorkspaceId(null);
      setSelected(null);
      setFocus(null);
      setSpaceId(nextId);
      await client.invalidateQueries({ queryKey: ["plots"] });
      await client.invalidateQueries({ queryKey: ["entities"] });
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not open this plot space.", { tone: "error" });
    } finally {
      setSwitching(false);
    }
  };

  const ids = config?.datasetIds ?? [];
  const idsKey = ids.join(",");
  const seenIds = useRef<string | null>(null);
  useEffect(() => {
    if (seenIds.current === null) {
      seenIds.current = idsKey;
      return;
    }
    if (seenIds.current !== idsKey) {
      seenIds.current = idsKey;
      setLinksHidden(false);
    }
  }, [idsKey]);

  const tables = useQuery({
    queryKey: ["plot-workspace-tables", idsKey],
    enabled: ids.length > 0,
    queryFn: async () => {
      const rows = await Promise.all(ids.map((id) => api.plotDataset(id, true)));
      return rows.map((row) => row.dataset);
    },
  });
  const datasets = (tables.data ?? []) as PoolDataset[];
  const groups = useMemo(() => duplicateGroups(datasets), [datasets]);
  const columns = useMemo(() => poolColumns(datasets, config?.links ?? {}), [datasets, config?.links]);
  const focused = config?.tiles.find((tile) => tile.id === focus) ?? null;
  const focusedView = useMemo(
    () => (focused && config ? chartFrame(datasets, focused, config.links) : null),
    [focused, datasets, config],
  );
  tilesRef.current = config?.tiles ?? [];

  const update = (patch: Partial<WorkspaceConfig>) => setConfig((current) => (current ? { ...current, ...patch } : current));

  const clearSample = async () => {
    if (!config?.sample) return;
    const previous = config.datasetIds;
    setConfig(workspaceSchema.parse({ kind: "workspace", tiles: [], datasetIds: [], links: {}, sample: false }));
    setSelected(null);
    setFocus(null);
    await Promise.all(previous.map((id) => api.deletePlotDataset(id).catch(() => undefined)));
    await client.invalidateQueries({ queryKey: ["plot-workspace-tables"] });
  };

  const addTile = (
    choice: { chart: WorkspaceTile["chart"]; paper: WorkspaceTile["paper"]; label: string; xLog?: boolean; yLog?: boolean; error?: "bar" | "band"; id: string },
    xRef: string | null,
    yRefs: string[],
    errorRef: string | null,
    seedRef: string | null,
  ) => {
    const id = Math.random().toString(36).slice(2, 10);
    setConfig((current) => {
      if (!current) return current;
      const packed = placeNew(packOf(current.tiles), id, 6, 4);
      const spot = packed.find((item) => item.id === id)!;
      const tile = tileSchema.parse({
        id,
        col: spot.x,
        row: spot.y,
        w: spot.w,
        h: spot.h,
        chart: choice.chart,
        paper: choice.paper,
        xLog: Boolean(choice.xLog),
        yLogLeft: Boolean(choice.yLog),
        xRef,
        yRefs,
        errorRef,
        seedRef,
        title: choice.label,
        annotations: choice.id === "reliability" ? [{ id: "diag", kind: "linear", m: 1, c: 0, label: "ideal", color: "#888888", style: "dashed" }] : [],
        series: yRefs.map(() => ({ y: "y", axis: "left" as const, ...(choice.error ? { errorKind: choice.error } : {}) })),
      });
      return { ...current, tiles: withPack([...current.tiles, tile], packed) };
    });
    setSelected(id);
  };

  const layoutTiles = (packed: ReturnType<typeof packOf>) => {
    setPreview(null);
    setGhost(null);
    setConfig((current) => (current ? { ...current, tiles: withPack(current.tiles, packed) } : current));
  };

  const gesture = (id: string, mode: "move" | "resize", event: React.PointerEvent) => {
    if (mode === "move" && (event.target as HTMLElement).closest("button, input, select")) return;
    event.preventDefault();
    const items = packOf(tilesRef.current);
    const origin = items.find((item) => item.id === id);
    if (!origin) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const cellNow = cellRef.current;
    let frame = 0;
    const placed = (dx: number, dy: number) => (
      mode === "move"
        ? moveItem(items, id, origin.x + Math.round(dx / cellNow), origin.y + Math.round(dy / ROW))
        : resizeItem(items, id, origin.w + Math.round(dx / cellNow), origin.h + Math.round(dy / ROW))
    );
    const move = (ev: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const packed = placed(ev.clientX - startX, ev.clientY - startY);
        setPreview(packed);
        setGhost(packed.find((item) => item.id === id) ?? null);
      });
    };
    const up = (ev: PointerEvent) => {
      cancelAnimationFrame(frame);
      layoutTiles(placed(ev.clientX - startX, ev.clientY - startY));
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  if (!config) {
    if (workspace.isError || (workspace.isFetched && !workspace.data?.workspace)) {
      const detail = workspace.error instanceof Error ? workspace.error.message : "The plots workspace did not load.";
      return (
        <div className="px-8 py-8" data-plot-error>
          <p className="text-[14px] font-medium text-ink">The canvas didn’t open.</p>
          <p className="mt-1 max-w-md text-[13px] text-muted">{detail}</p>
          <button type="button" className="btn mt-3" onClick={() => void workspace.refetch()}>
            Try again
          </button>
        </div>
      );
    }
    return <div className="px-8 py-8 text-[13px] text-muted">Opening the canvas…</div>;
  }

  const cell = Math.max(48, width / 12);
  cellRef.current = cell;
  const shown = preview ? withPack(config.tiles, preview) : config.tiles;
  const height = Math.max(420, shown.reduce((max, tile) => Math.max(max, (tile.row + tile.h) * ROW), 0) + 32);
  const showLinks = groups.length > 0 && !linksHidden;

  return (
    <div className="flex h-[calc(100dvh-4.5rem)] min-h-0 flex-col px-4 pb-4 pt-3" data-plot-canvas inert={switching}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <InlineEdit value={title} onSave={(next) => {
          if (!workspaceId) return;
          void api.updatePlot(workspaceId, { title: next }).then(() => {
            setTitle(next);
            void client.invalidateQueries({ queryKey: ["plots"] });
            void client.invalidateQueries({ queryKey: ["entities"] });
          }).catch((error: Error) => toast(error.message, { tone: "error" }));
        }} className="display text-[28px] leading-none" />
        <select aria-label="Plot space" className="field mr-auto max-w-48 text-[13px]" disabled={switching} value={workspaceId ?? ""} onChange={(event) => void openSpace(event.target.value)}>
          {!(spaces.data?.plots ?? []).some((space) => space.id === workspaceId) ? <option value={workspaceId ?? ""}>{title}</option> : null}
          {(spaces.data?.plots ?? []).filter((space) => isWorkspace(space.config)).map((space) => <option key={space.id} value={space.id}>{space.title}</option>)}
        </select>
        <button type="button" className="btn" disabled={switching} onClick={() => void openSpace(undefined, true)}>New space</button>
        {config.sample ? (
          <>
            <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-accent" data-sample-mark>Sample</span>
            <button type="button" className="btn" onClick={() => void clearSample()} data-clear-sample>Clear sample</button>
          </>
        ) : null}
        {showLinks ? (
          <div className="inline-flex items-center gap-1 rounded-full border border-line bg-panel pl-1" data-shared-columns>
            <Popover
              width={360}
              align="right"
              trigger={(_open, toggle) => (
                <button type="button" className="rounded-full px-2 py-1 text-[12px]" onClick={toggle}>Shared columns</button>
              )}
            >
              {() => (
                <div className="space-y-1 p-1 text-[13px]" style={{ background: "var(--panel)" }}>
                  <p className="px-1 text-[12px] text-muted">A key can join files. A measure should stay separate.</p>
                  {groups.map((group) => {
                    const choice: LinkChoice = config.links[group.name] === "join" && group.sameType ? "join" : "separate";
                    return (
                      <div key={group.name} className="flex flex-wrap items-center gap-2 py-1">
                        <span className="font-medium">{group.name}</span>
                        <button type="button" className={`rounded-md px-2 py-1 ${choice === "separate" ? "bg-accent-soft" : "text-muted"}`} aria-pressed={choice === "separate"} onClick={() => update({ links: { ...config.links, [group.name]: "separate" } })}>Keep separate</button>
                        <button type="button" className={`rounded-md px-2 py-1 ${choice === "join" ? "bg-accent-soft" : "text-muted"}`} aria-pressed={choice === "join"} disabled={!group.sameType} onClick={() => update({ links: { ...config.links, [group.name]: "join" } })}>Join on this column</button>
                        {!group.sameType ? <span className="text-[12px] text-faint">Types differ, so this cannot be a key.</span> : <span className="text-[12px] text-faint">{group.columns.map((column) => column.source).join(" · ")}</span>}
                      </div>
                    );
                  })}
                </div>
              )}
            </Popover>
            <button type="button" className="rounded-full px-2 py-1 text-[12px] text-muted" aria-label="Dismiss shared columns" onClick={() => setLinksHidden(true)}>×</button>
          </div>
        ) : null}
        <button type="button" className="btn" onClick={() => setUploadOpen(true)} data-plot-upload>Upload</button>
        <button type="button" className="btn" onClick={() => setAddOpen(true)} data-plot-add>Add tile</button>
        <button type="button" className="btn" onClick={() => setCodeOpen((open) => !open)}>Code</button>
        <button type="button" className="btn-primary" onClick={() => setExportOpen(true)} data-export-figure>Export figure</button>
      </div>
      {codeOpen ? (
        <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-2" data-plot-code>
          <div className="min-h-0 rounded-xl border border-line bg-panel p-3">
            <CodePane value={code || workspaceBoilerplate(datasets.map((dataset) => dataset.name))} onChange={setCode} />
          </div>
          <p className="text-[13px] text-muted">load(&quot;name&quot;) reads any dataset on this canvas. save() captures the figure.</p>
        </div>
      ) : (
        <div ref={canvasRef} className="relative min-h-0 flex-1 overflow-auto rounded-xl border border-line bg-bg" style={{ minHeight: height }} data-packing={preview ? "1" : undefined}>
          <div className="relative" style={{ height }}>
            {shown.length === 0 ? (
              <div className="absolute left-1/2 top-16 flex w-[min(420px,90%)] -translate-x-1/2 flex-col gap-3">
                <button type="button" className="rounded-xl border border-dashed border-line px-6 py-10 text-left" onClick={() => setUploadOpen(true)}>
                  <span className="display block text-[24px] leading-none">Upload a table</span>
                  <span className="mt-2 block text-[13px] text-muted">Data is shared by every tile. Then add a chart from the gallery.</span>
                </button>
              </div>
            ) : null}
            {ghost ? (
              <div
                data-tile-ghost
                className="pointer-events-none absolute rounded-xl border border-dashed"
                style={{
                  left: ghost.x * cell + GUTTER / 2,
                  top: ghost.y * ROW + GUTTER / 2,
                  width: Math.max(0, ghost.w * cell - GUTTER),
                  height: Math.max(0, ghost.h * ROW - GUTTER),
                  borderColor: "var(--accent)",
                  background: "rgb(var(--accent-rgb) / 0.12)",
                  zIndex: 6,
                }}
              />
            ) : null}
            {shown.map((tile) => (
              <Tile
                key={tile.id}
                tile={tile}
                datasets={datasets}
                links={config.links}
                cell={cell}
                selected={selected === tile.id}
                dragging={ghost?.id === tile.id}
                onSelect={() => setSelected(tile.id)}
                onOpen={() => setFocus(tile.id)}
                onDelete={() => {
                  setConfig((current) => (current ? { ...current, tiles: current.tiles.filter((item) => item.id !== tile.id) } : current));
                  if (selected === tile.id) setSelected(null);
                }}
                onChange={(next) => setConfig((current) => (current ? { ...current, tiles: current.tiles.map((item) => (item.id === next.id ? next : item)) } : current))}
                onLayout={layoutTiles}
                onGesture={gesture}
                siblings={packOf(config.tiles)}
              />
            ))}
          </div>
        </div>
      )}
      {focused && focusedView ? (
        <FocusEditor
          tile={focused}
          columns={columns}
          frame={focusedView.frame}
          config={focusedView.config}
          warnings={focusedView.warnings}
          code={code}
          workspaceId={workspaceId}
          datasetName={datasets.find((dataset) => focused.yRefs[0]?.startsWith(dataset.id))?.name ?? datasets[0]?.name ?? "data"}
          onChange={(next) => setConfig((current) => (current ? { ...current, tiles: current.tiles.map((item) => (item.id === next.id ? next : item)) } : current))}
          onCode={setCode}
          onClose={() => setFocus(null)}
        />
      ) : null}
      <UploadDialog
        open={uploadOpen}
        existing={columns.map((column) => ({ name: column.name, type: column.type, source: column.source ?? "" }))}
        onClose={() => setUploadOpen(false)}
        onAccept={(dataset, links) => {
          setConfig((current) => (current ? { ...current, datasetIds: [...current.datasetIds, dataset.id], links: { ...current.links, ...links } } : current));
          setLinksHidden(false);
          void client.invalidateQueries({ queryKey: ["plot-workspace-tables"] });
        }}
      />
      <AddTileDialog open={addOpen} columns={columns} onClose={() => setAddOpen(false)} onAdd={addTile} />
      <ExportDialog open={exportOpen} workspaceId={workspaceId} tiles={config.tiles} datasets={datasets} links={config.links} onClose={() => setExportOpen(false)} />
    </div>
  );
}

export function PlotWorkspace() {
  return (
    <PlotBoundary>
      <PlotWorkspaceInner />
    </PlotBoundary>
  );
}

function TileChart({ tile, datasets, links, onOpen }: { tile: WorkspaceTile; datasets: PoolDataset[]; links: WorkspaceConfig["links"]; onOpen: () => void }) {
  const view = useMemo(() => {
    const next = chartFrame(datasets, tile, links);
    next.config.series = next.config.series.map((series, index) => ({
      ...series,
      color: tile.series[index]?.color ?? series.color,
      lineStyle: tile.series[index]?.lineStyle ?? series.lineStyle,
    }));
    return next;
  }, [tile, datasets, links]);
  if (!view.frame.columns.length) return <p className="p-4 text-[13px] text-muted">Pick columns for this tile.</p>;
  const hidden = view.warnings.length;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative min-h-0 flex-1">
        <ChartView frame={view.frame} config={view.config} variant="tile" />
      </div>
      {hidden ? (
        <button
          type="button"
          className="h-5 shrink-0 truncate px-2 text-left text-[11px] leading-5 text-warn"
          data-plot-warning
          title={view.warnings.join("\n")}
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
        >
          {hidden === 1 ? "1 series hidden" : `${hidden} series hidden`}
        </button>
      ) : null}
    </div>
  );
}

function Tile({
  tile,
  datasets,
  links,
  cell,
  selected,
  dragging,
  siblings,
  onSelect,
  onOpen,
  onDelete,
  onChange,
  onLayout,
  onGesture,
}: {
  tile: WorkspaceTile;
  datasets: PoolDataset[];
  links: WorkspaceConfig["links"];
  cell: number;
  selected: boolean;
  dragging: boolean;
  siblings: Array<{ id: string; x: number; y: number; w: number; h: number }>;
  onSelect: () => void;
  onOpen: () => void;
  onDelete: () => void;
  onChange: (tile: WorkspaceTile) => void;
  onLayout: (packed: Array<{ id: string; x: number; y: number; w: number; h: number }>) => void;
  onGesture: (id: string, mode: "move" | "resize", event: React.PointerEvent) => void;
}) {
  const theme = usePlotTheme();
  return (
    <article
      className={`plot-tile absolute flex flex-col overflow-hidden rounded-xl border bg-panel shadow-sm ${selected ? "is-selected border-accent" : "border-line"}`}
      style={{
        left: tile.col * cell + GUTTER / 2,
        top: tile.row * ROW + GUTTER / 2,
        width: Math.max(0, tile.w * cell - GUTTER),
        height: Math.max(0, tile.h * ROW - GUTTER),
        zIndex: dragging ? 4 : 2,
      }}
      data-plot-tile={tile.id}
      data-col={tile.col}
      data-row={tile.row}
      data-w={tile.w}
      data-h={tile.h}
      data-dragging={dragging ? "1" : undefined}
      tabIndex={0}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter") onOpen();
        if (event.key === "Delete" || event.key === "Backspace") {
          event.preventDefault();
          onDelete();
        }
        const shift = event.shiftKey;
        const key = event.key;
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(key)) return;
        event.preventDefault();
        if (shift) {
          const dw = key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : 0;
          const dh = key === "ArrowDown" ? 1 : key === "ArrowUp" ? -1 : 0;
          onLayout(resizeItem(siblings, tile.id, tile.w + dw, tile.h + dh));
        } else {
          const dx = key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : 0;
          const dy = key === "ArrowDown" ? 1 : key === "ArrowUp" ? -1 : 0;
          onLayout(moveItem(siblings, tile.id, tile.col + dx, tile.row + dy));
        }
      }}
    >
      <header className="flex shrink-0 cursor-grab items-center gap-2 px-2 py-1" onPointerDown={(event) => onGesture(tile.id, "move", event)}>
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{tile.title || tile.chart}</span>
        <span className="tile-tools flex items-center gap-1">
          <button type="button" className="btn px-2 py-0.5 text-[12px]" onClick={onOpen}>Open</button>
          <button type="button" className="btn px-2 py-0.5 text-[12px]" onClick={onDelete}>Delete</button>
        </span>
      </header>
      {selected ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 px-2 pb-1" data-quick-tweak>
          <input className="field h-7 w-28 text-[12px]" aria-label="Tile title" value={tile.title} onChange={(event) => onChange({ ...tile, title: event.target.value })} />
          <input type="color" aria-label="Series colour" className="h-7 w-8 cursor-pointer rounded border border-line bg-raised" value={seriesSwatchColor({ palette: tile.palette, series: tile.series, colors: {} }, 0, theme)} onChange={(event) => onChange({ ...tile, series: tile.series.map((series, index) => index === 0 ? { ...series, color: event.target.value } : series) })} />
          <button type="button" className="btn px-2 py-0.5 text-[12px]" onClick={() => onChange({ ...tile, series: tile.series.map((series, index) => index === 0 ? { ...series, lineStyle: series.lineStyle === "dashed" ? "solid" : "dashed" } : series) })}>Line</button>
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <TileChart tile={tile} datasets={datasets} links={links} onOpen={onOpen} />
      </div>
      <button type="button" aria-label="Resize tile" data-tile-resize className="tile-tools absolute bottom-0.5 right-0.5 z-[3] grid h-4 w-4 cursor-nwse-resize place-items-center text-faint hover:text-muted" onPointerDown={(event) => { event.stopPropagation(); onGesture(tile.id, "resize", event); }}>
        <svg viewBox="0 0 10 10" className="h-2.5 w-2.5" aria-hidden><path d="M9 3 3 9M9 6.5 6.5 9" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
      </button>
      <style>{`
        .plot-tile { transition: left 160ms ease, top 160ms ease, width 160ms ease, height 160ms ease; }
        [data-packing] .plot-tile { transition: none; }
        .plot-tile[data-dragging] { transition: none; opacity: 0.82; }
        .plot-tile .tile-tools { opacity: 0; }
        .plot-tile:hover .tile-tools, .plot-tile:focus-within .tile-tools, .plot-tile.is-selected .tile-tools { opacity: 1; }
        @media (prefers-reduced-motion: reduce) { .plot-tile { transition: none; } }
      `}</style>
    </article>
  );
}
