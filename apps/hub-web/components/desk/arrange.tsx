"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GripVertical } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { api } from "@/lib/api";
import { useToast } from "@/components/toast";
import { hideTile, moveTile, readLayout, resizeTile, showTile, sizeFromDrag, stepTile, tileLimits, type DeskLayout, type TileSize } from "./layout";

/**
 * Moving, resizing and hiding tiles on any 12-column `.bento` grid. Today's desk and the
 * Context overview both use this, each with its own preference key.
 */

export type Arrangeable = { key: string; title: string; c: number; r: number; hero?: boolean };
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
  const [preview, setPreview] = useState<({ key: string } & TileSize) | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ key: string; after: boolean } | null>(null);
  const arranged = { shown, hidden };
  // Reordering moves the focused tile's section, and the browser drops focus to <body>. Put it back on the grip.
  const refocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    const key = refocus.current;
    if (!key) return;
    refocus.current = null;
    document.querySelector<HTMLElement>(`[data-desk-key="${CSS.escape(key)}"] .tgrip`)?.focus();
  });

  function startResize(event: ReactPointerEvent<HTMLElement>, spec: S) {
    if (event.button !== 0) return;
    const grid = event.currentTarget.closest("section")?.parentElement;
    if (!grid) return;
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
    let last = start;
    document.body.dataset.deskResizing = "1";
    const move = (next: PointerEvent) => {
      last = sizeFromDrag(start, { dx: next.clientX - x0, dy: next.clientY - y0 }, { column, row, gap }, limits);
      setPreview({ key: spec.key, ...last });
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      delete document.body.dataset.deskResizing;
      setPreview(null);
      if (last.c !== start.c || last.r !== start.r) void save(resizeTile(arranged, spec.key, last));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  function resizeByKey(event: ReactKeyboardEvent<HTMLElement>, spec: S) {
    const step = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[event.key];
    if (!step) return;
    event.preventDefault();
    void save(resizeTile(arranged, spec.key, { c: spec.c + step[0]!, r: spec.r + step[1]! }));
  }

  function startMove(event: ReactPointerEvent<HTMLElement>, spec: S) {
    if (event.button !== 0) return;
    event.preventDefault();
    const x0 = event.clientX;
    const y0 = event.clientY;
    let moved = false;
    let target: { key: string; after: boolean } | null = null;
    const move = (next: PointerEvent) => {
      if (!moved && Math.hypot(next.clientX - x0, next.clientY - y0) < 4) return;
      if (!moved) {
        moved = true;
        setDragging(spec.key);
        document.body.dataset.deskMoving = "1";
      }
      const over = document.elementFromPoint(next.clientX, next.clientY)?.closest<HTMLElement>("[data-desk-key]");
      const key = over?.dataset.deskKey;
      if (!over || !key || key === spec.key) {
        target = null;
        setDrop(null);
        return;
      }
      const rect = over.getBoundingClientRect();
      target = { key, after: next.clientX > rect.left + rect.width / 2 };
      setDrop(target);
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      delete document.body.dataset.deskMoving;
      setDragging(null);
      setDrop(null);
      if (!moved || !target) return;
      const index = shown.findIndex((item) => item.key === target!.key);
      const before = target.after ? (shown[index + 1]?.key ?? null) : target.key;
      void save(moveTile(arranged, spec.key, before));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  function moveByKey(event: ReactKeyboardEvent<HTMLElement>, spec: S) {
    const delta = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : 0;
    if (!delta) return;
    event.preventDefault();
    refocus.current = spec.key;
    void save(stepTile(arranged, spec.key, delta));
  }

  function hide(spec: S) {
    const before = customized ? { v: 1 as const, tiles: shown.map((item) => ({ key: item.key, c: item.c, r: item.r })), hidden } : null;
    void save(hideTile(arranged, spec.key));
    toast(`Hid ${spec.title}. ${restoreHint}`, {
      action: { label: "Undo", run: () => void save(before ?? showTile({ shown: shown.filter((item) => item.key !== spec.key), hidden }, spec)) },
    });
  }

  const sizeOf = (spec: S): TileSize => (preview?.key === spec.key ? preview : spec);

  const controls = (spec: S): TileControls => ({
    deskKey: spec.key,
    attrs: {
      "data-dragging": dragging === spec.key ? "1" : undefined,
      "data-drop": drop?.key === spec.key ? (drop.after ? "after" : "before") : undefined,
      "data-resizing": preview?.key === spec.key ? "1" : undefined,
    },
    grip: mobile ? undefined : (
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
    corner: mobile ? undefined : (
      <button
        type="button"
        className="tresize"
        aria-label={`Resize ${spec.title}, ${sizeOf(spec).c} columns by ${sizeOf(spec).r} rows. Use the arrow keys.`}
        title="Drag to resize"
        onPointerDown={(event) => startResize(event, spec)}
        onKeyDown={(event) => resizeByKey(event, spec)}
      />
    ),
    onHide: () => hide(spec),
  });

  return { sizeOf, controls };
}
