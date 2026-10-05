/** 12-column grid. Vertical compact keeps the column a person dropped a tile in and closes the rows above it. */

export const GRID_COLS = 12;
export const MIN_W = 3;
export const MIN_H = 3;

export type PackItem = { id: string; x: number; y: number; w: number; h: number };

export function overlaps(a: PackItem, b: PackItem): boolean {
  if (a.id === b.id) return false;
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function clampItem(item: PackItem, cols = GRID_COLS): PackItem {
  const w = Math.max(MIN_W, Math.min(cols, Math.round(item.w)));
  const h = Math.max(MIN_H, Math.round(item.h));
  const x = Math.max(0, Math.min(cols - w, Math.round(item.x)));
  const y = Math.max(0, Math.round(item.y));
  return { ...item, x, y, w, h };
}

/** Pull each tile up until it hits another tile or the top. The column does not change. */
export function compact(items: PackItem[], cols = GRID_COLS): PackItem[] {
  const sorted = items.map((item) => clampItem(item, cols)).sort((a, b) => a.y - b.y || a.x - b.x);
  const placed: PackItem[] = [];
  for (const item of sorted) {
    let y = item.y;
    while (y > 0 && !placed.some((other) => overlaps({ ...item, y: y - 1 }, other))) y -= 1;
    placed.push({ ...item, y });
  }
  return placed.sort((a, b) => a.y - b.y || a.x - b.x);
}

export function findGap(items: PackItem[], w: number, h: number, cols = GRID_COLS): { x: number; y: number } {
  const width = Math.max(MIN_W, Math.min(cols, w));
  const height = Math.max(MIN_H, h);
  const maxY = items.reduce((max, item) => Math.max(max, item.y + item.h), 0);
  for (let y = 0; y <= maxY; y += 1) {
    for (let x = 0; x <= cols - width; x += 1) {
      const candidate = { id: "__gap__", x, y, w: width, h: height };
      if (!items.some((other) => overlaps(candidate, other))) return { x, y };
    }
  }
  return { x: 0, y: maxY };
}

function settle(pinned: PackItem, others: PackItem[], cols: number): PackItem[] {
  const fixed = clampItem(pinned, cols);
  const rest = others.map((item) => clampItem(item, cols)).sort((a, b) => a.y - b.y || a.x - b.x);
  const settled: PackItem[] = [fixed];
  for (const item of rest) {
    let next = item;
    let guard = 0;
    while (settled.some((other) => overlaps(next, other)) && guard < 64) {
      const hit = settled.find((other) => overlaps(next, other))!;
      next = { ...next, y: hit.y + hit.h };
      guard += 1;
    }
    settled.push(next);
  }
  return compact(settled, cols);
}

export function placeNew(items: PackItem[], id: string, w = 6, h = 4, cols = GRID_COLS): PackItem[] {
  const gap = findGap(items, w, h, cols);
  return settle({ id, x: gap.x, y: gap.y, w, h }, items, cols);
}

export function moveItem(items: PackItem[], id: string, x: number, y: number, cols = GRID_COLS): PackItem[] {
  const current = items.find((item) => item.id === id);
  if (!current) return compact(items, cols);
  return settle({ ...current, x, y }, items.filter((item) => item.id !== id), cols);
}

export function resizeItem(items: PackItem[], id: string, w: number, h: number, cols = GRID_COLS): PackItem[] {
  const current = items.find((item) => item.id === id);
  if (!current) return compact(items, cols);
  return settle({ ...current, w, h }, items.filter((item) => item.id !== id), cols);
}

/** File read, row scan, and request bytes. 100 is the parsed response, not a timer. */
export function stagePercent(stage: "read" | "scan" | "upload" | "done", ratio: number): number {
  const t = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
  if (stage === "read") return Math.round(t * 35);
  if (stage === "scan") return Math.round(35 + t * 15);
  if (stage === "upload") return Math.round(50 + t * 45);
  return 100;
}
