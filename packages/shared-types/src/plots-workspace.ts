import { z } from "zod";
import { CHART_TYPES, plotConfigSchema } from "./plots.js";

export const PAPER_KINDS = ["training", "ablation", "scaling", "pareto", "confusion", "reliability", "runs"] as const;
export type PaperKind = (typeof PAPER_KINDS)[number];

export const tileSchema = plotConfigSchema.extend({
  id: z.string().min(1).max(40),
  col: z.number().int().min(0).max(11).default(0),
  row: z.number().int().min(0).max(80).default(0),
  w: z.number().int().min(3).max(12).default(6),
  h: z.number().int().min(3).max(16).default(4),
  paper: z.enum(PAPER_KINDS).nullable().default(null),
  xRef: z.string().max(300).nullable().default(null),
  yRefs: z.array(z.string().max(300)).max(8).default([]),
  errorRef: z.string().max(300).nullable().default(null),
  /** When set, the tile averages this column's groups and shades the standard deviation. */
  seedRef: z.string().max(300).nullable().default(null),
});
export type WorkspaceTile = z.infer<typeof tileSchema>;

export const workspaceSchema = z.object({
  kind: z.literal("workspace"),
  tiles: z.array(tileSchema).max(24).default([]),
  datasetIds: z.array(z.string().uuid()).max(24).default([]),
  links: z.record(z.string().max(200), z.enum(["separate", "join"])).default({}),
  /** True while the canvas is showing the built-in sample, which clears in one click. */
  sample: z.boolean().default(false),
});
export type WorkspaceConfig = z.infer<typeof workspaceSchema>;

export function emptyWorkspace(): WorkspaceConfig {
  return workspaceSchema.parse({ kind: "workspace" });
}

export function isWorkspace(value: unknown): value is { kind: "workspace" } {
  return Boolean(value && typeof value === "object" && (value as { kind?: string }).kind === "workspace");
}

export type GallerySlot = "x" | "y" | "error" | "seed" | "value";

export const GALLERY: Array<{
  id: string;
  label: string;
  blurb: string;
  hint: string;
  group: "paper" | "everyday";
  chart: (typeof CHART_TYPES)[number];
  paper: PaperKind | null;
  xLog?: boolean;
  yLog?: boolean;
  error?: "bar" | "band";
  slots: GallerySlot[];
}> = [
  { id: "training", group: "paper", label: "Training curve", blurb: "Mean over seeds, shaded standard deviation.", hint: "X is the step. Y is the measure. Seed (or run) is optional: per-seed rows become a mean and a std band.", chart: "line", paper: "training", error: "band", slots: ["x", "y", "seed"] },
  { id: "ablation", group: "paper", label: "Ablation bars", blurb: "Grouped bars with error bars.", hint: "X is the variant. Y is the mean. Error is the std.", chart: "bar", paper: "ablation", error: "bar", slots: ["x", "y", "error"] },
  { id: "scaling", group: "paper", label: "Scaling law", blurb: "Log-log. Loss against compute or data.", hint: "X and Y should both be positive. Both axes are logarithmic.", chart: "line", paper: "scaling", xLog: true, yLog: true, slots: ["x", "y"] },
  { id: "pareto", group: "paper", label: "Pareto front", blurb: "One point per run, two objectives.", hint: "X and Y are the two objectives.", chart: "scatter", paper: "pareto", slots: ["x", "y"] },
  { id: "confusion", group: "paper", label: "Confusion matrix", blurb: "Class against class.", hint: "X is the true class. Y is the predicted class. Value is the count.", chart: "heatmap", paper: "confusion", slots: ["x", "y", "value"] },
  { id: "reliability", group: "paper", label: "Reliability", blurb: "Confidence against accuracy, with the diagonal.", hint: "X is confidence. Y is accuracy. A y = x line is added.", chart: "line", paper: "reliability", slots: ["x", "y"] },
  { id: "runs", group: "paper", label: "Run distribution", blurb: "A violin across seeds or runs.", hint: "Y is the score. One violin per X group, or a single violin when X is empty.", chart: "violin", paper: "runs", slots: ["x", "y"] },
  { id: "line", group: "everyday", label: "Line", blurb: "One or more series against a shared X.", hint: "X is shared. Y can be several numeric columns.", chart: "line", paper: null, slots: ["x", "y"] },
  { id: "bar", group: "everyday", label: "Bar", blurb: "Compare categories from a zero baseline.", hint: "X is the category. Y is the value.", chart: "bar", paper: null, slots: ["x", "y"] },
  { id: "scatter", group: "everyday", label: "Scatter", blurb: "Two numeric columns.", hint: "X and Y are both numeric.", chart: "scatter", paper: null, slots: ["x", "y"] },
  { id: "area", group: "everyday", label: "Area", blurb: "A filled line. The axis includes zero.", hint: "X is shared. Y is the filled series.", chart: "area", paper: null, slots: ["x", "y"] },
  { id: "box", group: "everyday", label: "Box plot", blurb: "Quartiles, whiskers, and outliers by group.", hint: "X is the group. Y is the numeric measure. Outliers sit beyond the whiskers.", chart: "box", paper: null, slots: ["x", "y"] },
];
