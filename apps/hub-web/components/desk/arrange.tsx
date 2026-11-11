"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GripVertical } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { api } from "@/lib/api";
import { useToast } from "@/components/toast";
import { hideTile, moveAnnouncement, moveTile, readLayout, resizeTile, showTile, sizeFromDrag, stepTile, tileLimits, type DeskLayout, type TileSize } from "./layout";
import { useSpaceAccess } from "@/lib/access";
import { measureBoxes, motionReduced, perFrame, playFlip, type Box } from "@/lib/motion/drag";

/**
 * Moving, resizing and hiding tiles on any 12-column `.bento` grid. Today's desk and the
 * Context overview both use this, each with its own preference key.
 */

export type Arrangeable = { key: string; title: string; c: number; r: number; hero?: boolean };

/**
 * Keyboard moves reorder the grid without a visible cue for screen readers, so the new
 * position is spoken from one polite region on the page. It outlives the tile that moved.
 */
function announce(text: string) {
  if (!text || typeof document === "undefined") return;
  let region = document.getElementById("desk-arrange-status");
  if (!region) {
    region = document.createElement("div");
    region.id = "desk-arrange-status";
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    region.className = "sr-only";
    document.body.append(region);
  }
  // The same words twice in a row would not be read again.
  region.textContent = region.textContent === text ? `${text}\u00a0` : text;
}
type Prefs = Awaited<ReturnType<typeof api.preferences>>;

/** A layout preference with an optimistic write and a rollback on failure. */
export function useLayoutPreference(key: string) {
  const client = useQueryClient();
  const toast = useToast();
  const prefs = useQuery({ queryKey: ["preferences"], queryFn: api.preferences, staleTime: 30_000 });
  const layout = readLayout(prefs.data?.preferences.find((row) => row.key === key)?.value);
  const save = useCallback(
    async (next: DeskLayout | null) => {
      const before = client.getQueryData<Prefs>(["preferences"]);
      const rest = (before?.preferences ?? []).filter((row) => row.key !== key);
      client.setQueryData<Prefs>(["preferences"], { preferences: next ? [...rest, { key, value: next } as Prefs["preferences"][number]] : rest });
      try {
        if (next) await api.putPreference(key, next);
        else await api.deletePreference(key);
      } catch (error) {
        if (before) client.setQueryData(["preferences"], before);
        toast((error as Error).message, { tone: "error" });
      }
    },
    [client, key, toast],
  );
  return { ready: prefs.isSuccess, layout, save, prefs };
}

export type TileControls = {
  deskKey: string;
  attrs: Record<string, string | undefined>;
  grip?: ReactNode;
  corner?: ReactNode;
  onHide?: () => void;
};

/** The tiles of the grid `section` sits in, with their keys. */
function gridTiles(grid: Element | null | undefined): HTMLElement[] {
  return grid ? [...grid.querySelectorAll<HTMLElement>(":scope > [data-desk-key]")] : [];
}
const tileKey = (element: HTMLElement) => element.dataset.deskKey;

/** The floating label that follows the pointer while a tile is moved: its icon and title, lifted. */
function dragChip(section: HTMLElement, title: string): HTMLElement {
  const chip = document.createElement("div");
  chip.className = "desk-drag-ghost";
  chip.setAttribute("aria-hidden", "true");
  const icon = section.querySelector(".th .ti svg")?.cloneNode(true);
  if (icon) chip.append(icon);
  const label = document.createElement("span");
  label.textContent = title;
  chip.append(label);
  return lift(chip, section);
}

/** Puts a drag layer on the page with the desk's accent (a desk can carry its own). */
function lift(layer: HTMLElement, section: HTMLElement): HTMLElement {
  const style = getComputedStyle(section);
  for (const name of ["--accent", "--accent-rgb"]) {
    const value = style.getPropertyValue(name);
    if (value) layer.style.setProperty(name, value);
  }
  document.body.append(layer);
  return layer;
}

/** Fades a drag layer out and removes it. */
function dismiss(layer: HTMLElement | null, reduced: boolean) {
  if (!layer) return;
  if (reduced || typeof layer.animate !== "function") {
    layer.remove();
    return;
  }
  layer.animate([{ opacity: 1 }, { opacity: 0, scale: "0.97" }], { duration: 120, easing: "ease-out", fill: "forwards" }).finished.then(
    () => layer.remove(),
    () => layer.remove(),
  );
}

export function useTileControls<S extends Arrangeable>({
  shown,
  hidden,
  save,
  customized,
  mobile,
  restoreHint,
}: {
  shown: S[];
  hidden: string[];
  save: (next: DeskLayout | null) => Promise<void>;
  customized: boolean;
  mobile?: boolean;
  /** Where a hidden tile comes back from, for the toast. */
  restoreHint: string;
}) {
  const toast = useToast();
  // A space shared with you keeps its owner's arrangement: no grips, no resizing, no hiding.
  const access = useSpaceAccess();
  const fixed = Boolean(mobile) || access.guest;
  const arranged = { shown, hidden };
  // Reordering moves the focused tile's section, and the browser drops focus to <body>. Put it back on the grip.
  const refocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    const key = refocus.current;
    if (!key) return;
    refocus.current = null;
    document.querySelector<HTMLElement>(`[data-desk-key="${CSS.escape(key)}"] .tgrip`)?.focus();
  });

  // A move, resize or hide is drawn without React state while the pointer is down (the desk is costly to
  // render), then saved once. When the saved arrangement renders, every tile glides from where it was.
  const signature = `${shown.map((item) => `${item.key}:${item.c}x${item.r}`).join("|")}/${hidden.join(",")}`;
  const flip = useRef<{ grid: Element; boxes: Map<string, Box>; signature: string; at: number } | null>(null);
  const remember = (grid: Element | null | undefined) => {
    if (grid) flip.current = { grid, boxes: measureBoxes(gridTiles(grid), tileKey), signature, at: performance.now() };
  };
  useLayoutEffect(() => {
    const pending = flip.current;
    if (!pending) return;
    if (pending.signature === signature) {
      if (performance.now() - pending.at > 2000) flip.current = null;
      return;
    }
    flip.current = null;
    if (pending.grid.isConnected) playFlip(gridTiles(pending.grid), tileKey, pending.boxes);
  });

  function startResize(event: ReactPointerEvent<HTMLElement>, spec: S) {
    if (event.button !== 0) return;
    const handle = event.currentTarget;
    const section = handle.closest<HTMLElement>("section");
    const grid = section?.parentElement;
    if (!section || !grid) return;
    event.preventDefault();
    event.stopPropagation();
    const style = getComputedStyle(grid);
    const gap = Number.parseFloat(style.columnGap) || 12;
    const row = Number.parseFloat(style.gridAutoRows) || 72;
    const column = (grid.clientWidth - gap * 11) / 12;
    const limits = tileLimits(spec);
    const start = { c: spec.c, r: spec.r };
    const x0 = event.clientX;
    const y0 = event.clientY;
    const reduced = motionReduced();
    let last = start;
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // the pointer already ended
    }
    document.body.dataset.deskResizing = "1";
    section.dataset.resizing = "1";
    // A live outline of the snapped size; the tile and its neighbours keep still until the release.
    const outline = document.createElement("div");
    outline.className = "desk-resize-outline";
    outline.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    outline.append(label);
    lift(outline, section);
    const place = () => {
      const box = section.getBoundingClientRect();
      outline.style.transform = `translate3d(${box.left}px, ${box.top}px, 0)`;
      outline.style.width = `${last.c * column + (last.c - 1) * gap}px`;
      outline.style.height = `${last.r * row + (last.r - 1) * gap}px`;
      label.textContent = `${last.c} × ${last.r}`;
    };
    place();
    const update = perFrame((x: number, y: number) => {
      last = sizeFromDrag(start, { dx: x - x0, dy: y - y0 }, { column, row, gap }, limits);
      place();
    });
    const move = (next: PointerEvent) => update(next.clientX, next.clientY);
    const finish = (apply: boolean) => {
      if (apply) update.flush();
      else update.cancel();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key, true);
      delete document.body.dataset.deskResizing;
      delete section.dataset.resizing;
      dismiss(outline, reduced);
      if (apply && (last.c !== start.c || last.r !== start.r)) {
        remember(grid);
        void save(resizeTile(arranged, spec.key, last));
      }
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    const key = (next: KeyboardEvent) => {
      if (next.key !== "Escape") return;
      next.preventDefault();
      next.stopPropagation();
      finish(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
  }

  function resizeByKey(event: ReactKeyboardEvent<HTMLElement>, spec: S) {
    const step = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[event.key];
    if (!step) return;
    event.preventDefault();
    const next = resizeTile(arranged, spec.key, { c: spec.c + step[0]!, r: spec.r + step[1]! });
    const size = next.tiles.find((tile) => tile.key === spec.key);
    if (size) announce(`${spec.title} is ${size.c} columns by ${size.r} rows.`);
    remember(event.currentTarget.closest("section")?.parentElement);
    void save(next);
  }

  function startMove(event: ReactPointerEvent<HTMLElement>, spec: S) {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const section = handle.closest<HTMLElement>("section");
    const grid = section?.parentElement;
    if (!section || !grid) return;
    const x0 = event.clientX;
    const y0 = event.clientY;
    const reduced = motionReduced();
    let chip: HTMLElement | null = null;
    let target: { key: string; after: boolean } | null = null;
    let marked: HTMLElement | null = null;
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // the pointer already ended
    }
    const mark = (next: HTMLElement | null, after: boolean) => {
      if (marked && marked !== next) delete marked.dataset.drop;
      marked = next;
      if (next) next.dataset.drop = after ? "after" : "before";
    };
    // Which tile is under the pointer, and which half: once a frame at most.
    const aim = perFrame((x: number, y: number) => {
      const over = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-desk-key]");
      const key = over?.dataset.deskKey;
      if (!over || !key || key === spec.key || over.parentElement !== grid) {
        target = null;
        mark(null, false);
        return;
      }
      const rect = over.getBoundingClientRect();
      const after = x > rect.left + rect.width / 2;
      if (target?.key !== key || target.after !== after) {
        target = { key, after };
        mark(over, after);
      }
    });
    const move = (next: PointerEvent) => {
      if (!chip) {
        if (Math.hypot(next.clientX - x0, next.clientY - y0) < 4) return;
        chip = dragChip(section, spec.title);
        section.dataset.dragging = "1";
        document.body.dataset.deskMoving = "1";
        if (!reduced) chip.animate([{ opacity: 0, scale: "0.96" }, { opacity: 1, scale: "1.02" }], { duration: 140, easing: "cubic-bezier(0.2, 0, 0, 1)" });
      }
      // In the event itself, so the chip never trails the pointer by a frame.
      chip.style.transform = `translate3d(${next.clientX - 14}px, ${next.clientY - 18}px, 0)`;
      aim(next.clientX, next.clientY);
    };
    const finish = (apply: boolean) => {
      aim.cancel();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key, true);
      delete document.body.dataset.deskMoving;
      delete section.dataset.dragging;
      mark(null, false);
      dismiss(chip, reduced);
      if (!apply || !chip || !target) return;
      const index = shown.findIndex((item) => item.key === target!.key);
      const before = target.after ? (shown[index + 1]?.key ?? null) : target.key;
      remember(grid);
      void save(moveTile(arranged, spec.key, before));
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    const key = (next: KeyboardEvent) => {
      if (next.key !== "Escape" || !chip) return;
      next.preventDefault();
      next.stopPropagation();
      finish(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
  }

  function moveByKey(event: ReactKeyboardEvent<HTMLElement>, spec: S) {
    const delta = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : 0;
    if (!delta) return;
    event.preventDefault();
    refocus.current = spec.key;
    announce(moveAnnouncement(spec.title, shown.map((item) => item.key), spec.key, delta));
    remember(event.currentTarget.closest("section")?.parentElement);
    void save(stepTile(arranged, spec.key, delta));
  }

  function hide(spec: S) {
    const before = customized ? { v: 1 as const, tiles: shown.map((item) => ({ key: item.key, c: item.c, r: item.r })), hidden } : null;
    remember(document.querySelector(`[data-desk-key="${CSS.escape(spec.key)}"]`)?.parentElement);
    void save(hideTile(arranged, spec.key));
    toast(`Hid ${spec.title}. ${restoreHint}`, {
      action: { label: "Undo", run: () => void save(before ?? showTile({ shown: shown.filter((item) => item.key !== spec.key), hidden }, spec)) },
    });
  }

  /** A tile's size. Resizing previews in an outline, so this is always the saved size. */
  const sizeOf = (spec: S): TileSize => spec;

  const controls = (spec: S): TileControls => ({
    deskKey: spec.key,
    // data-dragging, data-drop and data-resizing are set on the tile directly during a gesture.
    attrs: {},
    grip: fixed ? undefined : (
      <button
        type="button"
        className="tgrip"
        aria-label={`Move ${spec.title}. Drag, or use the arrow keys.`}
        title="Drag to move"
        onPointerDown={(event) => startMove(event, spec)}
        onKeyDown={(event) => moveByKey(event, spec)}
      >
        <GripVertical size={12} />
      </button>
    ),
    corner: fixed ? undefined : (
      <button
        type="button"
        className="tresize"
        aria-label={`Resize ${spec.title}, ${sizeOf(spec).c} columns by ${sizeOf(spec).r} rows. Use the arrow keys.`}
        title="Drag to resize"
        onPointerDown={(event) => startResize(event, spec)}
        onKeyDown={(event) => resizeByKey(event, spec)}
      />
    ),
    onHide: fixed && !mobile ? undefined : () => hide(spec),
  });

  return { sizeOf, controls };
}
