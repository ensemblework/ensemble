/**
 * The one coordinate space the model sees (pixels of the image it was given) and the space input goes
 * in: logical pixels of one screen stream, as the RemoteDesktop portal takes them. Every point is mapped
 * here and clamped inside its screen, so an edge click never lands on the next display.
 */

export const MAX_LONG_EDGE = 1568;

export type Size = { width: number; height: number };
/** A part of one screen in its logical pixels, from the screen's top left. */
export type Region = { x: number; y: number; width: number; height: number };

/** The size an image is sent at: never larger than it is, its long side at most `longEdge`. */
export function fit(size: Size, longEdge = MAX_LONG_EDGE): Size {
  if (!(size.width > 0 && size.height > 0)) throw new RangeError("An image has a positive size.");
  const scale = Math.min(1, Math.max(1, longEdge) / Math.max(size.width, size.height));
  return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) };
}

/** Image pixels per logical pixel, each way. */
export function scaleOf(image: Size, region: Region): { x: number; y: number } {
  return { x: image.width / region.width, y: image.height / region.height };
}

/**
 * A point of an image showing `region` of a screen of `screen` logical size, as a logical point of that
 * screen (the centre of the pixel aimed at), clamped inside the image and the screen.
 */
export function imageToLogical(point: { x: number; y: number }, image: Size, region: Region, screen: Size): { x: number; y: number; clamped: boolean } {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new RangeError("Coordinates must be numbers.");
  const ix = Math.min(Math.max(0, point.x), image.width - 1);
  const iy = Math.min(Math.max(0, point.y), image.height - 1);
  const lx = region.x + ((ix + 0.5) * region.width) / image.width;
  const ly = region.y + ((iy + 0.5) * region.height) / image.height;
  const x = Math.min(Math.max(0, lx), screen.width - 0.5);
  const y = Math.min(Math.max(0, ly), screen.height - 0.5);
  return { x, y, clamped: ix !== point.x || iy !== point.y || x !== lx || y !== ly };
}

/** The logical region an image box `[x0, y0, x1, y1]` covers (a zoom of part of a capture). */
export function boxToRegion(box: readonly [number, number, number, number], image: Size, region: Region, screen: Size): Region {
  const [ax, ay, bx, by] = box;
  if (![ax, ay, bx, by].every(Number.isFinite)) throw new RangeError("A region is four numbers.");
  const left = Math.min(ax, bx);
  const top = Math.min(ay, by);
  const right = Math.max(ax, bx);
  const bottom = Math.max(ay, by);
  const sx = region.width / image.width;
  const sy = region.height / image.height;
  const x = Math.min(Math.max(0, region.x + left * sx), screen.width - 1);
  const y = Math.min(Math.max(0, region.y + top * sy), screen.height - 1);
  const width = Math.min(Math.max(1, (right - left) * sx), screen.width - x);
  const height = Math.min(Math.max(1, (bottom - top) * sy), screen.height - y);
  return { x, y, width, height };
}
