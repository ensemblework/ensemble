/**
 * The matplotlib behind the plots canvas (docs/20 Plots): a tile's own script, which an edit takes
 * over from the tile's settings, and the canvas figure with a panel per tile.
 */
import {
  chartFrame,
  matplotlibPanels,
  matplotlibSource,
  parseRef,
  seedSummaryFor,
  workspaceBoilerplate,
  type FigurePanel,
  type LinkChoice,
  type PoolDataset,
  type WorkspaceTile,
} from "@ensemble/shared-types";

type Canvas = { datasets: PoolDataset[]; links: Record<string, LinkChoice>; accent?: string; dark?: boolean };

/** Dataset names as a render loads them: a repeated name is numbered ("runs", "runs 2"), as `GET /api/plots/:id/render-input` does. */
export function loadNames(datasets: Array<{ id: string; name: string }>): Map<string, string> {
  const seen = new Map<string, number>();
  const names = new Map<string, string>();
  for (const dataset of datasets) {
    const count = seen.get(dataset.name) ?? 0;
    seen.set(dataset.name, count + 1);
    names.set(dataset.id, count === 0 ? dataset.name : `${dataset.name} ${count + 1}`);
  }
  return names;
}

function refsOf(tile: WorkspaceTile): string[] {
  return [tile.xRef, ...tile.yRefs, tile.errorRef].filter((ref): ref is string => Boolean(ref));
}

/** A join across files has no single table to load, so its rows go into the script. */
function joined(tile: WorkspaceTile): boolean {
  return refsOf(tile).some((ref) => parseRef(ref).join);
}

function datasetOf(tile: WorkspaceTile, datasets: PoolDataset[]): PoolDataset | undefined {
  const id = refsOf(tile).map((ref) => parseRef(ref).datasetId).find(Boolean);
  return datasets.find((dataset) => dataset.id === id) ?? datasets[0];
}

/** The script that draws this tile as its settings say: its series, axes, labels, title and colours. */
export function tileSource(tile: WorkspaceTile, canvas: Canvas): string {
  const { frame, config } = chartFrame(canvas.datasets, tile, canvas.links);
  const dataset = datasetOf(tile, canvas.datasets);
  const inline = joined(tile);
  const yPart = tile.yRefs[0] ? parseRef(tile.yRefs[0]) : null;
  const summary = !inline && tile.seedRef && yPart
    ? seedSummaryFor({
        columns: dataset?.columns ?? [],
        x: config.x,
        y: yPart.name,
        seed: parseRef(tile.seedRef).name,
        series: config.series,
      })
    : null;
  return matplotlibSource({
    datasetName: (dataset && loadNames(canvas.datasets).get(dataset.id)) ?? "data",
    columns: frame.columns,
    config,
    accent: canvas.accent,
    dark: canvas.dark,
    rows: frame.rows,
    rowColumns: frame.columns.map((column) => column.name),
    summary,
    inline,
  });
}

/** The tile's script that runs and exports: its edit when there is one, else the one its settings make. */
export function tileScript(tile: WorkspaceTile, generated: string): { code: string; edited: boolean } {
  const edited = tile.code !== null && tile.code !== generated;
  return { code: edited ? tile.code! : generated, edited };
}

/** What an edit stores: nothing when the text is the generated script again, so the tile follows its settings. */
export function storedTileCode(value: string, generated: string): string | null {
  return value === generated ? null : value;
}

/**
 * One panel per tile for the canvas figure. A tile with edited code is that code's figure. With
 * `inline`, every panel carries the rows the canvas drew; without it, a panel drawn straight from one
 * file loads that file by name, which keeps the script short enough to read and edit.
 */
export type CanvasPanel = FigurePanel & { id: string; edited: boolean };

export function canvasPanels(tiles: WorkspaceTile[], canvas: Canvas & { inline: boolean }): CanvasPanel[] {
  const names = loadNames(canvas.datasets);
  return tiles.flatMap((tile): CanvasPanel[] => {
    if (tile.code !== null) {
      const script = tileScript(tile, tileSource(tile, canvas));
      if (script.edited) return [{ id: tile.id, edited: true, title: tile.title || "", datasetName: "", x: "", ys: [], chart: tile.chart, code: script.code }];
    }
    const view = chartFrame(canvas.datasets, tile, canvas.links);
    if (!view.config.x || !view.config.series.length) return [];
    const drawn = view.config.series[0];
    const dataset = datasetOf(tile, canvas.datasets);
    const fromFile = !canvas.inline && !tile.seedRef && !joined(tile) && Boolean(dataset);
    return [{
      id: tile.id,
      edited: false,
      title: tile.title || "",
      datasetName: (dataset && names.get(dataset.id)) ?? "data",
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
      ...(fromFile ? {} : { columns: view.frame.columns.map((column) => column.name), rows: view.frame.rows }),
      error: drawn?.error,
      errorKind: drawn?.errorKind,
      series: view.config.series.map((series) => ({ y: series.y, color: series.color, error: series.error, errorKind: series.errorKind })),
    }];
  });
}

/** The canvas script the Code view starts from: every tile as a panel of one figure. */
export function canvasSource(tiles: WorkspaceTile[], canvas: Canvas): string {
  const panels = canvasPanels(tiles, { ...canvas, inline: false });
  if (!panels.length) return workspaceBoilerplate([...loadNames(canvas.datasets).values()]);
  return matplotlibPanels(panels, { accent: canvas.accent, dark: canvas.dark });
}
