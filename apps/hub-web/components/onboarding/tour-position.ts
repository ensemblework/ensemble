export type TourBox = { left: number; top: number; width: number; height: number };
export type TourViewport = { width: number; height: number };

/** Keep the spotlight in view, including when a target is larger than the viewport. */
export function fitTourTarget(box: TourBox, viewport: TourViewport): TourBox | null {
  const left = Math.max(8, box.left - 6);
  const top = Math.max(8, box.top - 6);
  const right = Math.min(viewport.width - 8, box.left + box.width + 6);
  const bottom = Math.min(viewport.height - 8, box.top + box.height + 6);
  return right > left && bottom > top ? { left, top, width: right - left, height: bottom - top } : null;
}

/** Prefer a clear side of the target; on phones the guide becomes a bottom sheet. */
export function placeTourCard(box: TourBox | null, viewport: TourViewport, height: number): TourBox {
  const margin = 16;
  const width = Math.min(384, viewport.width - margin * 2);
  const usedHeight = Math.min(height, viewport.height - margin * 2);
  const clampX = (x: number) => Math.max(margin, Math.min(x, viewport.width - margin - width));
  const clampY = (y: number) => Math.max(margin, Math.min(y, viewport.height - margin - usedHeight));
  if (!box) return { left: clampX((viewport.width - width) / 2), top: clampY((viewport.height - usedHeight) / 2), width, height: usedHeight };
  if (viewport.width < 768 || viewport.height < 600) return { left: clampX((viewport.width - width) / 2), top: clampY(viewport.height - margin - usedHeight), width, height: usedHeight };
  const gap = 22;
  if (box.left + box.width + gap + width <= viewport.width - margin) return { left: box.left + box.width + gap, top: clampY(box.top), width, height: usedHeight };
  if (box.top + box.height + gap + usedHeight <= viewport.height - margin) return { left: clampX(box.left), top: box.top + box.height + gap, width, height: usedHeight };
  if (box.top - gap - usedHeight >= margin) return { left: clampX(box.left), top: box.top - gap - usedHeight, width, height: usedHeight };
  if (box.left - gap - width >= margin) return { left: box.left - gap - width, top: clampY(box.top), width, height: usedHeight };
  return { left: clampX(viewport.width - margin - width), top: clampY(viewport.height - margin - usedHeight), width, height: usedHeight };
}
