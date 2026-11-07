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
import { FigureBesideToggle, FigureOutput, RunButton, useFigureBeside, useFigureRun } from "@/components/plots/figure-run";
import { SplitHandle, useSplit } from "@/components/plots/split";
import { plotTileMenu } from "@/components/plots/tile-menu";
import { openContextMenu } from "@/components/context-menu/menu-store";
import { canvasSource } from "@/lib/plots/tile-code";
import { InfoTip, InlineEdit, Popover } from "@/components/ui";
import "./plots.css";
import { Check, ChevronDown, Code2, Download, Eye, GripVertical, LayoutGrid, Link2, Maximize2, Plus, Trash2, Upload, X } from "lucide-react";
import { readPlotTheme, seriesSwatchColor, usePlotTheme } from "@/lib/plots/theme";
import { api } from "@/lib/api";
import { PLOTS_WORKSPACE_KEY, plotsWorkspaceOwner, readPlotsWorkspaceCache, writePlotsWorkspaceCache } from "@/lib/tab-session";
import { useToast } from "@/components/toast";
import { useSpaceAccess } from "@/lib/access";
import { ShareButton } from "@/components/sharing/share-dialog";

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

/** `PUT /api/plots/workspace` refuses a longer script, and the whole canvas would stop saving. */
const MAX_CANVAS_CODE = 100_000;
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

type SharedPlots = { spaceId: string; role: "view" | "edit" };

function PlotWorkspaceInner({ shared }: { shared?: SharedPlots }) {
  const toast = useToast();
  const client = useQueryClient();
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000, enabled: !shared });
  const userId = shell.data?.space?.id ?? shell.data?.user.id ?? null;
  const access = useSpaceAccess();
  // One plot space shared with you: that space only, and changes only with edit access.
  const readOnly = shared ? shared.role !== "edit" : !access.canEdit;
  const [spaceId, setSpaceId] = useState<string | undefined>(() => shared?.spaceId ?? (typeof window === "undefined" ? undefined : new URLSearchParams(window.location.search).get("space") ?? undefined));
  const spaces = useQuery({ queryKey: ["plots"], queryFn: api.plots, enabled: !shared });
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
    if (!hydrated.current || !fromServer.current || !config || !workspaceId || switching || readOnly) return;
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
  }, [config, code, workspaceId, switching, toast, readOnly]);

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
  // Keyed on the tile without its code, so typing in its Code tab does not rebuild the chart's table.
  const focusedSettings = focused ? JSON.stringify({ ...focused, code: null }) : null;
  const canvasLinks = config?.links;
  const focusedView = useMemo(
    () => (focusedSettings && canvasLinks ? chartFrame(datasets, JSON.parse(focusedSettings) as WorkspaceTile, canvasLinks) : null),
    [focusedSettings, datasets, canvasLinks],
  );
  tilesRef.current = config?.tiles ?? [];
  const theme = usePlotTheme();
  const canvasRun = useFigureRun(workspaceId);
  const [figureBeside, setFigureBeside] = useFigureBeside();
  const codeRow = useRef<HTMLDivElement>(null);
  const [codeShare, setCodeShare, codeDefault] = useSplit("ensemble.plots.codeShare", 0.55);
  // Only while the Code view or the export is open: the script embeds every tile's table.
  const canvasDefault = useMemo(
    () => (config && (codeOpen || exportOpen) ? canvasSource(config.tiles, { datasets, links: config.links, accent: theme.accent, dark: theme.dark }) : ""),
    [config, codeOpen, exportOpen, datasets, theme.accent, theme.dark],
  );
  const canvasEdited = code !== "" && code !== canvasDefault;
  const canvasCode = code || canvasDefault;

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
        annotations: choice.id === "reliability" ? [{ id: "diag", kind: "linear", m: 1, c: 0, label: "ideal", color: readPlotTheme().muted, style: "dashed" }] : [],
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

  // A phone has no room for the 12-column grid: tiles stack at full width, in reading order, and keep their saved places.
  const stacked = width > 0 && width < 640;
  const cell = stacked ? width / 12 : Math.max(48, width / 12);
  cellRef.current = cell;
  const shown = preview ? withPack(config.tiles, preview) : config.tiles;
  const places = new Map<string, { col: number; row: number; w: number; h: number }>();
  if (stacked) {
    let row = 0;
    for (const tile of [...shown].sort((a, b) => a.row - b.row || a.col - b.col)) {
      const h = Math.max(4, Math.min(tile.h, 7));
      places.set(tile.id, { col: 0, row, w: 12, h });
      row += h;
    }
  }
  const height = Math.max(420, shown.reduce((max, tile) => {
    const place = places.get(tile.id) ?? tile;
    return Math.max(max, (place.row + place.h) * ROW);
  }, 0) + 32);
  const showLinks = groups.length > 0 && !linksHidden;

  return (
    <div className="flex h-[calc(100dvh-4.5rem)] min-h-0 flex-col px-4 pb-4 pt-3" data-plot-canvas inert={switching}>
      <header className="pl-topbar">
        <div className="pl-heading">
          {shared ? (
            <h1 className="display pl-title">{title}</h1>
          ) : (
            <>
              <InlineEdit value={title} onSave={(next) => {
                if (!workspaceId) return;
                void api.updatePlot(workspaceId, { title: next }).then(() => {
                  setTitle(next);
                  void client.invalidateQueries({ queryKey: ["plots"] });
                  void client.invalidateQueries({ queryKey: ["entities"] });
                }).catch((error: Error) => toast(error.message, { tone: "error" }));
              }} className="display pl-title" />
              <Popover
                width={260}
                trigger={(open, toggle) => (
                  <button type="button" className="pl-icon-btn" aria-label="Switch plot space" aria-expanded={open} title="Switch space" disabled={switching} onClick={toggle} data-plot-spaces>
                    <ChevronDown size={16} aria-hidden />
                  </button>
                )}
              >
                {(close) => (
                  <div className="p-1" role="menu" aria-label="Plot spaces">
                    <div className="pl-menu-label">Plot spaces</div>
                    {[
                      ...(!(spaces.data?.plots ?? []).some((space) => space.id === workspaceId) ? [{ id: workspaceId ?? "", title }] : []),
                      ...(spaces.data?.plots ?? []).filter((space) => isWorkspace(space.config)),
                    ].map((space) => (
                      <button
                        key={space.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={space.id === workspaceId}
                        className="menu-item text-left" style={{ display: "flex", alignItems: "center", gap: 8 }}
                        onClick={() => { close(); if (space.id !== workspaceId) void openSpace(space.id); }}
                      >
                        <span className="min-w-0 flex-1 truncate">{space.title}</span>
                        {space.id === workspaceId ? <Check size={14} className="shrink-0 text-accent" aria-hidden /> : null}
                      </button>
                    ))}
                    <div className="my-1 border-t border-line" />
                    <button type="button" role="menuitem" className="menu-item text-left" style={{ display: "flex", alignItems: "center", gap: 8 }} onClick={() => { close(); void openSpace(undefined, true); }} data-plot-new-space>
                      <Plus size={14} aria-hidden /> New space
                    </button>
                  </div>
                )}
              </Popover>
            </>
          )}
          {readOnly ? <span className="pl-badge"><Eye size={13} aria-hidden />View only</span> : null}
          {config.sample ? (
            <span className="pl-sample">
              <span className="pl-sample-mark" data-sample-mark>Sample</span>
              <button type="button" className="pl-sample-clear" onClick={() => void clearSample()} data-clear-sample>Clear sample</button>
            </span>
          ) : null}
          {workspaceId && !shared ? <span className="pl-share"><ShareButton target={{ kind: "plot_space", resourceId: workspaceId, title }} /></span> : null}
        </div>
        <div className="pl-actions">
          {showLinks ? (
            <div className="pl-links" data-shared-columns>
              <Popover
                width={360}
                align="right"
                trigger={(_open, toggle) => (
                  <button type="button" className="pl-links-open" onClick={toggle}><Link2 size={13} aria-hidden />Shared columns</button>
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
              <button type="button" className="pl-links-close" aria-label="Dismiss shared columns" onClick={() => setLinksHidden(true)}><X size={13} aria-hidden /></button>
            </div>
          ) : null}
          <div className="pl-seg" role="group" aria-label="View">
            <button type="button" className="pl-seg-btn" aria-pressed={!codeOpen} aria-label="Canvas" title="The tiles" onClick={() => setCodeOpen(false)}><LayoutGrid size={14} aria-hidden /><span className="pl-label">Canvas</span></button>
            <button type="button" className="pl-seg-btn" aria-pressed={codeOpen} aria-label="Code" title="One script for the whole canvas" onClick={() => setCodeOpen(true)}><Code2 size={14} aria-hidden /><span className="pl-label">Code</span></button>
          </div>
          {shared || readOnly ? null : <button type="button" className="pl-btn" aria-label="Upload" title="Add a table: a file, a link or a paste" onClick={() => setUploadOpen(true)} data-plot-upload><Upload size={15} aria-hidden /><span className="pl-label">Upload</span></button>}
          {readOnly ? null : <button type="button" className="pl-btn" disabled={!columns.length} title={columns.length ? "Add a chart to the canvas" : "Upload a table first"} onClick={() => setAddOpen(true)} data-plot-add><Plus size={15} aria-hidden />Add tile</button>}
          <button type="button" className="btn-primary pl-primary" disabled={!config.tiles.length} title={config.tiles.length ? "One figure with every tile, for a paper" : "Add a tile first"} onClick={() => setExportOpen(true)} data-export-figure><Download size={15} aria-hidden />Export<span className="pl-wide"> figure</span></button>
        </div>
      </header>
      {codeOpen ? (
        <div
          ref={codeRow}
          className={figureBeside ? "flex min-h-0 flex-1 flex-col gap-3 overflow-auto lg:flex-row lg:gap-0 lg:overflow-hidden" : "flex min-h-0 flex-1 flex-col gap-3 overflow-auto"}
          style={{ "--code-share": `${codeShare * 100}%` } as React.CSSProperties}
          data-plot-code
          data-code-edited={canvasEdited ? "1" : "0"}
        >
          <div className={`flex min-h-[320px] min-w-0 flex-col gap-2 rounded-xl border border-line bg-panel p-3 ${figureBeside ? "lg:w-[var(--code-share)] lg:shrink-0" : "flex-[3]"}`}>
            <p className="flex shrink-0 items-center gap-1.5 text-[12px] leading-4 text-muted">
              {canvasEdited ? "Edited script" : "Script for the whole canvas"}
              <InfoTip
                label="About the canvas script"
                text={canvasEdited
                  ? "Edited. Export figure offers this script or the tiles."
                  : "Every tile as a panel of one figure. load(\"name\") reads any dataset on this canvas by the name in the column pool, and save() captures the figure."}
              />
            </p>
            <div className="min-h-0 flex-1">
              <CodePane
                value={canvasCode}
                onChange={(value) => {
                  if (value !== canvasDefault && value.length > MAX_CANVAS_CODE) {
                    toast("The canvas script can be up to 100,000 characters. Shorten it, or edit tiles' code on the tiles.", { tone: "error" });
                    return;
                  }
                  setCode(value === canvasDefault ? "" : value);
                }}
                onRun={() => void canvasRun.run(canvasCode)}
                errorLine={canvasRun.state.line}
                errorText={canvasRun.state.error}
                actions={
                  <>
                    <RunButton running={canvasRun.state.status === "running"} disabled={!workspaceId} onRun={() => void canvasRun.run(canvasCode)} />
                    {canvasEdited ? <button type="button" className="btn px-2 py-0.5 text-[12px]" data-plot-code-reset onClick={() => setCode("")}>Reset to generated</button> : null}
                    <FigureBesideToggle beside={figureBeside} onChange={setFigureBeside} />
                  </>
                }
              />
            </div>
          </div>
          {figureBeside ? <SplitHandle container={codeRow} value={codeShare} fallback={codeDefault} side="left" label="Code width" onChange={setCodeShare} className="pl-split-gap hidden lg:block" /> : null}
          <div className={`flex min-h-[260px] min-w-0 flex-col rounded-xl border border-line bg-panel p-3 ${figureBeside ? "lg:flex-1" : "flex-[2]"}`} data-plot-code-preview>
            <FigureOutput state={canvasRun.state} placeholder="Run the script to draw the figure here." />
          </div>
        </div>
      ) : (
        <div ref={canvasRef} className="pl-canvas relative min-h-0 flex-1 overflow-auto" style={{ minHeight: height }} data-packing={preview ? "1" : undefined}>
          {/* Faint dots mark the grid tiles snap to. */}
          <div className="pl-grid relative" style={{ height, backgroundSize: `${cell}px ${ROW}px` }} data-stacked={stacked ? "1" : undefined}>
            {shown.length === 0 && !readOnly ? (
              <div className="pl-empty" data-plot-empty>
                {columns.length ? (
                  <button type="button" className="plot-empty-card" onClick={() => setAddOpen(true)}>
                    <span className="plot-empty-icon" aria-hidden><Plus size={20} /></span>
                    <span className="plot-empty-title">Add your first chart</span>
                    <span className="plot-empty-text">{datasets.length === 1 ? `${datasets[0]?.name ?? "Your table"} is ready` : `${datasets.length} tables are ready`}: {columns.length} columns to plot.</span>
                    <span className="plot-empty-cta" aria-hidden><Plus size={14} />Add tile</span>
                  </button>
                ) : (
                  <button type="button" className="plot-empty-card" onClick={() => setUploadOpen(true)}>
                    <span className="plot-empty-icon" aria-hidden><Upload size={20} /></span>
                    <span className="plot-empty-title">Upload a table</span>
                    <span className="plot-empty-text">CSV, Excel, JSON or Parquet. Every chart on this canvas shares it.</span>
                    <span className="plot-empty-cta" aria-hidden><Upload size={14} />Choose data</span>
                  </button>
                )}
              </div>
            ) : null}
            {ghost ? (
              <div
                data-tile-ghost
                className="pointer-events-none absolute rounded-xl border-2 border-dashed"
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
                menu={{ workspaceId, canvasTitle: title, readOnly }}
                onDuplicate={() => {
                  const id = Math.random().toString(36).slice(2, 10);
                  setConfig((current) => {
                    if (!current) return current;
                    const packed = placeNew(packOf(current.tiles), id, tile.w, tile.h);
                    const spot = packed.find((item) => item.id === id)!;
                    const copy = tileSchema.parse({ ...tile, id, col: spot.x, row: spot.y, title: tile.title ? `${tile.title} copy` : "" });
                    return { ...current, tiles: withPack([...current.tiles, copy], packed) };
                  });
                  setSelected(id);
                }}
                onDelete={() => {
                  setConfig((current) => (current ? { ...current, tiles: current.tiles.filter((item) => item.id !== tile.id) } : current));
                  if (selected === tile.id) setSelected(null);
                  toast(`Removed ${tile.title || "chart"}.`, { action: { label: "Undo", run: () => {
                    setConfig((current) => {
                      if (!current || current.tiles.some((item) => item.id === tile.id)) return current;
                      const position = placeNew(packOf(current.tiles), tile.id, tile.w, tile.h).find((item) => item.id === tile.id)!;
                      return { ...current, tiles: [...current.tiles, { ...tile, col: position.x, row: position.y }] };
                    });
                  } } });
                }}
                onChange={(next) => setConfig((current) => (current ? { ...current, tiles: current.tiles.map((item) => (item.id === next.id ? next : item)) } : current))}
                onLayout={layoutTiles}
                onGesture={stacked ? () => undefined : gesture}
                place={places.get(tile.id)}
                siblings={packOf(config.tiles)}
              />
            ))}
          </div>
        </div>
      )}
      {focused && focusedView ? (
        <FocusEditor
          key={focused.id}
          tile={focused}
          columns={columns}
          frame={focusedView.frame}
          config={focusedView.config}
          warnings={focusedView.warnings}
          datasets={datasets}
          links={config.links}
          workspaceId={workspaceId}
          onChange={(next) => setConfig((current) => (current ? { ...current, tiles: current.tiles.map((item) => (item.id === next.id ? next : item)) } : current))}
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
      <ExportDialog open={exportOpen} workspaceId={workspaceId} tiles={config.tiles} datasets={datasets} links={config.links} canvasCode={canvasEdited ? code : null} onClose={() => setExportOpen(false)} />
    </div>
  );
}

export function PlotWorkspace({ shared }: { shared?: SharedPlots } = {}) {
  return (
    <PlotBoundary>
      <PlotWorkspaceInner shared={shared} />
    </PlotBoundary>
  );
}

function TileChart({ tile, datasets, links, onOpen }: { tile: WorkspaceTile; datasets: PoolDataset[]; links: WorkspaceConfig["links"]; onOpen: () => void }) {
  const settings = JSON.stringify({ ...tile, code: null });
  const view = useMemo(() => {
    const drawn = JSON.parse(settings) as WorkspaceTile;
    const next = chartFrame(datasets, drawn, links);
    next.config.series = next.config.series.map((series, index) => ({
      ...series,
      color: drawn.series[index]?.color ?? series.color,
      lineStyle: drawn.series[index]?.lineStyle ?? series.lineStyle,
    }));
    return next;
  }, [settings, datasets, links]);
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
  onDuplicate,
  menu,
  onChange,
  onLayout,
  onGesture,
  place,
}: {
  /** Where the tile is drawn when it is not its saved place (stacked on a phone). */
  place?: { col: number; row: number; w: number; h: number };
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
  onDuplicate: () => void;
  menu: { workspaceId: string | null; canvasTitle: string; readOnly: boolean };
  onChange: (tile: WorkspaceTile) => void;
  onLayout: (packed: Array<{ id: string; x: number; y: number; w: number; h: number }>) => void;
  onGesture: (id: string, mode: "move" | "resize", event: React.PointerEvent) => void;
}) {
  const theme = usePlotTheme();
  const toast = useToast();
  const box = place ?? tile;
  return (
    <article
      data-cm-touch=""
      onContextMenu={(event) =>
        openContextMenu(event, () => {
          onSelect();
          return plotTileMenu({ tile, datasets, links, theme, ...menu, open: onOpen, duplicate: onDuplicate, remove: onDelete, toast });
        })
      }
      className={`plot-tile absolute flex flex-col overflow-hidden ${selected ? "is-selected" : ""}`}
      style={{
        left: box.col * cell + GUTTER / 2,
        top: box.row * ROW + GUTTER / 2,
        width: Math.max(0, box.w * cell - GUTTER),
        height: Math.max(0, box.h * ROW - GUTTER),
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
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter") { event.preventDefault(); onOpen(); }
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
      <header className="pl-tile-head" onPointerDown={(event) => onGesture(tile.id, "move", event)}>
        <GripVertical size={14} aria-hidden className="pl-grip" />
        <span className="pl-tile-title" title={tile.title || tile.chart}>{tile.title || tile.chart}</span>
        {tile.code !== null ? <span className="pl-chip" title="Exports draw this tile's edited code" data-tile-code-edited><Code2 size={11} aria-hidden />Code</span> : null}
        <span className="tile-tools pl-tile-tools" onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" className="pl-icon-btn is-small" aria-label={`Open ${tile.title || tile.chart}`} title="Open (Enter)" onClick={onOpen}><Maximize2 size={14} aria-hidden /></button>
          <button type="button" className="pl-icon-btn is-small is-danger" aria-label={`Delete ${tile.title || tile.chart}`} title="Delete" onClick={onDelete}><Trash2 size={14} aria-hidden /></button>
        </span>
      </header>
      {selected ? (
        <div className="pl-tweak" data-quick-tweak>
          <input className="pl-tweak-title" aria-label="Tile title" value={tile.title} onChange={(event) => onChange({ ...tile, title: event.target.value })} />
          <label className="pl-swatch" title="Series colour">
            <input type="color" aria-label="Series colour" value={seriesSwatchColor({ palette: tile.palette, series: tile.series, colors: {} }, 0, theme)} onChange={(event) => onChange({ ...tile, series: tile.series.map((series, index) => index === 0 ? { ...series, color: event.target.value } : series) })} />
          </label>
          <button type="button" className="pl-toggle" aria-pressed={tile.series[0]?.lineStyle === "dashed"} onClick={() => onChange({ ...tile, series: tile.series.map((series, index) => index === 0 ? { ...series, lineStyle: series.lineStyle === "dashed" ? "solid" : "dashed" } : series) })}>
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden><path d="M2 8 H14" stroke="currentColor" strokeWidth="1.8" strokeDasharray="3 2.2" /></svg>
            Dashed
          </button>
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <TileChart tile={tile} datasets={datasets} links={links} onOpen={onOpen} />
      </div>
      <button type="button" aria-label="Resize tile" data-tile-resize className="tile-tools pl-resize" onPointerDown={(event) => { event.stopPropagation(); onGesture(tile.id, "resize", event); }}>
        <svg viewBox="0 0 10 10" className="h-2.5 w-2.5" aria-hidden><path d="M9 3 3 9M9 6.5 6.5 9" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
      </button>
    </article>
  );
}
