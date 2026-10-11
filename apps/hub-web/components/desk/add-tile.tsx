"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronLeft, ChevronRight, Plus, RotateCcw, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { hasModule } from "@ensemble/shared-types/modules";
import { WIDGET_REGISTRY, type WidgetId } from "@ensemble/shared-types/widgets";
import { Dialog } from "@/components/ui";
import { api } from "@/lib/api";
import { readAdded, removeDeskTile } from "@/lib/desk-added";
import type { DeskId } from "./desks";
import { DESK_EXTRAS, resolveExtras } from "@/lib/desk-extras";
import { layoutKey, showTile, tileLimits } from "./layout";
import { specPool, TileBody, useDeskLayout, type Spec } from "./live-board";
import { deskRole, tileFitsRole, tileCategory, tileDescription, TILE_CATEGORIES, type TileCategory } from "./tile-catalog";
import { sampleLive } from "../onboarding/sample";
import { ROLES } from "../onboarding/roles";
import { DeskPreviewProvider, Tile } from "./ui";

const SHORTCUTS: Partial<Record<WidgetId, { href: string; action: string }>> = {
  completed: { href: "/settings#completed", action: "Open completed" },
  repos: { href: "/context?view=widgets&tab=repos", action: "Open repositories" },
  "review-queue": { href: "/code", action: "Open Code" },
  deliverables: { href: "/context?view=widgets&tab=projects", action: "Open projects and deliverables" },
  "assignment-countdown": { href: "/board", action: "Open coursework on the board" },
  calendar: { href: "/context?view=widgets&tab=sources", action: "Open calendar sources" },
  timetable: { href: "/context?view=widgets&tab=sources", action: "Open calendar sources" },
  people: { href: "/context?view=widgets&tab=people", action: "Open people" },
};

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

export function AddTileDialog({ deskId, onClose }: { deskId: DeskId; plots?: boolean; onClose: () => void }) {
  const client = useQueryClient();
  const gallery = useRef<HTMLDivElement>(null);
  const [pane, setPane] = useState("browse");
  useEffect(() => { if (window.matchMedia?.("(max-width: 980px)").matches) gallery.current?.closest(".tile-gallery-dialog-body")?.scrollTo?.({ top: 0 }); }, [pane]);
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<TileCategory>("All tiles");
  const [selected, setSelected] = useState<string | null>(null);
  const [size, setSize] = useState<4 | 6 | 12>(6);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000 });
  const layout = useDeskLayout(deskId);
  const role = deskRole(deskId, shell.data?.onboardingTemplateId);
  const roleLabel = ROLES.find((r) => r.id === role)!.label;
  const sample = useMemo(() => sampleLive(role), [role]);
  const catalog = new Map(specPool());
  for (const spec of layout.defaults) catalog.set(spec.key, spec);
  const candidates = [...catalog.values()].filter((spec) => tileFitsRole(spec.key, role));
  // Prefer the current desk's version when two keys draw the same content.
  const native = new Set(layout.defaults.map((s) => s.key));
  const all = candidates.filter((spec) => !candidates.some((other) => other.key !== spec.key && other.title === spec.title && (native.has(other.key) && !native.has(spec.key) || native.has(other.key) === native.has(spec.key) && candidates.indexOf(other) < candidates.indexOf(spec))));
  const query = q.trim().toLowerCase();
  const matches = all.filter((spec) => (category === "All tiles" || tileCategory(spec.key) === category) && (!query || `${spec.title} ${tileDescription(spec)} ${tileCategory(spec.key)}`.toLowerCase().includes(query)));
  const active = matches.find((spec) => spec.key === selected) ?? matches[0];
  const chosenSize = active ? Math.max(size, tileLimits(active).minC) : size;
  const onDesk = new Set(layout.shown.map((spec) => spec.key));
  const ready = layout.ready && shell.isSuccess;

  async function place(spec: Spec) {
    if (!ready || pending || onDesk.has(spec.key)) return;
    setPending(true); setError(""); setNotice("");
    const next = showTile({ shown: layout.shown, hidden: layout.hidden }, { ...spec, c: chosenSize });
    try {
      const prefs = client.getQueryData<Awaited<ReturnType<typeof api.preferences>>>(["preferences"]);
      const extra = DESK_EXTRAS.find((e) => e.tile === spec.key);
      const enabled = resolveExtras(deskId, prefs?.preferences.find((p) => p.key === "desk.extras")?.value);
      const writes: Awaited<ReturnType<typeof api.putPreference>>["preference"][] = [];
      if (extra && !enabled.has(extra.id)) writes.push((await api.putPreference("desk.extras", [...enabled, extra.id])).preference);
      writes.push((await api.putPreference(layoutKey(deskId), next)).preference);
      const keys = new Set(writes.map((p) => p.key));
      client.setQueryData<Awaited<ReturnType<typeof api.preferences>>>(["preferences"], (old) => ({ preferences: [...(old?.preferences ?? []).filter((p) => !keys.has(p.key)), ...writes] }));
      setNotice(`${spec.title} added to Today. Move or resize it whenever you like.`);
    } catch (e) { setError((e as Error).message); await client.invalidateQueries({ queryKey: ["preferences"] }); }
    finally { setPending(false); }
  }

  return <Dialog open onClose={onClose} title="Make room for your best work" width={1160} className="tile-gallery-dialog" bodyClassName="tile-gallery-dialog-body">
    <div ref={gallery} className="tile-gallery" data-tile-gallery data-gallery-pane={pane}>
      <div className="tile-gallery-intro"><div><span className="tile-gallery-eyebrow">YOUR TILE LIBRARY</span><p>A desk that works the way you do.</p></div><span className="tile-gallery-profile">{roleLabel} · {all.length} tiles</span></div>
      <div className="tile-gallery-mobile-nav"><button type="button" aria-pressed={pane === "browse"} onClick={() => setPane("browse")}><ChevronLeft size={14} />Browse tiles</button><button type="button" aria-pressed={pane === "preview"} onClick={() => setPane("preview")}>Preview<ChevronRight size={14} /></button></div>
      <div className="tile-gallery-layout">
        <aside className="tile-gallery-sidebar">
          <label className="tile-gallery-search"><Search size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a tile…" aria-label="Search tiles" /></label>
          <div className="tile-gallery-categories" aria-label="Tile categories">{TILE_CATEGORIES.map((c) => <button key={c} type="button" aria-pressed={category === c} onClick={() => setCategory(c)}>{c}<span>{all.filter((s) => c === "All tiles" || tileCategory(s.key) === c).length}</span></button>)}</div>
          <div className="tile-gallery-results" aria-label="Available tiles">
            {matches.map((spec) => { const Icon = spec.icon; return <button key={spec.key} type="button" data-gallery-tile={spec.key} aria-pressed={active?.key === spec.key} onClick={() => { setSelected(spec.key); setNotice(""); setPane("preview"); }}><span className="tile-gallery-icon"><Icon size={17} /></span><span><strong>{spec.title}</strong><small>{onDesk.has(spec.key) ? "On your Today" : tileCategory(spec.key)}</small></span>{onDesk.has(spec.key) ? <Check size={14} /> : <ChevronRight size={14} />}</button>; })}
            {!matches.length && <div className="tile-gallery-empty"><Search size={22} /><strong>No tiles found</strong><p>Try a different word or category.</p><button type="button" className="btn" onClick={() => { setQ(""); setCategory("All tiles"); }}>Clear filters</button></div>}
          </div>
        </aside>
        <section className="tile-gallery-detail" aria-label="Tile preview">
          {active ? <>
            <header><span className="tile-gallery-eyebrow">{tileCategory(active.key)}</span><h2>{active.title}</h2><p>{tileDescription(active)}</p></header>
            <div className="tile-gallery-preview-label"><span><i />Preview with sample data</span><div aria-label="Tile width">{([4, 6, 12] as const).map((c) => <button key={c} type="button" disabled={c < tileLimits(active).minC} aria-pressed={chosenSize === c} onClick={() => setSize(c)}>{c === 4 ? "Compact" : c === 6 ? "Medium" : "Wide"}</button>)}</div></div>
            <div className="tile-gallery-stage desk"><DeskPreviewProvider><Tile title={active.title} icon={active.icon} hero={active.hero} style={{ width: chosenSize === 4 ? 330 : chosenSize === 6 ? 470 : 660, maxWidth: "100%", height: Math.max(active.r * 72, active.key === "calendar" ? 410 : 280) }}><TileBody spec={active} live={sample} preview interactivePreview /></Tile></DeskPreviewProvider></div>
            <footer><div><strong>Your data, automatically</strong><p>Sample entries stay in this preview. Your tile uses your own work.</p></div><button type="button" className="btn-primary" disabled={!ready || pending || onDesk.has(active.key)} onClick={() => void place(active)}>{onDesk.has(active.key) ? <><Check size={15} /> On Today</> : <><Plus size={15} />{pending ? "Adding…" : "Add to Today"}</>}</button></footer>
          </> : <div className="tile-gallery-empty"><p>Choose a tile to see how it fits your day.</p></div>}
        </section>
      </div>
      <div className="tile-gallery-bottom"><span role="status">{notice || `${onDesk.size} tiles on Today · All tiles can be moved, resized, or hidden.`}</span>{layout.customized && <button type="button" className="btn" disabled={pending || !ready} onClick={() => void layout.reset()}><RotateCcw size={12} />Reset layout</button>}</div>
      {error && <p role="alert" className="mt-2 text-[13px] text-danger">{error}</p>}
    </div>
  </Dialog>;
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
  const feed = useQuery({ queryKey: ["widget-feed"], queryFn: api.widgetFeed, enabled: visible.some((id) => ["calendar", "timetable", "deliverables", "assignment-countdown"].includes(id)), staleTime: 20_000 });
  if (!visible.length) return null;
  return (
    <section data-desk-added className="col" style={{ gap: 10, marginTop: 12 }}>
      <div style={{ fontSize: 12, color: "var(--muted)" }}>Added</div>
      <div className="row" style={{ gap: 10, alignItems: "stretch", flexWrap: "wrap" }}>
        {visible.map((id) => {
          const spec = WIDGET_REGISTRY[id];
          const shortcut = SHORTCUTS[id];
          const rows = id === "assignment-countdown" ? (feed.data?.tasks ?? []).filter((task) => task.taskType === "assignment" && !["done", "dropped"].includes(task.status)).map((task) => ({ id: task.id, title: task.title, href: `/tasks/${task.id}`, date: task.due }))
            : id === "deliverables" ? (feed.data?.deliverables ?? []).map((row) => ({ id: row.id, title: row.title, href: `/projects/${row.projectId}`, date: row.due }))
            : id === "calendar" || id === "timetable" ? (feed.data?.events ?? []).map((event) => ({ id: event.id, title: event.title, href: "/context?view=widgets&tab=artifacts", date: event.start })) : [];
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
                <div className="mt-2 space-y-2 text-[13px]">
                  {rows.length ? <ul className="space-y-1">{rows.slice(0, 4).map((row) => <li key={row.id}><a href={row.href} className="break-words hover:underline">{row.title}</a>{row.date ? <span className="ml-2 text-[12px] text-muted">{new Date(row.date).toLocaleDateString()}</span> : null}</li>)}</ul>
                    : <p className="text-muted">{feed.isLoading && ["calendar", "timetable", "deliverables", "assignment-countdown"].includes(id) ? "Loading…" : feed.isError && ["calendar", "timetable", "deliverables", "assignment-countdown"].includes(id) ? "Could not load this tile. Reopen Today to retry." : shortcut ? spec.empty ?? spec.blurb ?? "Open this area to get started." : "This shortcut is not available yet. Choose a live tile from Add a tile."}</p>}
                  {shortcut ? <a href={shortcut.href} className="inline-flex text-accent hover:underline">{shortcut.action}</a> : null}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
