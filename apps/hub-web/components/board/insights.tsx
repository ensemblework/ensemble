"use client";
import { useAssistantSurface } from "@/lib/assistant-surface";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Plus, Search, GripVertical } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { api, inItemView, type TaskRecord } from "@/lib/api";
import { useSpaceAccess } from "@/lib/access";
import type { LayoutPayload } from "@/lib/server-layout";
import { useToast } from "../toast";
import { Dialog } from "../ui";
import { deskIdFromTemplate } from "../desk/desks";
import { deskRole } from "../desk/tile-catalog";
import { sampleLive } from "../onboarding/sample";
import { type Role } from "../onboarding/roles";
import { DEFAULT_INSIGHTS, INSIGHTS_KEY, INSIGHT_IDS, MAX_INSIGHTS, readInsightLayout, type BoardFocus, type InsightId, type InsightLayout, type OwnerContext } from "./insight-data";
import { INSIGHT_CATALOG, INSIGHT_CATEGORIES, insightTitle } from "./insight-catalog";
import { InsightTile } from "./insight-tile";

export function insightSamples(role: Role, now = new Date()): TaskRecord[] {
  const live = sampleLive(role, null, now);
  return live.tasks.filter((t) => !["time", "mock"].includes(t.taskType || "")).map((t, i) => ({
    ...t, status: ["proposed", "todo", "in_progress", "blocked", "done", "waiting_approval"][i % 6] as TaskRecord["status"],
    owner: ["unassigned", "me", "agent", "me"][i % 4] as TaskRecord["owner"], assigneeAccountId: i % 4 === 3 ? "sample-teammate" : null,
    description: "", notes: "", priority: "p1", complexity: "easy", boardOrder: i, todayFocus: "auto", sourceKind: "manual", sourceRef: "sample", sourceUrl: null, excerpt: null, repoId: null, deliverableId: null, people: [], skillIds: [], snoozedUntil: null, rationale: null, createdBy: "me",
    createdAt: new Date(now.getTime() - (i + 10) * 86400000).toISOString(), updatedAt: new Date(now.getTime() - (i % 11) * 86400000).toISOString(), completedAt: i % 6 === 4 ? new Date(now.getTime() - i % 6 * 86400000).toISOString() : null,
  }));
}

const LEGACY: Record<string, InsightId> = { "column-summary": "flow", wip: "capacity", blocked: "attention", "week-done": "done" };

export function BoardInsights({ tasks, initialLayout, editing, onEditingChange, who, onOpen, onIdea, focus, onFocus, filtered = false, loading = false }: {
  tasks: TaskRecord[]; initialLayout?: LayoutPayload | null; editing: boolean; onEditingChange: (editing: boolean) => void; who: OwnerContext; onOpen: (id: string) => void; onIdea?: () => void; focus: BoardFocus | null; onFocus: (focus: BoardFocus | null) => void; filtered?: boolean; loading?: boolean;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const access = useSpaceAccess();
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000, enabled: !inItemView() });
  const editable = access.ready && !access.guest && !inItemView();
  const prefs = useQuery({ queryKey: ["preferences"], queryFn: api.preferences, enabled: editable, staleTime: 30_000 });
  const role = deskRole(deskIdFromTemplate(shell.data?.activeTemplateId) ?? "default", shell.data?.onboardingTemplateId);
  const fallback = !access.guest && initialLayout?.source === "saved" ? initialLayout.document.placements.map((p) => LEGACY[p.type]).filter((id): id is InsightId => Boolean(id)) : DEFAULT_INSIGHTS[role];
  const savedLayout = editable ? prefs.data?.preferences.find((p) => p.key === INSIGHTS_KEY)?.value : null;
  const layout = readInsightLayout(savedLayout, fallback);
  useAssistantSurface("/board", { kind: "board", tiles: layout.tiles.map(key => ({ key, title: insightTitle(key, role), c: 4, r: 3 })) });
  const cap = layout.wipCap ?? (access.guest ? 3 : initialLayout?.document.config?.wipCap ?? 3);
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(max-width: 767px)");
    const sync = () => setPhone(media.matches); sync(); media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  const [localCollapsed, setLocalCollapsed] = useState<boolean | null>(null);
  const collapsed = editable ? (savedLayout ? layout.collapsed : phone) : (localCollapsed ?? phone);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const saving = useRef(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60_000); return () => window.clearInterval(timer); }, []);

  async function save(next: InsightLayout) {
    if (!editable || !prefs.isSuccess || saving.current) return;
    saving.current = true; setPending(true); setError("");
    try {
      const result = await api.putPreference(INSIGHTS_KEY, next);
      client.setQueryData<Awaited<ReturnType<typeof api.preferences>>>(["preferences"], (old) => ({ preferences: [...(old?.preferences ?? []).filter((p) => p.key !== INSIGHTS_KEY), result.preference] }));
    } catch (e) { setError((e as Error).message); toast((e as Error).message, { tone: "error" }); }
    finally { saving.current = false; setPending(false); }
  }
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const change = (tiles: InsightId[]) => void save({ ...layout, tiles });
  return <div className="board-insights desk" data-board-strip>
    <div className="board-insights-heading"><button type="button" className="board-insights-toggle" aria-expanded={!collapsed} aria-controls="board-insight-tiles" disabled={pending || editable && !prefs.isSuccess} onClick={() => editable ? void save({ ...layout, collapsed: !collapsed }) : setLocalCollapsed(!collapsed)}>{collapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}Board overview</button>{filtered && <span>Matches your filters</span>}</div>
    {!collapsed && <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={({ active, over }) => {
      if (over && active.id !== over.id) change(arrayMove(layout.tiles, layout.tiles.indexOf(active.id as InsightId), layout.tiles.indexOf(over.id as InsightId)));
    }}><SortableContext items={layout.tiles} strategy={rectSortingStrategy}><div id="board-insight-tiles" className="board-insight-row" data-board-scroll>
      {loading || !access.ready && !inItemView() ? <div className="insight-loading" role="status">Loading board overview…</div> : layout.tiles.map((id) => <SortableInsight key={id} id={id} title={insightTitle(id, role)} disabled={!editable || !prefs.isSuccess || pending} render={(grip) => <InsightTile id={id} role={role} tasks={tasks} who={who} now={now} cap={cap} focus={focus} onFocus={onFocus} onOpen={onOpen} onIdea={onIdea} grip={grip} onRemove={editable && prefs.isSuccess ? () => change(layout.tiles.filter((key) => key !== id)) : undefined} />} />)}
      {!layout.tiles.length && <button type="button" className="insight-empty-add" onClick={() => onEditingChange(true)}><Plus size={14} />Choose a small overview for this board</button>}
    </div></SortableContext></DndContext>}
    {editing && <InsightGallery role={role} layout={layout} cap={cap} editable={editable && prefs.isSuccess} pending={pending} error={error} onChange={change} onCapChange={(wipCap) => void save({ ...layout, wipCap })} onReset={() => void save({ v: 1, tiles: DEFAULT_INSIGHTS[role], collapsed: false })} onClose={() => onEditingChange(false)} />}
  </div>;
}

function SortableInsight({ id, title, disabled, render }: { id: InsightId; title: string; disabled: boolean; render: (grip: ReactNode) => ReactNode }) {
  const { setNodeRef, transform, transition, attributes, listeners, isDragging } = useSortable({ id, disabled });
  return <div ref={setNodeRef} className="board-insight-slot" style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? .6 : 1, zIndex: isDragging ? 2 : undefined }}>
    {render(disabled ? null : <button type="button" className="insight-grip" aria-label={`Move ${title}. Drag or press Space and use arrow keys.`} title="Drag to move" {...attributes} {...listeners}><GripVertical size={12} /></button>)}
  </div>;
}

export function InsightGallery({ role, layout, cap, editable, pending, error, onChange, onCapChange, onReset, onClose }: { role: Role; layout: InsightLayout; cap: number; editable: boolean; pending: boolean; error: string; onChange: (ids: InsightId[]) => void; onCapChange?: (cap: number) => void; onReset: () => void; onClose: () => void }) {
  const gallery = useRef<HTMLDivElement>(null);
  const [pane, setPane] = useState("browse");
  useEffect(() => { if (window.matchMedia?.("(max-width: 980px)").matches) gallery.current?.closest(".tile-gallery-dialog-body")?.scrollTo?.({ top: 0 }); }, [pane]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("All tiles");
  const [selected, setSelected] = useState<InsightId>(DEFAULT_INSIGHTS[role][0]!);
  const [previewFocus, setPreviewFocus] = useState<BoardFocus | null>(null);
  const now = useMemo(() => Date.now(), []);
  const sample = useMemo(() => insightSamples(role, new Date(now)), [role, now]);
  const matches = INSIGHT_IDS.filter((id) => (category === "All tiles" || INSIGHT_CATALOG[id].category === category) && `${insightTitle(id, role)} ${INSIGHT_CATALOG[id].description}`.toLowerCase().includes(query.trim().toLowerCase()));
  const id = matches.includes(selected) ? selected : matches[0];
  const selectedOn = id ? layout.tiles.includes(id) : false;
  function move(index: number, delta: number) { const next = [...layout.tiles]; [next[index], next[index + delta]] = [next[index + delta]!, next[index]!]; onChange(next); }
  return <Dialog open onClose={onClose} title="Make the board your own" width={1120} className="tile-gallery-dialog" bodyClassName="tile-gallery-dialog-body"><div ref={gallery} className="tile-gallery" data-gallery-pane={pane}>
    <div className="tile-gallery-intro"><div><span className="tile-gallery-eyebrow">BOARD OVERVIEW</span><p>Just enough context. More room to do.</p></div><span className="tile-gallery-profile">Up to {MAX_INSIGHTS} compact tiles</span></div>
    <div className="tile-gallery-mobile-nav"><button type="button" aria-pressed={pane === "browse"} onClick={() => setPane("browse")}><ChevronLeft size={14} />Browse tiles</button><button type="button" aria-pressed={pane === "preview"} onClick={() => setPane("preview")}>Preview<ChevronRight size={14} /></button></div>
    <div className="tile-gallery-layout"><aside className="tile-gallery-sidebar"><label className="tile-gallery-search"><Search size={15} /><input aria-label="Search board tiles" value={query} placeholder="Find a board tile…" onChange={(e) => setQuery(e.target.value)} /></label><div className="tile-gallery-categories">{INSIGHT_CATEGORIES.map((c) => <button key={c} type="button" aria-pressed={category === c} onClick={() => setCategory(c)}>{c}</button>)}</div><div className="tile-gallery-results">{matches.map((key) => { const Icon = INSIGHT_CATALOG[key].icon; return <button key={key} type="button" data-insight-option={key} aria-pressed={key === id} onClick={() => { setSelected(key); setPreviewFocus(null); setPane("preview"); }}><span className="tile-gallery-icon"><Icon size={16} /></span><span><strong>{insightTitle(key, role)}</strong><small>{layout.tiles.includes(key) ? "On this board" : INSIGHT_CATALOG[key].category}</small></span><ChevronRight size={14} /></button>; })}{!matches.length && <p className="tile-gallery-empty">No tiles match. Try another search.</p>}</div></aside>
      <section className="tile-gallery-detail">{id && <><header><span className="tile-gallery-eyebrow">{INSIGHT_CATALOG[id].category}</span><h2>{insightTitle(id, role)}</h2><p>{INSIGHT_CATALOG[id].description}</p></header><div className="tile-gallery-preview-label"><span><i />Interactive preview · sample tasks</span><span>{id === "capacity" ? <label className="insight-cap-setting">WIP cap <input type="number" aria-label="Board WIP cap" min={1} max={50} key={cap} defaultValue={cap} disabled={!editable || pending || !onCapChange} onBlur={(e) => { const n = Number(e.target.value); if (e.target.value && Number.isFinite(n) && n !== cap) onCapChange?.(Math.max(1, Math.min(50, Math.round(n)))); }} /></label> : "Compact by design"}</span></div><div className="tile-gallery-stage desk"><div className="board-insight-preview"><InsightTile id={id} role={role} tasks={sample} who={{ me: "sample-me", ownerId: "sample-me" }} now={now} cap={cap} onFocus={setPreviewFocus} focus={previewFocus} preview /></div></div><footer><div><strong>{layout.tiles.length} of {MAX_INSIGHTS} tiles selected</strong><p>{!editable ? "The workspace owner manages this layout." : selectedOn ? "Remove or reorder tiles below." : layout.tiles.length >= MAX_INSIGHTS ? "Remove a tile to make room for this one." : "Uses this board’s tasks and current filters."}</p></div><button type="button" disabled={!editable || pending || !selectedOn && layout.tiles.length >= MAX_INSIGHTS} onClick={() => onChange(selectedOn ? layout.tiles.filter((t) => t !== id) : [...layout.tiles, id])}>{pending ? "Saving…" : selectedOn ? "Remove tile" : "Add to board"}</button></footer></>}</section>
    </div>
    <div className="insight-selected" aria-label="Selected board tiles">{layout.tiles.map((key, i) => <div key={key}><span>{insightTitle(key, role)}</span><button type="button" disabled={!editable || pending || i === 0} aria-label={`Move ${insightTitle(key, role)} left`} onClick={() => move(i, -1)}><ChevronLeft size={13} /></button><button type="button" disabled={!editable || pending || i === layout.tiles.length - 1} aria-label={`Move ${insightTitle(key, role)} right`} onClick={() => move(i, 1)}><ChevronRight size={13} /></button></div>)}<button type="button" className="insight-reset" disabled={!editable || pending} onClick={onReset}>Reset for my profile</button></div>
    {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
  </div></Dialog>;
}
