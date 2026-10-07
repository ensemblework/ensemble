import { isWorkspace, workspaceSchema } from "@ensemble/shared-types";

export function plotMentionEntities(
  plots: Array<{ id: string; title: string; config: unknown }>,
  datasets: Array<{ id: string; name: string; format: string }>,
) {
  return [
    ...plots.flatMap((plot) => {
      if (!isWorkspace(plot.config)) {
        return [{ kind: "plot", id: plot.id, label: plot.title, detail: "Saved plot", parentId: "saved", parentLabel: "Saved plots" }];
      }
      const config = workspaceSchema.parse(plot.config);
      return [
        { kind: "plot", id: plot.id, label: plot.title, detail: `Plot space · ${config.tiles.length} tiles`, parentId: "", parentLabel: "", isSpace: true },
        ...config.tiles.map((tile) => ({
          kind: "plot", id: `${plot.id}/${encodeURIComponent(tile.id)}`, label: tile.title || "Untitled tile",
          detail: `${plot.title} · ${tile.chart}`, parentId: plot.id, parentLabel: plot.title,
        })),
      ];
    }),
    ...datasets.map((dataset) => ({ kind: "dataset", id: dataset.id, label: dataset.name, detail: dataset.format.toUpperCase(), parentId: "data", parentLabel: "Data files" })),
  ];
}
