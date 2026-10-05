import { z } from "zod";
import {
  LAYOUT_SURFACES,
  MAX_DOCUMENT_BYTES,
  validateLayout,
  type LayoutDocument,
  type LayoutSurface,
} from "@ensemble/shared-types/widgets";

const TileConfig = z
  .object({
    title: z.string().max(40).optional(),
    density: z.enum(["comfortable", "compact"]).optional(),
    accent: z.enum(["people", "project", "repo", "note", "deliverable", "accent"]).optional(),
    horizonDays: z.union([z.literal(1), z.literal(7), z.literal(14), z.literal(30)]).optional(),
    taskType: z.string().max(24).optional(),
    source: z.string().max(24).optional(),
    projectId: z.string().min(8).max(80).optional(),
    target: z.number().int().min(1).max(50).optional(),
  })
  .strict();

const Placement = z
  .object({
    type: z.string(),
    size: z.enum(["s", "m", "l", "xl"]),
    slot: z.union([z.literal(0), z.literal(1)]).optional(),
    config: TileConfig.optional(),
  })
  .strict();

/** Shape check. Registry rules (unknown type, min/max, one XL, duplicates) run in validateLayout. */
export const LayoutBody = z
  .object({
    v: z.union([z.literal(1), z.literal(2)]),
    placements: z.array(Placement).max(12),
    config: z
      .object({
        wipCap: z.number().int().min(1).max(20).optional(),
        graphNodeCap: z.number().int().min(4).max(80).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const SurfaceName = z.enum(LAYOUT_SURFACES);

export function parseLayout(surface: string, input: unknown): LayoutDocument {
  const encoded = JSON.stringify(input ?? null);
  if (encoded.length > MAX_DOCUMENT_BYTES) {
    throw Object.assign(new Error("document: larger than 16 KB"), { statusCode: 400 });
  }
  const body = LayoutBody.parse(input);
  const checked = validateLayout(surface, body);
  if (!checked.ok) throw Object.assign(new Error(checked.error), { statusCode: 400 });
  return checked.document;
}

export function assertSurface(value: string): LayoutSurface {
  return SurfaceName.parse(value);
}
