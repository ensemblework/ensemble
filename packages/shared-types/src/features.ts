import type { OptionalModule } from "./modules.js";

export type FeatureCopy = {
  id: OptionalModule;
  /** Sidebar label and the Enable button. */
  label: string;
  /** One plain sentence: what the feature is for. */
  line: string;
  /** Widget ids a starter tour may place. Strings, so this file does not import the widget registry. */
  starters: readonly string[];
};

export const FEATURES: Record<OptionalModule, FeatureCopy> = {
  code: {
    id: "code",
    label: "Code",
    line: "Review changes, edit files, and run a terminal on this machine.",
    starters: ["repos", "review-queue"],
  },
  workspace: {
    id: "workspace",
    label: "Workspace",
    line: "Give the agent a checkout and watch a job run on your machine.",
    starters: [],
  },
  runs: {
    id: "runs",
    label: "Runs",
    line: "See jobs the agent has already run, and stop one if it goes too far.",
    starters: [],
  },
  metrics: {
    id: "metrics",
    label: "Metrics",
    line: "Counts and a ledger you can check, kept beside the desk.",
    starters: [],
  },
  skills: {
    id: "skills",
    label: "Skills",
    line: "Saved instructions the agent can reuse on the next job.",
    starters: [],
  },
  diagrams: {
    id: "diagrams",
    label: "Diagrams",
    line: "Draw how a system fits together, and keep the picture next to the work.",
    starters: [],
  },
  plots: {
    id: "plots",
    label: "Plots",
    line: "Drop a table and plot any column against any other, in two dimensions.",
    starters: ["saved-plots"],
  },
};
