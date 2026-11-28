import { z } from "zod";
import { MAX_TASK_LABEL_LENGTH } from "./domain.js";

/**
 * Board labels: each board keeps its own list of labels (a name and a colour) that its pages,
 * tasks and deliverables pick from. Items keep the names; the board's list gives them their colour.
 */

/** The theme's tag colours (`--tag-<colour>-bg` in the Hub). */
export const LABEL_COLORS = ["blue", "green", "purple", "orange", "pink", "yellow", "red", "gray"] as const;
export const LabelColor = z.enum(LABEL_COLORS);
export type LabelColor = z.infer<typeof LabelColor>;

/** The colours a new label is given on its own, before anyone picks one. */
export const AUTO_LABEL_COLORS: readonly LabelColor[] = ["blue", "green", "purple", "orange", "pink", "yellow"];

/** The id the Ensemble board's labels go by. Items on no board use this list too. */
export const ENSEMBLE_LABEL_BOARD = "ensemble";

/** The colour a label has before anyone picks one: the same name gets the same colour everywhere. */
export function labelTone(name: string): LabelColor {
  let hash = 0;
  for (const char of labelKey(name)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AUTO_LABEL_COLORS[hash % AUTO_LABEL_COLORS.length]!;
}

/** One label name as stored: inner spaces folded, trimmed, at most 40 characters. */
export function cleanLabelName(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_TASK_LABEL_LENGTH).trim();
}

/**
 * The one key a name is compared by, whatever its case (`BoardLabel.nameKey`). Always computed here,
 * never with SQL `lower()`, which folds only ASCII on a database with the C locale.
 */
export function labelKey(name: string): string {
  return name.toLowerCase();
}

/**
 * The colour for a new label: the auto colour fewest of the board's labels have, starting from the
 * name's own colour, so a board's first six labels all differ.
 */
export function nextLabelColor(name: string, used: readonly string[]): LabelColor {
  const counts = new Map<string, number>();
  for (const color of used) counts.set(color, (counts.get(color) ?? 0) + 1);
  const start = AUTO_LABEL_COLORS.indexOf(labelTone(name));
  let best = AUTO_LABEL_COLORS[start]!;
  for (let step = 0; step < AUTO_LABEL_COLORS.length; step += 1) {
    const color = AUTO_LABEL_COLORS[(start + step) % AUTO_LABEL_COLORS.length]!;
    if ((counts.get(color) ?? 0) < (counts.get(best) ?? 0)) best = color;
  }
  return best;
}

const LabelName = z
  .string()
  .max(200)
  .transform(cleanLabelName)
  .refine((value) => value.length > 0, "Give the label a name.");

export const CreateBoardLabel = z.object({
  /** A board id, or `ensemble` for the Ensemble board. */
  board: z.string().min(1).max(64),
  name: LabelName,
  color: LabelColor.optional(),
});
export type CreateBoardLabel = z.infer<typeof CreateBoardLabel>;

export const PatchBoardLabel = z
  .object({ name: LabelName.optional(), color: LabelColor.optional() })
  .refine((value) => value.name !== undefined || value.color !== undefined, "Change the name or the colour.");
export type PatchBoardLabel = z.infer<typeof PatchBoardLabel>;

export type BoardLabelRecord = {
  id: string;
  name: string;
  color: LabelColor;
  /** How many of the board's pages, tasks and deliverables have it (Trash left out). */
  count: number;
};

export type BoardLabelList = {
  board: { id: string; title: string };
  labels: BoardLabelRecord[];
};
