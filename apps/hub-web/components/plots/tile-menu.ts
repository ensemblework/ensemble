"use client";

import type { LinkChoice, PoolDataset, WorkspaceTile } from "@ensemble/shared-types";
import { ClipboardCopy, Code2, Copy, Download, Image as ImageIcon, Maximize2, Trash2 } from "lucide-react";
import { askItems, copyText } from "@/components/context-menu/builders";
import type { MenuSpec } from "@/components/context-menu/menu-store";
import { figureBytes } from "@/lib/plots/figure-file";
import { renderPlot } from "@/lib/plots/render";
import { tileScript, tileSource } from "@/lib/plots/tile-code";
import type { ToastOptions } from "@/lib/toast-bus";

export type TileMenuDeps = {
  tile: WorkspaceTile;
  datasets: PoolDataset[];
  links: Record<string, LinkChoice>;
  theme: { accent: string; dark: boolean };
  workspaceId: string | null;
  canvasTitle: string;
  readOnly: boolean;
  open: () => void;
  duplicate: () => void;
  remove: () => void;
  toast: (text: string, options?: ToastOptions) => void;
};

const CHART_ASKS = [
  { id: "explain-chart", label: "Explain this chart", prompt: "Explain what this chart shows: the trend, anything unusual, and what I should take from it." },
  { id: "better-chart", label: "Suggest a clearer chart", prompt: "How could this chart be clearer? Suggest the chart type, axes and styling, and show the changed code." },
  { id: "caption", label: "Write a caption", prompt: "Write a short figure caption for this chart, as for a paper." },
];

const fileName = (title: string, format: string) => `${(title || "chart").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "chart"}.${format}`;

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A tile's right-click menu on the Plots canvas: open, ask, download, copy, duplicate, delete. */
export function plotTileMenu(deps: TileMenuDeps): MenuSpec {
  const { tile, theme, workspaceId, toast } = deps;
  const title = tile.title || tile.chart;
  const script = () => tileScript(tile, tileSource(tile, { datasets: deps.datasets, links: deps.links, accent: theme.accent, dark: theme.dark })).code;
  const render = async (format: "png" | "svg" | "pdf") => {
    if (!workspaceId) throw new Error("This canvas is still loading.");
    const result = await renderPlot(workspaceId, { format, code: script() });
    return figureBytes(format, result.data);
  };
  const download = (format: "png" | "svg" | "pdf") => async () => {
    try {
      save(await render(format), fileName(title, format));
    } catch (error) {
      toast(error instanceof Error ? error.message : "That chart could not be drawn.", { tone: "error" });
    }
  };
  const attachment = { text: `Chart “${title}” (${tile.chart}) on the Plots canvas “${deps.canvasTitle}”. Its code:\n\`\`\`python\n${script()}\n\`\`\``, source: { kind: "plot" as const, id: workspaceId ?? "", title: deps.canvasTitle } };
  return {
    sections: [
      { items: [{ id: "tile-open", label: "Open", icon: Maximize2, hint: "Enter", run: deps.open }] },
      { items: askItems(attachment, CHART_ASKS, true) },
      {
        items: [
          {
            id: "tile-download",
            label: "Download",
            icon: Download,
            disabled: !workspaceId,
            submenu: () => ({
              sections: [
                {
                  items: [
                    { id: "tile-png", label: "PNG image", run: download("png") },
                    { id: "tile-svg", label: "SVG (vector)", run: download("svg") },
                    { id: "tile-pdf", label: "PDF", run: download("pdf") },
                  ],
                },
              ],
            }),
          },
          {
            id: "tile-copy-image",
            label: "Copy image",
            icon: ImageIcon,
            disabled: !workspaceId || typeof ClipboardItem === "undefined",
            run: async () => {
              try {
                const png = await render("png");
                await navigator.clipboard.write([new ClipboardItem({ "image/png": png.type === "image/png" ? png : new Blob([png], { type: "image/png" }) })]);
              } catch (error) {
                toast(error instanceof Error ? error.message : "The image could not be copied.", { tone: "error" });
              }
            },
          },
          { id: "tile-copy-code", label: "Copy code", icon: Code2, run: () => copyText(script()) },
          { id: "tile-copy-title", label: "Copy title", icon: ClipboardCopy, run: () => copyText(title) },
        ],
      },
      ...(deps.readOnly
        ? []
        : [
            {
              items: [
                { id: "tile-duplicate", label: "Duplicate", icon: Copy, run: deps.duplicate },
                { id: "tile-delete", label: "Delete", icon: Trash2, danger: true, hint: "Del", run: deps.remove },
              ],
            },
          ]),
    ],
  };
}
