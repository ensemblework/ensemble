"use client";

import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  closestCenter,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type Modifier,
} from "@dnd-kit/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { hasModule } from "@ensemble/shared-types/modules";
import { MARKET_CARDS } from "@ensemble/shared-types/marketplace-manifest";
import {
  ROW_PX,
  SIZES,
  SIZE_RANK,
  TILE_ACCENTS,
  WIDGET_REGISTRY,
  moveByCell,
  moveToIndex,
  packPlacements,
  placementKey,
  stepSize,
  tileLabel,
  widgetIdsFor,
  withSize,
  type LayoutDocument,
  type LayoutSurface,
  type Placement,
  type Size,
  type TileConfig,
  type WidgetId,
} from "@ensemble/shared-types/widgets";
import { api } from "@/lib/api";
import { useToast } from "@/components/toast";

const XL_LIMIT = "Only one extra-large tile fits on this page. Shrink the other one first.";

/** Keep the drag chip inside the window. The overlay is anchored on the tile, then translated by the pointer. */
const keepOverlayInView: Modifier = ({ transform, activeNodeRect, overlayNodeRect, windowRect }) => {
  if (!activeNodeRect || !windowRect) return transform;
  const pad = 8;
  const width = Math.min(overlayNodeRect?.width ?? activeNodeRect.width, Math.max(40, windowRect.width - pad * 2));
  const height = Math.min(overlayNodeRect?.height ?? activeNodeRect.height, Math.max(32, windowRect.height - pad * 2));
  const left = activeNodeRect.left + transform.x;
  const top = activeNodeRect.top + transform.y;
  const minLeft = windowRect.left + pad;
  const minTop = windowRect.top + pad;
  const maxLeft = Math.max(minLeft, windowRect.left + windowRect.width - pad - width);
  const maxTop = Math.max(minTop, windowRect.top + windowRect.height - pad - height);
  const nextLeft = Math.min(Math.max(left, minLeft), maxLeft);
  const nextTop = Math.min(Math.max(top, minTop), maxTop);
  return { ...transform, x: transform.x + (nextLeft - left), y: transform.y + (nextTop - top) };
};

/** The tile under the pointer wins. Closest-center misses the middle of a neighbour when a large tile is closer to its own center. */
const tileAtPointer: CollisionDetection = (args) => {
  const pointed = pointerWithin(args);
  if (pointed.length) return pointed;
  const overlapping = rectIntersection(args);
  if (overlapping.length) return overlapping;
  return closestCenter(args);
};

function friendlyLayoutError(message: string): string {
  if (/extra-large/i.test(message)) return XL_LIMIT;
  if (/at most 12/i.test(message)) return "Twelve tiles is the limit.";
  if (/cannot be/i.test(message)) return "That size isn't available for this tile.";
  return "Couldn't save the layout. Adjust the tiles and try again.";
}

export function EditCanvas({
  surface,
  initial,
  columns,
  phone,
  onClose,
  render,
}: {
  surface: LayoutSurface;
  initial: LayoutDocument;
  columns: number;
  phone: boolean;
  onClose: () => void;
  render: (type: WidgetId, size: Size, placement?: Placement) => ReactNode;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<LayoutDocument>(initial);
  const [focus, setFocus] = useState<string | null>(draft.placements[0]?.type ?? null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [gallery, setGallery] = useState(false);
  const packed = useMemo(() => packPlacements(draft.placements, columns, phone) ?? [], [draft.placements, columns, phone]);
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 60_000 });
  const available = widgetIdsFor(surface).filter((id) => {
    const spec = WIDGET_REGISTRY[id];
    if (spec.requires && !hasModule(shell.data?.modules, spec.requires)) return false;
    const count = draft.placements.filter((row) => row.type === id).length;
    return count < (spec.repeatable ? 2 : 1);
  });
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 160, tolerance: 8 } }),
  );

  const save = async () => {
    setBusy(true);
    try {
      await api.saveLayout(surface, draft);
      await client.invalidateQueries({ queryKey: ["layout", surface] });
      onClose();
    } catch (error) {
      toast(friendlyLayoutError((error as Error).message), { tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (!window.confirm("Reset this layout to the template? Tasks and people stay.")) return;
    setBusy(true);
    try {
      await api.resetLayout(surface);
      await client.invalidateQueries({ queryKey: ["layout", surface] });
      onClose();
    } catch (error) {
      toast(friendlyLayoutError((error as Error).message), { tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const xlTaken = (type: string) => draft.placements.some((row) => row.type !== type && row.size === "xl");

  const applySize = (type: string, size: Size) => {
    if (size === "xl" && xlTaken(type)) {
      toast(XL_LIMIT);
      return;
    }
    setDraft({ ...draft, placements: withSize(draft.placements, type, size, columns, phone) });
  };

  const resize = (type: string, direction: 1 | -1) => {
    const row = draft.placements.find((item) => placementKey(item) === type);
    if (!row) return;
    const size = stepSize(row.type, row.size, direction);
    applySize(type, size);
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      if (gallery) {
        event.preventDefault();
        setGallery(false);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (gallery) return;
    if (!focus) return;
    if (event.key === "[" || event.key === "]") {
      event.preventDefault();
      resize(focus, event.key === "]" ? 1 : -1);
      return;
    }
    const delta =
      event.key === "ArrowLeft" ? [-1, 0] : event.key === "ArrowRight" ? [1, 0] : event.key === "ArrowUp" ? [0, -1] : event.key === "ArrowDown" ? [0, 1] : null;
    if (!delta) return;
    event.preventDefault();
    setDraft({ ...draft, placements: moveByCell(draft.placements, focus, delta[0]!, delta[1]!, columns, phone) });
  };

  const onDragOver = (event: DragOverEvent) => {
    const next = event.over ? String(event.over.id) : null;
    setOverId(next && next !== String(event.active.id) ? next : null);
  };

  const onDragEnd = (event: DragEndEvent) => {
    setDragging(null);
    setOverId(null);
    const active = String(event.active.id);
    const over = event.over ? String(event.over.id) : "";
    if (!over || over === active) return;
    const index = draft.placements.findIndex((row) => placementKey(row) === over);
    if (index < 0) return;
    setDraft({ ...draft, placements: moveToIndex(draft.placements, active, index) });
    setFocus(active);
  };

  return (
    <div data-layout-editing={surface} onKeyDown={onKey}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void save()}>
          Done
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn-ghost" disabled={busy} onClick={() => void reset()}>
          Reset to template
        </button>
        <p className="text-[12px] text-muted">Drag a tile to move it. Arrows move it too.</p>
        {available.length ? (
          <button type="button" className="btn ml-auto" onClick={() => setGallery(true)}>
            Add a tile
          </button>
        ) : null}
      </div>
      {gallery ? (
        <TileGallery
          surface={surface}
          ids={available}
          templateId={shell.data?.activeTemplateId}
          onClose={() => setGallery(false)}
          onAdd={(id) => {
            if (draft.placements.length >= 12) {
              toast("Twelve tiles is the limit.");
              return;
            }
            const size = WIDGET_REGISTRY[id].defaultSize;
            if (size === "xl" && draft.placements.some((row) => row.size === "xl")) {
              toast(XL_LIMIT);
              return;
            }
            const slot = WIDGET_REGISTRY[id].repeatable && draft.placements.some((row) => row.type === id) ? 1 : undefined;
            const placements: Placement[] = [...draft.placements, { type: id, size, ...(slot ? { slot } : {}) }];
            setDraft({ ...draft, placements });
            setFocus(placementKey({ type: id, slot }));
            setGallery(false);
          }}
        />
      ) : null}
      <DndContext
        sensors={sensors}
        collisionDetection={tileAtPointer}
        onDragStart={(event) => {
          setDragging(String(event.active.id));
          setOverId(null);
        }}
        onDragOver={onDragOver}
        onDragCancel={() => {
          setDragging(null);
          setOverId(null);
        }}
        onDragEnd={onDragEnd}
      >
        <div
          className="grid gap-3"
          data-widget-grid={surface}
          data-columns={columns}
          data-phone={phone ? "1" : "0"}
          data-dragging={dragging ?? ""}
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridAutoRows: `${ROW_PX}px` }}
        >
          {packed.map((cell) => {
            const key = placementKey(cell);
            return (
              <EditTile
                key={key}
                cell={cell}
                focused={focus === key}
                dropTarget={overId === key}
                xlBlocked={cell.size !== "xl" && xlTaken(key)}
                onFocus={() => setFocus(key)}
                onSize={(size) => applySize(key, size)}
                onRemove={() => setDraft({ ...draft, placements: draft.placements.filter((row) => placementKey(row) !== key) })}
                onConfig={(config) =>
                  setDraft({
                    ...draft,
                    v: 2,
                    placements: draft.placements.map((row) => (placementKey(row) === key ? { ...row, config } : row)),
                  })
                }
                render={render}
              />
            );
          })}
        </div>
        <DragOverlay dropAnimation={null} modifiers={[keepOverlayInView]} style={{ width: "max-content", height: "auto", maxWidth: "calc(100vw - 16px)" }}>
          {dragging ? (
            <div className="widget-drag-overlay w-max max-w-[calc(100vw-16px)] rounded-xl bg-panel px-4 py-3 text-[12px] font-medium uppercase tracking-[0.14em] text-ink shadow-lg">
              {WIDGET_REGISTRY[dragging.split("#")[0] as WidgetId]?.label ?? dragging}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

function EditTile({
  cell,
  focused,
  dropTarget,
  xlBlocked,
  onFocus,
  onSize,
  onRemove,
  onConfig,
  render,
}: {
  cell: Placement & { x: number; y: number; w: number; h: number };
  focused: boolean;
  dropTarget: boolean;
  xlBlocked: boolean;
  onFocus: () => void;
  onSize: (size: Size) => void;
  onRemove: () => void;
  onConfig: (config: TileConfig) => void;
  render: (type: WidgetId, size: Size, placement?: Placement) => ReactNode;
}) {
  const spec = WIDGET_REGISTRY[cell.type];
  const key = placementKey(cell);
  const [settings, setSettings] = useState(false);
  const drag = useDraggable({ id: key });
  const drop = useDroppable({ id: key });
  return (
    <section
      ref={(node) => {
        drag.setNodeRef(node);
        drop.setNodeRef(node);
      }}
      role="region"
      aria-label={tileLabel(cell)}
      data-widget={cell.type}
      data-accent={cell.config?.accent || undefined}
      data-density={cell.config?.density ?? "comfortable"}
      data-size={cell.size}
      data-drop-target={dropTarget ? cell.type : undefined}
      tabIndex={0}
      onFocus={onFocus}
      className={`widget-tile tile widget-edit group relative rounded-xl bg-panel/80${focused ? " widget-focused" : ""}`}
      style={{
        gridColumn: `${cell.x + 1} / span ${cell.w}`,
        gridRow: `${cell.y + 1} / span ${cell.h}`,
        opacity: drag.isDragging ? 0.55 : 1,
        zIndex: drag.isDragging ? 2 : undefined,
      }}
    >
      <div className="flex items-center gap-2 px-3 pt-2">
        <div
          data-drag-handle={cell.type}
          className="cursor-grab touch-none text-[11px] font-medium uppercase tracking-[0.14em] text-faint active:cursor-grabbing"
          {...drag.listeners}
          {...drag.attributes}
        >
          {tileLabel(cell)}
        </div>
        <div className="ml-auto flex items-center gap-1">
          {SIZES.map((size) => {
            const illegal = SIZE_RANK[size] < SIZE_RANK[spec.min] || SIZE_RANK[size] > SIZE_RANK[spec.max];
            const blocked = size === "xl" && xlBlocked;
            return (
              <button
                key={size}
                type="button"
                disabled={illegal || blocked}
                title={blocked ? XL_LIMIT : undefined}
                aria-pressed={cell.size === size}
                className="btn px-1.5 py-0 text-[11px] uppercase disabled:opacity-30"
                onClick={() => onSize(size)}
              >
                {size}
              </button>
            );
          })}
          <button type="button" className="btn-ghost px-1.5 py-0 text-[12px]" aria-expanded={settings} onClick={() => setSettings((open) => !open)}>
            Settings
          </button>
          <button type="button" className="btn-ghost px-1.5 py-0 text-[12px]" onClick={onRemove}>
            Remove
          </button>
        </div>
      </div>
      {settings ? <TileSettings cell={cell} onChange={onConfig} /> : null}
      <div className="widget-body px-3 pb-2">{render(cell.type, cell.size, cell)}</div>
      <button
        type="button"
        aria-label={`Resize ${spec.label}, ${sizeName(cell.size)}`}
        className="widget-resize absolute bottom-1 right-1 cursor-nwse-resize rounded-md border border-line bg-panel/90"
        onPointerDown={(event) => {
          event.stopPropagation();
          const startX = event.clientX;
          const start = cell.size;
          let applied = start;
          const handle = event.currentTarget;
          handle.setPointerCapture(event.pointerId);
          const move = (ev: PointerEvent) => {
            const steps = Math.round((ev.clientX - startX) / 48);
            if (!steps) return;
            let walked: Size = start;
            const dir = steps > 0 ? 1 : -1;
            for (let i = 0; i < Math.min(Math.abs(steps), 3); i += 1) walked = stepSize(cell.type, walked, dir);
            if (walked === applied) return;
            applied = walked;
            onSize(walked);
          };
          const up = () => {
            handle.removeEventListener("pointermove", move);
            handle.removeEventListener("pointerup", up);
          };
          handle.addEventListener("pointermove", move);
          handle.addEventListener("pointerup", up);
        }}
      />
    </section>
  );
}

function sizeName(size: Size): string {
  return { s: "small", m: "medium", l: "large", xl: "extra large" }[size];
}

function TileSettings({ cell, onChange }: { cell: Placement; onChange: (config: TileConfig) => void }) {
  const feed = useQuery({ queryKey: ["widget-feed"], queryFn: api.widgetFeed, staleTime: 60_000 });
  const prefs = useQuery({ queryKey: ["preferences"], queryFn: api.preferences, staleTime: 30_000 });
  const plots = prefs.data?.preferences.some((row) => row.key === "desk.plots" && row.value === true) === true;
  const config = cell.config ?? {};
  const patch = (next: TileConfig) => onChange(next);
  return (
    <div className="mx-3 mb-2 rounded-lg border border-line bg-bg px-2.5 py-2 text-[12.5px]" role="group" aria-label={`${tileLabel(cell)} settings`}>
      <label className="block text-muted">
        Title
        <input
          value={config.title ?? ""}
          maxLength={40}
          placeholder={WIDGET_REGISTRY[cell.type].label}
          className="field mt-1 w-full"
          onChange={(event) => patch({ ...config, title: event.target.value })}
        />
      </label>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <span className="text-muted">Density</span>
        {(["comfortable", "compact"] as const).map((density) => (
          <button key={density} type="button" className="btn px-1.5 py-0" aria-pressed={(config.density ?? "comfortable") === density} onClick={() => patch({ ...config, density })}>
            {density}
          </button>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <span className="text-muted">Accent</span>
        {TILE_ACCENTS.map((accent) => (
          <button
            key={accent}
            type="button"
            aria-label={accent}
            aria-pressed={config.accent === accent}
            className="h-4 w-4 rounded-full border border-line"
            data-accent={accent}
            style={{ background: accent === "accent" ? "var(--accent)" : `var(--kind-${accent === "deliverable" ? "deliverable" : accent})` }}
            onClick={() => patch({ ...config, accent })}
          />
        ))}
      </div>
      {cell.type === "daily-target" ? (
        <label className="mt-2 block text-muted">
          Target
          <input
            type="number"
            min={1}
            max={50}
            value={config.target ?? 20}
            className="field mt-1 w-20"
            onChange={(event) => patch({ ...config, target: Math.max(1, Math.min(50, Number(event.target.value) || 1)) })}
          />
        </label>
      ) : null}
      {cell.type === "reading-queue" ? (
        <div className="mt-2 flex gap-1">
          {(["tasks", "artifacts"] as const).map((source) => (
            <button key={source} type="button" className="btn px-1.5 py-0" aria-pressed={(config.source ?? "tasks") === source} onClick={() => patch({ ...config, source })}>
              {source}
            </button>
          ))}
        </div>
      ) : null}
      {plots ? (
        <div className="mt-2 rounded-lg border border-dashed border-line px-2 py-2 text-faint" aria-disabled="true">
          <div className="flex items-center justify-between gap-2">
            <span>Chart type</span>
            <span className="rounded-md border border-line px-2 py-0.5 text-[12px]">Line</span>
          </div>
          <p className="mt-1 text-[11.5px]">Reserved for Plots. This row stays greyed, and it is hidden while the plots flag is off.</p>
        </div>
      ) : null}
      {feed.data?.projects.length ? (
        <label className="mt-2 block text-muted">
          Project
          <select
            className="field mt-1 w-full"
            value={config.projectId ?? ""}
            onChange={(event) => patch({ ...config, projectId: event.target.value || undefined })}
          >
            <option value="">Any</option>
            {feed.data.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}

function TileGallery({
  surface,
  ids,
  templateId,
  onAdd,
  onClose,
}: {
  surface: LayoutSurface;
  ids: WidgetId[];
  templateId?: string | null;
  onAdd: (id: WidgetId) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const prefs = useQuery({ queryKey: ["preferences"], queryFn: api.preferences, staleTime: 30_000 });
  const plots = prefs.data?.preferences.some((row) => row.key === "desk.plots" && row.value === true) === true;
  const preferred = new Set(MARKET_CARDS.find((card) => card.id === templateId)?.widgets ?? []);
  const query = q.trim().toLowerCase();
  const rows = ids.filter((id) => {
    const spec = WIDGET_REGISTRY[id];
    if (!query) return true;
    return `${spec.label} ${spec.blurb ?? ""} ${spec.persona ?? ""}`.toLowerCase().includes(query);
  });
  const groups = [
    { id: "template", label: "From this template", ids: rows.filter((id) => preferred.has(id)) },
    { id: "shared", label: "Shared", ids: rows.filter((id) => !preferred.has(id) && !WIDGET_REGISTRY[id].persona) },
    { id: "persona", label: "Personas", ids: rows.filter((id) => !preferred.has(id) && WIDGET_REGISTRY[id].persona) },
  ].filter((group) => group.ids.length);
  const flat = groups.flatMap((group) => group.ids);
  useEffect(() => {
    search.current?.focus();
  }, []);
  useEffect(() => {
    setCursor(0);
  }, [q]);
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      setCursor((index) => {
        const next = event.key === "ArrowDown" ? index + 1 : index - 1;
        return (next + flat.length) % Math.max(flat.length, 1);
      });
      return;
    }
    if (event.key === "Enter" && flat[cursor]) {
      event.preventDefault();
      event.stopPropagation();
      onAdd(flat[cursor]);
    }
  };
  return (
    <div className="mb-3 rounded-xl border border-line bg-panel p-3" onKeyDown={onKey} role="dialog" aria-label="Add a tile">
      <div className="flex items-center gap-2">
        <input ref={search} value={q} onChange={(event) => setQ(event.target.value)} placeholder="Search tiles" aria-label="Search tiles" className="field w-full" />
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </div>
      {plots ? (
        <div className="mt-3" data-plots-category>
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-faint">Plots · soon</div>
          <p className="mt-1 text-[12.5px] text-muted">Plot, Trend over time, and Breakdown are reserved. They cannot be added yet.</p>
          <div className="mt-1 grid gap-1 sm:grid-cols-3">
            {["Plot", "Trend over time", "Breakdown"].map((name) => (
              <div key={name} className="rounded-lg border border-dashed border-line px-2.5 py-2 text-[13px] text-faint" aria-disabled="true">
                {name}
                <div className="text-[11px]">Coming soon</div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {flat.length === 0 ? (
        <p className="mt-3 text-[13px] text-muted">Nothing matches. Clear the search to see the catalog.</p>
      ) : (
        groups.map((group) => (
          <div key={group.id} className="mt-3">
            <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-faint">{group.label}</div>
            <div className="mt-1 grid gap-1 sm:grid-cols-2">
              {group.ids.map((id) => {
                const spec = WIDGET_REGISTRY[id];
                const index = flat.indexOf(id);
                return (
                  <button
                    key={id}
                    type="button"
                    data-gallery-tile={id}
                    aria-selected={index === cursor}
                    className={`rounded-lg border px-2.5 py-2 text-left ${index === cursor ? "border-accent bg-accent-soft" : "border-line hover:border-line-strong"}`}
                    onMouseEnter={() => setCursor(index)}
                    onClick={() => onAdd(id)}
                  >
                    <div className="text-[13px] font-medium">{spec.label}</div>
                    <div className="text-[12px] text-muted">{spec.blurb ?? `${spec.label} on ${surface}`}</div>
                  </button>
                );
              })}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
