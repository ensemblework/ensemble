/** Viewport placement for floating layers.

Placement is a pure function of the anchor, the layer's intrinsic size, and the
viewport. Callers should run it when the layer opens and again on real resize
or scroll, then keep the chosen side until the other side is clearly better.
Hover, pointer movement, and size changes caused by hover must not call it.
*/

export type Viewport = { width: number; height: number };
export type Side = "above" | "below";
export type AnchorBox = { top: number; right: number; bottom: number; left: number };

export type CenteredLayer = { top: number; left: number; width: number; maxHeight: number };
export type AnchoredLayer = CenteredLayer & { side: Side };

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

/** A centered dialog that prefers `preferRatio` from the top and stays inside the viewport. */
export function placeCenteredPanel(
  viewport: Viewport,
  contentHeight: number,
  options?: { margin?: number; preferRatio?: number; widthCap?: number },
): CenteredLayer {
  const margin = options?.margin ?? 16;
  const preferRatio = options?.preferRatio ?? 0.18;
  const widthCap = options?.widthCap ?? 420;
  const width = Math.min(widthCap, Math.max(0, viewport.width - margin * 2));
  const left = Math.max(margin, (viewport.width - width) / 2);
  const maxHeight = Math.max(0, viewport.height - margin * 2);
  const height = Math.min(Math.max(0, contentHeight), maxHeight);
  const preferTop = viewport.height * preferRatio;
  const room = viewport.height - margin - height;
  const top = Math.min(Math.max(preferTop, margin), Math.max(margin, room));
  return { top, left, width, maxHeight };
}

/**
 * Open under the anchor when it fits. Otherwise open above. Once a side is
 * chosen, keep it unless it can no longer hold the layer and the other side
 * can, or the other side has at least `hysteresis` more room. That gap stops
 * a one-pixel size change from flipping the layer back and forth.
 */
export function placeAnchoredPanel(input: {
  anchor: AnchorBox;
  panelWidth: number;
  panelHeight: number;
  viewport: Viewport;
  align?: "left" | "right";
  previousSide?: Side | null;
  margin?: number;
  gap?: number;
  hysteresis?: number;
}): AnchoredLayer {
  const margin = input.margin ?? 8;
  const gap = input.gap ?? 4;
  const hysteresis = input.hysteresis ?? 48;
  const viewportWidth = input.viewport.width;
  const viewportHeight = input.viewport.height;
  const width = Math.min(input.panelWidth, Math.max(0, viewportWidth - margin * 2));
  const rawLeft = (input.align ?? "left") === "right" ? input.anchor.right - width : input.anchor.left;
  const left = clamp(rawLeft, margin, viewportWidth - margin - width);
  const spaceBelow = Math.max(0, viewportHeight - margin - (input.anchor.bottom + gap));
  const spaceAbove = Math.max(0, input.anchor.top - gap - margin);
  const needed = Math.max(0, input.panelHeight);
  const space = (side: Side) => (side === "below" ? spaceBelow : spaceAbove);
  const fits = (side: Side) => space(side) + 0.5 >= needed;

  let side: Side;
  const previous = input.previousSide ?? null;
  if (previous == null) {
    if (fits("below")) side = "below";
    else if (fits("above")) side = "above";
    else side = spaceBelow >= spaceAbove ? "below" : "above";
  } else {
    const other: Side = previous === "below" ? "above" : "below";
    if (fits(previous)) side = previous;
    else if (fits(other)) side = other;
    else if (space(other) >= space(previous) + hysteresis) side = other;
    else side = previous;
  }

  const available = space(side);
  const used = Math.min(needed > 0 ? needed : available, available);
  const top =
    side === "below"
      ? clamp(input.anchor.bottom + gap, margin, viewportHeight - margin - used)
      : clamp(input.anchor.top - gap - used, margin, viewportHeight - margin - used);
  return { top, left, width, maxHeight: available, side };
}
