import type { ColumnType, PlotColumn, PlotConfig, PlotFilter } from "./plots.js";
import { applyFilter, type Frame } from "./plots-frame.js";
import { defaultPlotConfig } from "./plots.js";

export type PoolDataset = {
  id: string;
  name: string;
  columns: PlotColumn[];
  rows: Array<Array<string | number | null>>;
};

export type LinkChoice = "separate" | "join";

export type DuplicateGroup = {
  name: string;
  columns: Array<{ datasetId: string; source: string; type: ColumnType }>;
  sameType: boolean;
};

export type PoolColumn = {
  id: string;
  name: string;
  type: ColumnType;
  /** Set only when this name exists in more than one file. */
  source: string | null;
  datasetId: string | null;
  join: boolean;
};

/** Unit separator. A null byte cannot be stored in Postgres text or json. */
const SEP = "\u001f";

export function columnRef(datasetId: string, name: string): string {
  return `${datasetId}${SEP}${name}`;
}

export function joinRef(name: string): string {
  return `join${SEP}${name}`;
}

export function parseRef(id: string): { join: boolean; datasetId: string | null; name: string } {
  const [head, name] = id.split(SEP);
  if (head === "join") return { join: true, datasetId: null, name: name ?? "" };
  return { join: false, datasetId: head ?? "", name: name ?? "" };
}

export function duplicateGroups(datasets: PoolDataset[]): DuplicateGroup[] {
  const groups = new Map<string, DuplicateGroup>();
  for (const dataset of datasets) {
    for (const column of dataset.columns) {
      const group = groups.get(column.name) ?? { name: column.name, columns: [], sameType: true };
      group.columns.push({ datasetId: dataset.id, source: dataset.name, type: column.type });
      groups.set(column.name, group);
    }
  }
  return [...groups.values()]
    .filter((group) => group.columns.length > 1)
    .map((group) => ({ ...group, sameType: group.columns.every((column) => column.type === group.columns[0]!.type) }));
}

function label(name: string, source: string, taken: Set<string>): string {
  if (!taken.has(name)) {
    taken.add(name);
    return name;
  }
  const next = `${name} · ${source}`;
  taken.add(next);
  return next;
}

/** One searchable pool. A duplicated name stays two columns unless that name is joined and the types match. */
export function poolColumns(datasets: PoolDataset[], links: Record<string, LinkChoice>): PoolColumn[] {
  const dupes = new Map(duplicateGroups(datasets).map((group) => [group.name, group]));
  const columns: PoolColumn[] = [];
  const joined = new Set<string>();
  for (const dataset of datasets) {
    for (const column of dataset.columns) {
      const group = dupes.get(column.name);
      if (group && links[column.name] === "join" && group.sameType) {
        if (joined.has(column.name)) continue;
        joined.add(column.name);
        columns.push({ id: joinRef(column.name), name: column.name, type: column.type, source: null, datasetId: null, join: true });
        continue;
      }
      columns.push({
        id: columnRef(dataset.id, column.name),
        name: column.name,
        type: column.type,
        source: group ? dataset.name : null,
        datasetId: dataset.id,
        join: false,
      });
    }
  }
  return columns;
}

function cell(dataset: PoolDataset, row: Array<string | number | null>, name: string): string | number | null {
  const index = dataset.columns.findIndex((column) => column.name === name);
  return index < 0 ? null : (row[index] ?? null);
}

function keyOf(value: string | number | null): string {
  return value === null ? "" : String(value);
}

/** Mean and sample standard deviation of Y at each X, across the seed column. An optional group (a split) becomes its own series. */
export function summarizeSeeds(
  frame: Frame,
  xName: string,
  yName: string,
  seedName: string,
  groupName?: string | null,
): Array<{ x: number | string; group: string; mean: number; std: number }> {
  const xIndex = frame.columns.findIndex((column) => column.name === xName);
  const yIndex = frame.columns.findIndex((column) => column.name === yName);
  const seedIndex = frame.columns.findIndex((column) => column.name === seedName);
  const groupIndex = groupName ? frame.columns.findIndex((column) => column.name === groupName) : -1;
  if (xIndex < 0 || yIndex < 0) return [];
  const groups = new Map<string, { x: number | string; group: string; values: Map<string, number> }>();
  for (const row of frame.rows) {
    const rawX = row[xIndex] ?? null;
    const rawY = row[yIndex] ?? null;
    const y = typeof rawY === "number" ? rawY : Number(rawY);
    if (rawX === null || rawX === "" || !Number.isFinite(y)) continue;
    const split = groupIndex >= 0 ? String(row[groupIndex] ?? "") : "";
    const key = `${split}\u001f${String(rawX)}`;
    const bucket = groups.get(key) ?? { x: typeof rawX === "number" ? rawX : String(rawX), group: split, values: new Map() };
    const seed = seedIndex >= 0 ? String(row[seedIndex] ?? "") : String(bucket.values.size);
    bucket.values.set(seed, y);
    groups.set(key, bucket);
  }
  return [...groups.values()]
    .map((bucket) => {
      const values = [...bucket.values.values()];
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      const variance = values.length > 1 ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1) : 0;
      return { x: bucket.x, group: bucket.group, mean, std: Math.sqrt(variance) };
    })
    .sort((a, b) => {
      const left = typeof a.x === "number" ? a.x : Number(a.x);
      const right = typeof b.x === "number" ? b.x : Number(b.x);
      if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;
      const byX = String(a.x).localeCompare(String(b.x));
      if (byX !== 0) return byX;
      return a.group.localeCompare(b.group);
    });
}

/**
 * Build the single table a tile plots. Columns from one file stay in that file.
 * A joined key aligns the other files on its values (inner join).
 */
const STYLE_KEYS = [
  "grid", "gridX", "gridY", "gridXMinor", "gridYMinor", "minorDivisions",
  "gridStyle", "gridWidth", "gridAlpha", "minorGridStyle", "minorGridWidth", "minorGridAlpha",
  "xTicks", "xTickStep", "xTickMax", "yTicks", "yTickStep", "yTickMax",
  "xMinorTicks", "yMinorTicks", "xTickFormat", "yTickFormat", "xTickRotate", "yTickRotate",
  "tickFormat", "fontSize", "despine", "boxNotch", "boxOutliers", "boxWhisker", "boxJitter",
  "widthIn", "heightIn", "figure", "fontFamily",
] as const;

function copyStyle(config: PlotConfig, tile: object) {
  const source = tile as Partial<PlotConfig>;
  for (const key of STYLE_KEYS) {
    if (source[key] !== undefined) (config as unknown as Record<string, unknown>)[key] = source[key];
  }
}

export function chartFrame(
  datasets: PoolDataset[],
  tile: Pick<PlotConfig, "chart" | "xLog" | "yLogLeft" | "yLogRight" | "title" | "palette" | "annotations" | "legend"> & {
    xRef: string | null;
    yRefs: string[];
    errorRef?: string | null;
    errorKind?: "bar" | "band";
    seedRef?: string | null;
    filter?: PlotFilter | null;
    series?: Array<{ axis?: "left" | "right"; color?: string; lineStyle?: "solid" | "dashed" | "dotted" | "dashdot"; errorKind?: "bar" | "band" }>;
  },
  links: Record<string, LinkChoice>,
): { frame: Frame; config: PlotConfig; warnings: string[] } {
  const warnings: string[] = [];
  const xPart = tile.xRef ? parseRef(tile.xRef) : null;
  const yRefs = tile.yRefs.filter((ref) => {
    const part = parseRef(ref);
    if (!xPart?.datasetId || !part.datasetId || part.datasetId === xPart.datasetId) return true;
    const other = datasets.find((dataset) => dataset.id === part.datasetId);
    const column = other?.columns.find((item) => item.name === part.name);
    const index = other ? other.columns.findIndex((item) => item.name === part.name) : -1;
    const values = other && index >= 0 ? other.rows.flatMap((row) => (typeof row[index] === "number" ? [row[index] as number] : [])) : [];
    const log = tile.yLogLeft || tile.yLogRight || tile.xLog;
    if (column && column.type !== "number") warnings.push(`${part.name} is a category, hidden on this chart.`);
    else if (log && values.some((value) => value <= 0)) warnings.push(`${part.name} has values ≤ 0, hidden on log axis`);
    else warnings.push(`${part.name} is on another table, so it stays off this chart.`);
    return false;
  });
  tile = { ...tile, yRefs };
  const config = defaultPlotConfig();
  config.chart = tile.chart;
  config.xLog = tile.xLog;
  config.yLogLeft = tile.yLogLeft;
  config.yLogRight = tile.yLogRight;
  config.title = tile.title;
  config.palette = tile.palette;
  config.annotations = tile.annotations;
  config.legend = tile.legend;
  copyStyle(config, tile);
  const empty = { columns: [], rows: [] };
  if (!tile.xRef) return { frame: empty, config, warnings };
  if (!tile.yRefs.length) {
    const dataset = xPart?.datasetId ? datasets.find((item) => item.id === xPart.datasetId) : undefined;
    config.x = xPart?.name || null;
    config.series = [];
    return { frame: dataset ? { columns: dataset.columns, rows: dataset.rows } : empty, config, warnings };
  }
  const refs = [tile.xRef, ...tile.yRefs, tile.errorRef ?? null].filter((ref): ref is string => Boolean(ref));
  const parsed = refs.map(parseRef);
  const byId = new Map(datasets.map((dataset) => [dataset.id, dataset]));
  if (!tile.xRef || tile.yRefs.length === 0) return { frame: { columns: [], rows: [] }, config, warnings };
  const errorKind = tile.errorKind ?? tile.series?.find((series) => series.errorKind)?.errorKind;

  const join = parsed.find((ref) => ref.join);
  const singleDataset = !join && parsed.every((ref) => ref.datasetId === parsed[0]?.datasetId);
  if (singleDataset && parsed[0]?.datasetId) {
    const dataset = byId.get(parsed[0].datasetId);
    if (!dataset) return { frame: { columns: [], rows: [] }, config, warnings };
    const xName = parseRef(tile.xRef).name;
    const filtered = applyFilter({ columns: dataset.columns, rows: dataset.rows }, tile.filter ?? null);
    if (tile.seedRef && tile.yRefs[0]) {
      const yName = parseRef(tile.yRefs[0]).name;
      const seedName = parseRef(tile.seedRef).name;
      const extras = filtered.columns.filter((column) => column.name !== xName && column.name !== yName && column.name !== seedName && (column.type === "category" || column.type === "text"));
      const groupName = extras.length === 1 ? extras[0]!.name : null;
      const summary = summarizeSeeds(filtered, xName, yName, seedName, groupName);
      const groupOrder: string[] = [];
      if (groupName) {
        const index = filtered.columns.findIndex((column) => column.name === groupName);
        for (const row of filtered.rows) {
          const value = String(row[index] ?? "");
          if (value && !groupOrder.includes(value)) groupOrder.push(value);
        }
      }
      if (!groupOrder.length) groupOrder.push("");
      const style = tile.series?.[0];
      const named = groupOrder.map((group) => {
        const y = group ? group : yName;
        return { group, y, std: `${y} std` };
      });
      const byX = new Map<string, { x: number | string; cells: Map<string, { mean: number; std: number }> }>();
      for (const row of summary) {
        const key = String(row.x);
        const bucket = byX.get(key) ?? { x: row.x, cells: new Map() };
        bucket.cells.set(row.group, { mean: row.mean, std: row.std });
        byX.set(key, bucket);
      }
      const ordered = [...byX.values()].sort((a, b) => {
        const left = typeof a.x === "number" ? a.x : Number(a.x);
        const right = typeof b.x === "number" ? b.x : Number(b.x);
        if (Number.isFinite(left) && Number.isFinite(right)) return left - right;
        return String(a.x).localeCompare(String(b.x));
      });
      config.x = xName;
      config.yTitleLeft = yName;
      config.filter = null;
      config.series = named.map((series) => ({
        y: series.y,
        axis: style?.axis ?? "left" as const,
        ...(style?.color && named.length === 1 ? { color: style.color } : {}),
        ...(style?.lineStyle ? { lineStyle: style.lineStyle } : {}),
        error: series.std,
        errorKind: "band" as const,
      }));
      return {
        frame: {
          columns: [
            { name: xName, type: "number" },
            ...named.flatMap((series) => [
              { name: series.y, type: "number" as const },
              { name: series.std, type: "number" as const },
            ]),
          ],
          rows: ordered.map((row) => [
            typeof row.x === "number" ? row.x : Number(row.x) || row.x,
            ...named.flatMap((series) => {
              const cell = row.cells.get(series.group);
              return cell ? [cell.mean, cell.std] : [null, null];
            }),
          ]),
        },
        config,
        warnings,
      };
    }
    config.x = xName;
    config.filter = tile.filter ?? null;
    config.series = tile.yRefs.map((ref, index) => {
      const style = tile.series?.[index];
      return {
        y: parseRef(ref).name,
        axis: style?.axis ?? "left" as const,
        ...(style?.color ? { color: style.color } : {}),
        ...(style?.lineStyle ? { lineStyle: style.lineStyle } : {}),
        error: tile.errorRef ? parseRef(tile.errorRef).name : undefined,
        errorKind: tile.errorRef ? (style?.errorKind ?? errorKind) : undefined,
      };
    });
    return { frame: { columns: dataset.columns, rows: dataset.rows }, config, warnings };
  }

  if (!join) return { frame: { columns: [], rows: [] }, config, warnings };
  const group = duplicateGroups(datasets).find((item) => item.name === join.name);
  if (!group?.sameType || links[join.name] !== "join") return { frame: { columns: [], rows: [] }, config, warnings };

  const involved = new Set(parsed.map((ref) => ref.datasetId).filter((id): id is string => Boolean(id)));
  for (const column of group.columns) involved.add(column.datasetId);
  const tables = [...involved].map((id) => byId.get(id)).filter((dataset): dataset is PoolDataset => Boolean(dataset));
  const maps = tables.map((dataset) => {
    const map = new Map<string, Array<string | number | null>>();
    for (const row of dataset.rows) map.set(keyOf(cell(dataset, row, join.name)), row);
    return map;
  });
  const keys = [...maps[0]!.keys()].filter((key) => maps.every((map) => map.has(key)));
  const taken = new Set<string>();
  const xName = label(join.name, "", taken);
  const yNames = tile.yRefs.map((ref) => {
    const part = parseRef(ref);
    const source = byId.get(part.datasetId ?? "")?.name ?? "";
    return label(part.name, source, taken);
  });
  const errorName = tile.errorRef ? label(parseRef(tile.errorRef).name, byId.get(parseRef(tile.errorRef).datasetId ?? "")?.name ?? "", taken) : null;
  const columns: PlotColumn[] = [{ name: xName, type: group.columns[0]!.type }];
  for (const name of yNames) columns.push({ name, type: "number" });
  if (errorName) columns.push({ name: errorName, type: "number" });
  const rows = keys.map((key) => {
    const row: Array<string | number | null> = [maps[0]!.get(key) ? cell(tables[0]!, maps[0]!.get(key)!, join.name) : key];
    for (const ref of tile.yRefs) {
      const part = parseRef(ref);
      const dataset = byId.get(part.datasetId ?? "");
      const index = tables.indexOf(dataset!);
      const sourceRow = index >= 0 ? maps[index]!.get(key) : undefined;
      row.push(dataset && sourceRow ? cell(dataset, sourceRow, part.name) : null);
    }
    if (tile.errorRef) {
      const part = parseRef(tile.errorRef);
      const dataset = byId.get(part.datasetId ?? "");
      const index = dataset ? tables.indexOf(dataset) : -1;
      const sourceRow = index >= 0 ? maps[index]!.get(key) : undefined;
      row.push(dataset && sourceRow ? cell(dataset, sourceRow, part.name) : null);
    }
    return row;
  });
  config.x = xName;
  config.series = yNames.map((name) => ({ y: name, axis: "left" as const, error: errorName ?? undefined, errorKind: errorName ? errorKind : undefined }));
  return { frame: { columns, rows }, config, warnings };
}
