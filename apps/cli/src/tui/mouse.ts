/**
 * Mouse clicks and the wheel, from the terminal's SGR mouse reports (`ESC [ < b ; x ; y M`).
 * Ink passes the report to `useInput` without the escape; both forms are read here.
 */

export const MOUSE_ON = "\u001B[?1000h\u001B[?1006h";
export const MOUSE_OFF = "\u001B[?1000l\u001B[?1006l";

export type MouseEvent = { kind: "click" | "wheel-up" | "wheel-down" | "release"; x: number; y: number };

const REPORT = /^\u001B?\[<(\d+);(\d+);(\d+)([Mm])$/;

export function isMouse(input: string): boolean {
  return REPORT.test(input);
}

/** Zero-based cell coordinates. Only the left button and the wheel matter here. */
export function parseMouse(input: string): MouseEvent | null {
  const match = REPORT.exec(input);
  if (!match) return null;
  const button = Number(match[1]);
  const x = Number(match[2]) - 1;
  const y = Number(match[3]) - 1;
  if (button === 64) return { kind: "wheel-up", x, y };
  if (button === 65) return { kind: "wheel-down", x, y };
  if (match[4] === "m") return { kind: "release", x, y };
  if ((button & 3) === 0 && !(button & 32)) return { kind: "click", x, y };
  return null;
}

/** A clickable cell range, rebuilt on every render from the layout. */
export type Region = { x1: number; x2: number; y1: number; y2: number; onClick: () => void; onWheel?: (delta: number) => void };

export function hit(regions: readonly Region[], x: number, y: number): Region | undefined {
  // Later regions are drawn on top.
  for (let index = regions.length - 1; index >= 0; index -= 1) {
    const region = regions[index]!;
    if (x >= region.x1 && x <= region.x2 && y >= region.y1 && y <= region.y2) return region;
  }
  return undefined;
}
