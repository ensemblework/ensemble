/**
 * Alignment guides and snapping for the diagram canvas, in flow coordinates. While one block is
 * dragged, its left, centre or right edge snaps to another block's left, centre or right (and the
 * same for top, middle, bottom), and a guide line shows the match. While a block is resized, the
 * edge being dragged snaps the same way, and its width or height snaps to another block's, shown
 * as a size mark on both. Written for Ensemble after how Excalidraw (MIT) and draw.io (Apache-2.0)
 * snap; React Flow's own helper-lines example is a Pro example and is not used.
 */

export type Box = { x: number; y: number; w: number; h: number };

export type Guide =
  /** A vertical line at x, from y1 to y2. */
  | { kind: "x"; at: number; from: number; to: number }
  /** A horizontal line at y, from x1 to x2. */
  | { kind: "y"; at: number; from: number; to: number }
  /** These boxes share a width (or a height). */
  | { kind: "width" | "height"; boxes: Box[] };

/** Screen pixels within which an edge snaps. Divide by the zoom for flow units. */
export const SNAP_PX = 6;

const xs = (box: Box) => [box.x, box.x + box.w / 2, box.x + box.w];
const ys = (box: Box) => [box.y, box.y + box.h / 2, box.y + box.h];

type Hit = { delta: number; at: number } | null;

/** The smallest move that puts one of `mine` on one of `theirs`, within `threshold`. */
function nearest(mine: number[], theirs: number[], threshold: number): Hit {
  let best: Hit = null;
  for (const value of mine) {
    for (const target of theirs) {
      const delta = target - value;
      if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta))) best = { delta, at: target };
    }
  }
  return best;
}

const close = (a: number, b: number) => Math.abs(a - b) < 0.5;

/** Guide lines through every edge or centre of `box` that another box shares. */
function linesFor(box: Box, others: Box[]): Guide[] {
  const guides: Guide[] = [];
  for (const at of xs(box)) {
    const matched = others.filter((other) => xs(other).some((value) => close(value, at)));
    if (!matched.length) continue;
    const all = [box, ...matched];
    guides.push({ kind: "x", at, from: Math.min(...all.map((item) => item.y)), to: Math.max(...all.map((item) => item.y + item.h)) });
  }
  for (const at of ys(box)) {
    const matched = others.filter((other) => ys(other).some((value) => close(value, at)));
    if (!matched.length) continue;
    const all = [box, ...matched];
    guides.push({ kind: "y", at, from: Math.min(...all.map((item) => item.x)), to: Math.max(...all.map((item) => item.x + item.w)) });
  }
  return guides;
}

/** Where a dragged box lands, and the guides to draw. */
export function snapMove(box: Box, others: Box[], threshold: number): { x: number; y: number; guides: Guide[] } {
  const xHit = nearest(xs(box), others.flatMap(xs), threshold);
  const yHit = nearest(ys(box), others.flatMap(ys), threshold);
  const placed = { ...box, x: box.x + (xHit?.delta ?? 0), y: box.y + (yHit?.delta ?? 0) };
  return { x: placed.x, y: placed.y, guides: linesFor(placed, others) };
}

/**
 * A box being resized from `before` to `box`. Only the edges that moved snap. When an edge match
 * and a size match are both in reach, the smaller change wins. Never below `min`.
 */
export function snapResize(before: Box, box: Box, others: Box[], threshold: number, min: { w: number; h: number }): { box: Box; guides: Guide[] } {
  const next = { ...box };
  const leftMoved = !close(box.x, before.x);
  const rightMoved = !close(box.x + box.w, before.x + before.w);
  const topMoved = !close(box.y, before.y);
  const bottomMoved = !close(box.y + box.h, before.y + before.h);
  const widths = others.map((other) => other.w);
  const heights = others.map((other) => other.h);

  if (leftMoved !== rightMoved) {
    const edge = leftMoved ? next.x : next.x + next.w;
    const line = nearest([edge], others.flatMap(xs), threshold);
    const size = nearest([next.w], widths, threshold);
    const deltaW = line ? (leftMoved ? -line.delta : line.delta) : null;
    const pick = size && (deltaW == null || Math.abs(size.delta) < Math.abs(deltaW)) ? size.delta : deltaW;
    if (pick != null && next.w + pick >= min.w) {
      if (leftMoved) next.x -= pick;
      next.w += pick;
    }
  }
  if (topMoved !== bottomMoved) {
    const edge = topMoved ? next.y : next.y + next.h;
    const line = nearest([edge], others.flatMap(ys), threshold);
    const size = nearest([next.h], heights, threshold);
    const deltaH = line ? (topMoved ? -line.delta : line.delta) : null;
    const pick = size && (deltaH == null || Math.abs(size.delta) < Math.abs(deltaH)) ? size.delta : deltaH;
    if (pick != null && next.h + pick >= min.h) {
      if (topMoved) next.y -= pick;
      next.h += pick;
    }
  }
  const guides = linesFor(next, others).filter((guide) => {
    if (guide.kind === "x") return (leftMoved && close(guide.at, next.x)) || (rightMoved && close(guide.at, next.x + next.w));
    if (guide.kind === "y") return (topMoved && close(guide.at, next.y)) || (bottomMoved && close(guide.at, next.y + next.h));
    return false;
  });
  const sameWidth = others.filter((other) => close(other.w, next.w));
  const sameHeight = others.filter((other) => close(other.h, next.h));
  if ((leftMoved || rightMoved) && sameWidth.length) guides.push({ kind: "width", boxes: [next, ...sameWidth] });
  if ((topMoved || bottomMoved) && sameHeight.length) guides.push({ kind: "height", boxes: [next, ...sameHeight] });
  return { box: next, guides };
}
