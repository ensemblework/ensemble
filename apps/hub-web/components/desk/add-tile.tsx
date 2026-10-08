"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, RotateCcw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { hasModule } from "@ensemble/shared-types/modules";
import { MARKET_CARDS } from "@ensemble/shared-types/marketplace-manifest";
import { WIDGET_REGISTRY, widgetIdsFor, type WidgetId } from "@ensemble/shared-types/widgets";
import { api } from "@/lib/api";
import { appendDeskTile, readAdded, removeDeskTile } from "@/lib/desk-added";
import type { DeskId } from "./desks";
import { showTile } from "./layout";
import { useDeskLayout, type Spec } from "./live-board";

export function AddTileButton({ deskId, plots, startOpen = false }: { deskId: DeskId; plots: boolean; startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  useEffect(() => {
    if (startOpen) setOpen(true);
  }, [startOpen]);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener("ensemble:add-tile", show);
    return () => window.removeEventListener("ensemble:add-tile", show);
  }, []);
  return (
    <>
      <button type="button" className="btn" data-add-tile onClick={() => setOpen(true)}>
        <Plus size={13} />
        Add a tile
      </button>
      {open ? <AddTileDialog deskId={deskId} plots={plots} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function AddTileDialog({ deskId, plots, onClose }: { deskId: DeskId; plots: boolean; onClose: () => void }) {
  const client = useQueryClient();
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000 });
  const prefs = useQuery({ queryKey: ["preferences"], queryFn: api.preferences });
  const added = readAdded(prefs.data?.preferences);
  const templateId = shell.data?.activeTemplateId;
  const preferred = useMemo(() => new Set(MARKET_CARDS.find((card) => card.id === templateId)?.widgets ?? []), [templateId]);
  const query = q.trim().toLowerCase();
  const layout = useDeskLayout(deskId);
  const matches = (spec: Spec) => !query || `${spec.title} ${spec.ghost}`.toLowerCase().includes(query);
  const live = [
    { id: "hidden", label: "Hidden from Today", specs: layout.hiddenSpecs.filter(matches) },
    { id: "borrow", label: "Live tiles", specs: layout.others.filter(matches) },
  ].filter((group) => group.specs.length);
  const place = (spec: Spec) => void layout.save(showTile({ shown: layout.shown, hidden: layout.hidden }, spec));
  const ids = widgetIdsFor("today").filter((id) => {
    const spec = WIDGET_REGISTRY[id];
    if (spec.requires && !hasModule(shell.data?.modules, spec.requires)) return false;
    if (!query) return true;
    return `${spec.label} ${spec.blurb ?? ""} ${spec.persona ?? ""}`.toLowerCase().includes(query);
  });
  const groups = [
    { id: "desk", label: "From this desk", ids: ids.filter((id) => preferred.has(id)) },
    { id: "shared", label: "Shared", ids: ids.filter((id) => !preferred.has(id) && !WIDGET_REGISTRY[id].persona) },
    { id: "other", label: "From other desks", ids: ids.filter((id) => !preferred.has(id) && WIDGET_REGISTRY[id].persona) },
  ].filter((group) => group.ids.length);

  const add = async (id: WidgetId) => {
    setError("");
    try {
      await appendDeskTile(client, id);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="fixed inset-0 z-[65] flex items-start justify-center overflow-y-auto bg-black/45 p-4 pt-16" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Add a tile"
        className="relative max-h-[calc(100dvh-6rem)] w-[min(680px,calc(100%-1rem))] overflow-y-auto rounded-lg border border-line bg-panel p-4 shadow-pop"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <input
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="Search tiles"
            aria-label="Search tiles"
            className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-[14px] text-ink"
          />
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
        {error ? <p className="mt-3 text-[13px] text-danger">{error}</p> : null}
        {live.map((group) => (
          <div key={group.id} className="mt-3" data-live-group={group.id}>
            <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-faint">{group.label}</div>
            <div className="mt-1 grid gap-1 sm:grid-cols-2">
              {group.specs.map((spec) => {
                const Icon = spec.icon;
                return (
                  <button
                    key={spec.key}
                    type="button"
                    data-gallery-tile={spec.key}
                    className="flex items-start gap-2 rounded-md border border-line px-2.5 py-2 text-left hover:border-line-strong hover:bg-hover"
                    onClick={() => place(spec)}
                  >
                    <Icon size={14} className="mt-0.5 shrink-0 text-muted" />
                    <span className="min-w-0">
                      <span className="block text-[13px] font-medium">{spec.title}</span>
                      <span className="block text-[12px] text-muted">{spec.ghost}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {groups.length === 0 && live.length === 0 ? <p className="mt-3 text-[13px] text-muted">Nothing matches.</p> : null}
        {groups.map((group) => (
          <div key={group.id} className="mt-3">
            <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-faint">{group.id === "desk" ? "Shortcuts for this desk" : group.id === "shared" ? "Shortcuts" : "Shortcuts from other desks"}</div>
            <div className="mt-1 grid gap-1 sm:grid-cols-2">
              {group.ids.map((id) => {
                const spec = WIDGET_REGISTRY[id];
                const on = added.includes(id);
                return (
                  <button
                    key={id}
                    type="button"
                    data-gallery-tile={id}
                    disabled={on}
                    className="rounded-md border border-line px-2.5 py-2 text-left hover:border-line-strong hover:bg-hover disabled:opacity-60"
                    onClick={() => void add(id)}
                  >
                    <div className="text-[13px] font-medium">{on ? `${spec.label} · on Today` : spec.label}</div>
                    <div className="text-[12px] text-muted">{spec.blurb ?? spec.label}</div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {layout.customized ? (
          <div className="mt-4 flex items-center justify-between gap-3 border-t border-line pt-3">
            <span className="text-[12.5px] text-muted">You moved, resized, or hid tiles on this desk.</span>
            <button type="button" className="btn" onClick={() => void layout.reset()}>
              <RotateCcw size={12} />
              Reset layout
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Tiles the person placed. A module that is off hides its tiles and leaves the saved ids alone. */
export function AddedTiles() {
  const client = useQueryClient();
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000 });
  const prefs = useQuery({ queryKey: ["preferences"], queryFn: api.preferences });
  const visible = readAdded(prefs.data?.preferences).filter((id) => {
    const requires = WIDGET_REGISTRY[id].requires;
    return !requires || hasModule(shell.data?.modules, requires);
  });
  const done = useQuery({
    queryKey: ["completed", "", "task"],
    queryFn: () => api.completed({ kind: "task" }),
    enabled: visible.includes("completed"),
    staleTime: 20_000,
  });
  if (!visible.length) return null;
  return (
    <section data-desk-added className="col" style={{ gap: 10, marginTop: 12 }}>
      <div style={{ fontSize: 12, color: "var(--muted)" }}>Added</div>
      <div className="row" style={{ gap: 10, alignItems: "stretch", flexWrap: "wrap" }}>
        {visible.map((id) => {
          const spec = WIDGET_REGISTRY[id];
          return (
            <article key={id} className="tile" data-widget={id} style={{ flex: "1 1 220px", padding: 14, minWidth: 0 }}>
              <header className="row sb">
                <span style={{ fontSize: 13.5, fontWeight: 600 }}>{spec.label}</span>
                <button type="button" className="btn" aria-label={`Remove ${spec.label}`} onClick={() => void removeDeskTile(client, id)}>
                  <X size={12} />
                </button>
              </header>
              {id === "completed" ? (
                <ul style={{ margin: "8px 0 0", padding: 0, listStyle: "none" }}>
                  {(done.data?.items ?? []).slice(0, 4).map((item) => (
                    <li key={item.id} style={{ fontSize: 13, padding: "3px 0" }}>
                      <a href={`/tasks/${item.id}`}>{item.title}</a>
                    </li>
                  ))}
                  {!done.data?.items.length ? <li style={{ fontSize: 13, color: "var(--muted)" }}>{spec.empty}</li> : null}
                  <li style={{ marginTop: 6 }}>
                    <a href="/settings#completed" style={{ fontSize: 12.5 }}>Open completed</a>
                  </li>
                </ul>
              ) : (
                <p style={{ margin: "8px 0 0", fontSize: 13, color: "var(--muted)" }}>
                  {spec.blurb ?? spec.empty ?? spec.label}
                  {id === "review-queue" || id === "repos" ? <> · <a href="/code">Open Code</a></> : null}
                </p>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
