"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, type BoardCard, type BoardPayload } from "@/lib/api";
import { useSpaceAccess } from "@/lib/access";
import { placeAnchoredPanel } from "@/lib/place-layer";
import { emitToast } from "@/lib/toast-bus";
import { useShellLabels } from "@/lib/shell-labels";

const GraphTab = dynamic(() => import("./graph").then((mod) => mod.GraphTab), {
  ssr: false,
  loading: () => <div className="skeleton h-[480px] w-full rounded-xl" />,
});

const AskEnsemble = dynamic(() => import("../ensemble/ask-button").then((mod) => mod.AskEnsemble), { ssr: false });

const VIEWS = [
  { id: "board", label: "Board" },
  { id: "grid", label: "Grid" },
  { id: "list", label: "List" },
  { id: "graph", label: "Graph" },
] as const;

type ViewId = (typeof VIEWS)[number]["id"];
const LANE_FILTERS = new Set(["people", "projects", "repos", "meetings", "artifacts"]);
const PAGE = 8;
const KIND_LABEL: Record<BoardCard["kind"], string> = {
  people: "Person",
  project: "Project",
  repo: "Repo",
  meeting: "Meeting",
  artifact: "Artifact",
};
const LANG: Record<string, string> = {
  TypeScript: "#3178c6",
  JavaScript: "#f1e05a",
  Python: "#3572A5",
  Rust: "#dea584",
  Go: "#00ADD8",
  Ruby: "#701516",
};

const PLACEHOLDER_META = new Set(["Not synced yet", "No recent touch"]);

const EMPTY: Record<string, string> = {
  people: "No one here yet. Add a person, or connect a source that already knows them.",
  projects: "No project yet. A project is the pile a person, a repo, and the work belong to.",
  repos: "No repo yet. Connect one when you have it, this lane does not invent one.",
  meetings: "No meeting notes yet. They show up when you take notes or a calendar syncs.",
  artifacts: "No artifacts yet. Deliverables, mail, and files land here.",
};

type LaneModel = { id: string; label: string; kind: string; total: number; cards: BoardCard[]; progress?: { done: number; total: number } | null };
type Drag = { card: BoardCard; laneId: string; x: number; y: number; overId: string | null; linkId: string | null };

function arrange(cards: BoardCard[], saved: string[]): BoardCard[] {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const next: BoardCard[] = [];
  const seen = new Set<string>();
  for (const id of saved) {
    const card = byId.get(id);
    if (!card || seen.has(id)) continue;
    seen.add(id);
    next.push(card);
  }
  for (const card of cards) if (!seen.has(card.id)) next.push(card);
  return next;
}

function moveId(ids: string[], id: string, over: string): string[] {
  const from = ids.indexOf(id);
  const index = ids.indexOf(over);
  if (from < 0 || index < 0 || from === index) return ids;
  const copy = ids.slice();
  const [item] = copy.splice(from, 1);
  let dest = from < index ? index - 1 : index;
  if (dest === from) dest = Math.min(index, copy.length);
  copy.splice(dest, 0, item!);
  return copy;
}

function matches(card: BoardCard, q: string): boolean {
  if (!q) return true;
  const hay = `${card.title} ${card.subtitle ?? ""} ${card.meta ?? ""} ${card.chips.join(" ")} ${card.language ?? ""}`.toLowerCase();
  return hay.includes(q.toLowerCase());
}

function linked(card: BoardCard, other: BoardCard): boolean {
  if (card.kind === "people" && other.kind === "project") return other.personIds.includes(card.id);
  if (card.kind === "project" && other.kind === "people") return card.personIds.includes(other.id);
  if (card.kind === "repo" && other.kind === "project") return other.repoIds.includes(card.id);
  if (card.kind === "project" && other.kind === "repo") return card.repoIds.includes(other.id);
  if (card.kind === "meeting" || card.kind === "artifact") {
    if (other.kind === "project") return card.projectIds.includes(other.id);
    if (other.kind === "people") return card.personIds.includes(other.id);
    if (other.kind === "repo") return card.repoIds.includes(other.id);
  }
  if (other.kind === "meeting" || other.kind === "artifact") {
    if (card.kind === "project") return other.projectIds.includes(card.id);
    if (card.kind === "people") return other.personIds.includes(card.id);
    if (card.kind === "repo") return other.repoIds.includes(card.id);
  }
  return false;
}

function canUnlink(card: BoardCard, other: BoardCard): boolean {
  const project = card.kind === "project" ? card : other.kind === "project" ? other : null;
  if (!project) return false;
  const person = card.kind === "people" ? card : other.kind === "people" ? other : null;
  const repo = card.kind === "repo" ? card : other.kind === "repo" ? other : null;
  return Boolean(person || repo);
}

function projectLanes(data: BoardPayload): Array<{ id: string; label: string; kind: string; cards: BoardCard[] }> {
  const projects = data.lanes.find((lane) => lane.id === "projects")?.cards ?? [];
  const others = data.lanes.filter((lane) => lane.id !== "projects").flatMap((lane) => lane.cards);
  const used = new Set<string>();
  const lanes = projects.slice(0, 8).map((project) => {
    const linked = others.filter((card) => card.projectIds.includes(project.id));
    const tasks = (project.activity ?? [])
      .filter((item) => !linked.some((card) => card.id === item.id))
      .map((item) => ({
        ...project,
        id: item.id,
        lane: "artifacts" as const,
        kind: "artifact" as const,
        title: item.title,
        subtitle: "Task",
        meta: item.when,
        chips: [],
        activity: [],
        progress: null,
        artifactKind: "task",
        href: `/tasks/${item.id}`,
      }));
    const cards = arrange([...linked, ...tasks], data.groups[`project:${project.id}`] ?? []);
    for (const card of cards) used.add(card.id);
    return {
      id: `project:${project.id}`,
      label: project.title,
      kind: "projects",
      cards,
      progress: project.progress,
    };
  });
  const unlinked = arrange(
    others.filter((card) => !used.has(card.id)),
    data.groups.unlinked ?? [],
  );
  lanes.push({ id: "unlinked", label: "Unlinked", kind: "artifacts", cards: unlinked, progress: null });
  return lanes;
}

export function ContextDesk({ initial }: { initial: BoardPayload | null }) {
  const params = useSearchParams();
  const router = useRouter();
  const toast = emitToast;
  const [data, setData] = useState<BoardPayload | null>(initial);
  const latest = useRef(initial);
  latest.current = data;
  const reload = async () => {
    try {
      const next = await api.contextBoard();
      latest.current = next;
      setData(next);
    } catch (error) {
      toast((error as Error).message, { tone: "error" });
    }
  };
  useEffect(() => {
    if (!initial) void reload();
    // The server payload is the first paint. Refetch only when it was missing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const tab = params.get("tab") ?? "";
  const requested = params.get("view");
  const view: ViewId =
    requested === "board" || requested === "grid" || requested === "list" || requested === "graph"
      ? requested
      : tab === "graph"
        ? "graph"
        : (data?.view ?? "board");
  const labels = useShellLabels();
  const projectsWord = labels.projects || "Projects";
  const boardWord = labels.board || "Board";
  const [q, setQ] = useState(params.get("search") ?? "");
  const [group, setGroup] = useState<"kind" | "project">(data?.group ?? "kind");
  const [openId, setOpenId] = useState<string | null>(null);
  const [more, setMore] = useState<Record<string, boolean>>({});
  const [proposal, setProposal] = useState<{ card: BoardCard; project: BoardCard; x: number; y: number } | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [adding, setAdding] = useState<"people" | "projects" | null>(null);
  const [draft, setDraft] = useState("");
  const [sourced, setSourced] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [canScroll, setCanScroll] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const who = new Set((params.get("who") ?? "").split(",").filter(Boolean));
  const ids = new Set((params.get("ids") ?? "").split(",").filter(Boolean));
  const typeFilter = LANE_FILTERS.has(tab) ? tab : "";

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      event.preventDefault();
      document.querySelector<HTMLInputElement>("[data-context-search]")?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const lanes = useMemo(() => {
    if (!data) return [];
    const base =
      group === "project"
        ? projectLanes(data)
        : data.lanes
            .filter((lane) => !typeFilter || lane.id === typeFilter)
            .map((lane) => ({ id: lane.id, label: lane.label, kind: lane.id, cards: lane.cards }));
    const kinds = !typeFilter && data.kinds?.length ? new Set(data.kinds) : null;
    const subjectLens = Boolean(kinds && group === "project" && kinds.has("projects"));
    const laneOf = (card: BoardCard) =>
      card.kind === "project" ? "projects" : card.kind === "repo" ? "repos" : card.kind === "meeting" ? "meetings" : card.kind === "artifact" ? "artifacts" : "people";
    return base
      .filter((lane) => !kinds || group !== "kind" || kinds.has(lane.id as BoardCard["lane"]))
      .map((lane) => ({
      ...lane,
      label: lane.id === "projects" ? projectsWord : lane.id === "people" ? labels.people || lane.label : lane.label,
      total: lane.cards.length,
      cards: lane.cards.filter((card) => {
        if (subjectLens && card.artifactKind === "task") return true;
        if (kinds && !subjectLens && !kinds.has(laneOf(card))) return false;
        if (kinds && subjectLens && card.artifactKind !== "task" && !kinds.has(laneOf(card)) && laneOf(card) !== "projects") return false;
        if (who.size && card.kind === "people" && !who.has(card.id) && !who.has(card.title)) return false;
        if (ids.size && card.kind === "project" && !ids.has(card.id)) return false;
        return matches(card, q);
      }),
    }));
  }, [data, group, typeFilter, q, params, projectsWord, labels.people]);

  const access = useSpaceAccess();
  const guest = !access.ready || access.guest;
  useEffect(() => {
    // Connected apps are the owner's; in a space shared with you there is nothing to show here.
    if (guest) return;
    let live = true;
    void api.connections().then((result) => {
      if (!live) return;
      setSourced(result.connections.some((row) => row.enabled && row.connect !== "builtin" && row.connect !== "later"));
    }).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [guest]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setCanScroll(el.scrollWidth - el.clientWidth > 12);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    el.addEventListener("scroll", measure, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", measure);
    };
  }, [lanes, view]);

  const saveQueue = useRef(Promise.resolve());
  const save = (next: BoardPayload) => {
    latest.current = next;
    setData(next);
    const lanesBody = Object.fromEntries(next.lanes.map((lane) => [lane.id, lane.cards.map((card) => card.id)]));
    const body = { view: next.view, group: next.group, groups: next.groups, lanes: lanesBody };
    saveQueue.current = saveQueue.current.catch(() => undefined).then(async () => {
      try {
        await api.saveContextOrder(body);
      } catch (error) {
        toast((error as Error).message, { tone: "error" });
      }
    });
  };

  const setView = (next: ViewId) => {
    const query = new URLSearchParams();
    query.set("view", next);
    if (typeFilter) query.set("tab", typeFilter);
    const search = params.get("search");
    if (search) query.set("search", search);
    router.replace(query.size ? `/context?${query}` : "/context", { scroll: false });
    const current = latest.current;
    if (current) void save({ ...current, view: next });
  };

  const setGrouping = (next: "kind" | "project") => {
    setGroup(next);
    const current = latest.current;
    if (current) void save({ ...current, group: next });
  };

  const reorder = (laneId: string, idsInLane: string[]) => {
    const current = latest.current;
    if (!current) return;
    if (group === "project") {
      void save({ ...current, groups: { ...current.groups, [laneId]: idsInLane } });
      return;
    }
    const lanesNext = current.lanes.map((lane) => (lane.id === laneId ? { ...lane, cards: arrange(lane.cards, idsInLane) } : lane));
    void save({ ...current, lanes: lanesNext });
  };

  const applyLink = async () => {
    if (!proposal || !data) return;
    const { card, project } = proposal;
    setProposal(null);
    try {
      if (card.kind === "people") {
        if (project.personIds.includes(card.id)) {
          toast("Already linked.");
          return;
        }
        await api.patchProject(project.id, { personIds: [...project.personIds, card.id] });
      } else if (card.kind === "repo") {
        if (project.repoIds.includes(card.id)) {
          toast("Already linked.");
          return;
        }
        await api.patchProject(project.id, { repoIds: [...project.repoIds, card.id] });
      }
      toast(`Linked ${card.title} to ${project.title}.`, { tone: "ok" });
      await reload();
    } catch (error) {
      toast((error as Error).message, { tone: "error" });
    }
  };

  const create = async () => {
    const name = draft.trim();
    if (!name || !adding) return;
    try {
      if (adding === "people") await api.createPerson({ name });
      else await api.createProject({ name });
      setDraft("");
      setAdding(null);
      await reload();
    } catch (error) {
      toast((error as Error).message, { tone: "error" });
    }
  };

  const allCards = data?.lanes.flatMap((lane) => lane.cards) ?? [];
  const open = openId ? (allCards.find((row) => row.id === openId) ?? null) : null;
  const showCard = (card: BoardCard) => setOpenId(card.id);
  const shown = lanes.flatMap((lane) => lane.cards);
  const neighbours = new Set<string>();
  const hovered = !open && hoverId ? allCards.find((row) => row.id === hoverId) : undefined;
  if (hovered) {
    for (const other of allCards) {
      if (other.id !== hovered.id && linked(hovered, other)) neighbours.add(other.id);
    }
  }
  const filtering = q.trim().length > 0;
  const filled = lanes.filter((lane) => lane.cards.length > 0 || (filtering && lane.total > 0) || Boolean(typeFilter));
  const empty = lanes.filter((lane) => lane.total === 0 && !typeFilter && !filtering);

  return (
    <div
      className="page-board mx-auto min-w-0 w-full px-4 pb-24 pt-8 sm:px-6"
      data-context-view={view}
      data-context-filter={typeFilter || undefined}
      data-hover={hovered && !drag && !proposal ? "1" : undefined}
    >
      <header className="page-head">
        <div>
          <h1 className="display text-[32px] leading-none">Context</h1>
          <p className="mt-2 max-w-[46ch] text-[14px] text-muted">The people, {projectsWord.toLowerCase()}, and things your work is tied to.</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/context?view=widgets" className="btn min-h-6">
            Customize
          </Link>
          <Link href="/connect" className={sourced ? "btn min-h-6" : "btn-primary min-h-6"}>
            Connect a source
          </Link>
        </div>
      </header>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg bg-raised p-1" role="tablist">
          {VIEWS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={view === item.id}
              className={`min-h-6 rounded-md px-2.5 py-1 text-[13px] ${view === item.id ? "bg-panel font-medium text-ink shadow-sm" : "text-muted"}`}
              onClick={() => setView(item.id)}
            >
              {item.id === "board" ? boardWord : item.label}
            </button>
          ))}
        </div>
        {view === "graph" ? null : (
          <>
            <label className="flex items-center gap-2 text-[13px] text-muted">
              Group
              <select aria-label="Group by" className="field py-1 text-[13px]" value={group} onChange={(event) => setGrouping(event.target.value as "kind" | "project")}>
                <option value="kind">Kind</option>
                <option value="project">Project</option>
              </select>
            </label>
            <div className="tile flex min-w-[12rem] flex-1 items-center gap-2 rounded-lg bg-panel px-2.5 py-1">
              <input
                data-context-search
                value={q}
                onChange={(event) => setQ(event.target.value)}
                placeholder="Filter context"
                aria-label="Filter context"
                className="search-line w-full bg-transparent text-[13.5px] outline-none placeholder:text-faint"
              />
              {filtering ? (
                <button type="button" className="btn-ghost min-h-6 px-1.5 py-0 text-[12px]" onClick={() => setQ("")}>
                  Clear
                </button>
              ) : null}
            </div>
          </>
        )}
      </div>
      {!data ? <div className="skeleton h-[280px] rounded-xl" /> : null}
      {data && allCards.length === 0 ? (
        <div className="empty-state mb-4">
          <div className="mb-1 font-medium text-ink">Nothing linked yet</div>
          Context fills in as you add a person or a project, or when a source syncs.{" "}
          <Link href="/connect" className="text-accent hover:underline">
            Connect a source
          </Link>
        </div>
      ) : null}
      {filtering && shown.length === 0 && view !== "graph" ? (
        <div className="empty-state mb-4">
          Nothing matches “{q.trim()}”.{" "}
          <button type="button" className="text-accent hover:underline" onClick={() => setQ("")}>
            Clear filter
          </button>
        </div>
      ) : null}
      {view === "graph" ? (
        <GraphTab />
      ) : view === "list" ? (
        <List cards={shown} onOpen={showCard} />
      ) : view === "grid" ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
          {shown.map((card) => (
            <Card key={card.id} card={card} neighbour={neighbours.has(card.id)} hovered={hoverId === card.id} onOpen={showCard} onHover={open ? undefined : setHoverId} />
          ))}
        </div>
      ) : (
        <>
          <div className="mb-2 flex gap-1.5 overflow-x-auto md:hidden">
            {lanes.map((lane) => (
              <button
                key={lane.id}
                type="button"
                className="btn min-h-6 shrink-0"
                onClick={() => document.querySelector(`[data-lane="${lane.id}"]`)?.scrollIntoView({ inline: "start", block: "nearest" })}
              >
                {lane.label}
              </button>
            ))}
          </div>
          <div className={`context-scroller ${canScroll ? "can-scroll" : ""}`}>
            <div className="context-lanes" ref={scroller}>
              {filled.map((lane) => (
                <Lane
                  key={lane.id}
                  lane={lane}
                  hidden={Math.max(0, lane.cards.length - (more[lane.id] ? lane.cards.length : PAGE))}
                  cards={more[lane.id] ? lane.cards : lane.cards.slice(0, PAGE)}
                  matchCount={lane.cards.length}
                  filtering={filtering}
                  drag={drag}
                  neighbours={neighbours}
                  hoverId={open || drag || proposal ? null : hoverId}
                  onMore={() => setMore((prev) => ({ ...prev, [lane.id]: true }))}
                  onOpen={showCard}
                  onHover={setHoverId}
                  onReorder={(idsInLane) => reorder(lane.id, idsInLane)}
                  onDrag={setDrag}
                  onPropose={(card, targetId, x, y) => {
                    const project = allCards.find((row) => row.id === targetId && row.kind === "project");
                    if (project) setProposal({ card, project, x, y });
                  }}
                  onAdd={lane.kind === "people" || lane.kind === "projects" ? () => setAdding(lane.kind as "people" | "projects") : undefined}
                />
              ))}
            </div>
            {canScroll ? (
              <button
                type="button"
                className="lane-next"
                aria-label="Next lanes"
                onClick={() => scroller.current?.scrollBy({ left: 280, behavior: "smooth" })}
              >
                →
              </button>
            ) : null}
          </div>
          {empty.length ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {empty.map((lane) => (
                <button
                  key={lane.id}
                  type="button"
                  className="lane-slim"
                  data-lane={lane.id}
                  onClick={() => (lane.kind === "people" || lane.kind === "projects" ? setAdding(lane.kind) : undefined)}
                >
                  {lane.label}
                  <span className="text-muted">{EMPTY[lane.kind]?.split(".")[0]}</span>
                  {lane.kind === "people" || lane.kind === "projects" ? <span className="text-accent">Add</span> : null}
                </button>
              ))}
            </div>
          ) : null}
        </>
      )}
      {adding ? (
        <form
          className="tile mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-panel p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <input className="field min-w-[12rem] flex-1" autoFocus aria-label={adding === "people" ? "Person name" : "Project name"} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={adding === "people" ? "Name" : "Project name"} />
          <button type="submit" className="btn-primary min-h-6">
            Add
          </button>
          <button type="button" className="btn min-h-6" onClick={() => setAdding(null)}>
            Cancel
          </button>
        </form>
      ) : null}
      {proposal ? (
        <div className="context-propose" role="dialog" aria-label="Link to project" style={{ left: Math.min(proposal.x, window.innerWidth - 280), top: Math.min(proposal.y + 12, window.innerHeight - 120) }}>
          <p className="text-[14px]">
            Link <span className="font-medium">{proposal.card.title}</span> to <span className="font-medium">{proposal.project.title}</span>?
          </p>
          <div className="mt-2 flex gap-2">
            <button type="button" className="btn-primary min-h-6" onClick={() => void applyLink()}>
              Apply
            </button>
            <button type="button" className="btn min-h-6" onClick={() => setProposal(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {drag ? (
        <div className="context-drag" style={{ left: Math.min(Math.max(8, drag.x - 16), window.innerWidth - 188), top: Math.min(Math.max(8, drag.y - 16), window.innerHeight - 48) }}>
          {drag.linkId ? `Link ${drag.card.title}` : drag.card.title}
        </div>
      ) : null}
      {open ? <Peek card={open} cards={allCards} onOpen={showCard} onClose={() => setOpenId(null)} onChanged={() => void reload()} /> : null}
    </div>
  );
}

function Lane({
  lane,
  cards,
  matchCount,
  hidden,
  filtering,
  drag,
  neighbours,
  hoverId,
  onMore,
  onOpen,
  onHover,
  onReorder,
  onDrag,
  onPropose,
  onAdd,
}: {
  lane: LaneModel;
  cards: BoardCard[];
  matchCount: number;
  hidden: number;
  filtering: boolean;
  drag: Drag | null;
  neighbours: Set<string>;
  hoverId: string | null;
  onMore: () => void;
  onOpen: (card: BoardCard) => void;
  onHover: (id: string | null) => void;
  onReorder: (ids: string[]) => void;
  onDrag: (drag: Drag | null) => void;
  onPropose: (card: BoardCard, targetId: string, x: number, y: number) => void;
  onAdd?: () => void;
}) {
  const repeated = new Set<string>();
  if (cards.length > 1) {
    const counts = new Map<string, number>();
    for (const card of cards) {
      for (const chip of new Set(card.chips)) counts.set(chip, (counts.get(chip) ?? 0) + 1);
    }
    for (const [chip, count] of counts) {
      if (count === cards.length) repeated.add(chip);
    }
  }
  const metas = cards.map((card) => card.meta).filter((meta): meta is string => Boolean(meta) && !PLACEHOLDER_META.has(meta ?? ""));
  const sharedMeta = cards.length > 1 && metas.length === cards.length && metas.every((meta) => meta === metas[0]) ? metas[0] : null;
  const start = (event: React.PointerEvent, card: BoardCard) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("a, input, select, textarea")) return;
    const handle = event.currentTarget as HTMLElement;
    const startX = event.clientX;
    const startY = event.clientY;
    const pointerId = event.pointerId;
    const fromGrip = Boolean(target.closest("[data-drag-handle]"));
    const touchBody = event.pointerType === "touch" && !fromGrip;
    let dragging = false;
    let movedFar = false;
    let overId: string | null = null;
    let linkId: string | null = null;
    let settled = false;
    let hold = 0;
    let edgeFrame = 0;
    let lastTick = 0;
    let edgeSince = 0;
    let lastX = startX;
    let lastY = startY;
    const point = (ev: Event) => ev as globalThis.PointerEvent;
    const lanes = () => document.querySelector<HTMLElement>(".context-lanes");
    const cleanup = () => {
      if (hold) window.clearTimeout(hold);
      if (edgeFrame) window.cancelAnimationFrame(edgeFrame);
      delete handle.dataset.dragArmed;
      handle.style.touchAction = "";
      lanes()?.classList.remove("is-dragging");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      handle.removeEventListener("lostpointercapture", lost);
      window.removeEventListener("keydown", esc);
    };
    const scrollEdges = (now: number) => {
      edgeFrame = 0;
      if (settled || !dragging) return;
      const scroller = lanes();
      if (scroller) {
        const rect = scroller.getBoundingClientRect();
        const dir = lastX > rect.right - 48 ? 1 : lastX < rect.left + 48 ? -1 : 0;
        if (!dir) edgeSince = 0;
        else {
          if (!edgeSince) edgeSince = now;
          const dt = Math.min(lastTick ? now - lastTick : 16, 32);
          const t = Math.min(1, (now - edgeSince) / 400);
          const speed = 120 + 330 * t * t;
          scroller.scrollLeft += dir * speed * (dt / 1000);
        }
      }
      lastTick = now;
      edgeFrame = window.requestAnimationFrame(scrollEdges);
    };
    const capture = (id: number, origin: EventTarget | null) => {
      const el = origin instanceof Element ? origin : null;
      const captor = el?.closest<HTMLElement>("[data-drag-handle]") ?? handle;
      try {
        if (!captor.hasPointerCapture(id)) captor.setPointerCapture(id);
      } catch {
        // capture can fail if the pointer already ended
      }
    };
    const arm = (id: number, origin: EventTarget | null) => {
      if (dragging || settled) return;
      dragging = true;
      handle.dataset.dragArmed = "true";
      handle.style.touchAction = "none";
      lanes()?.classList.add("is-dragging");
      capture(id, origin);
      if (!edgeFrame) edgeFrame = window.requestAnimationFrame(scrollEdges);
    };
    const finish = (commit: boolean, pointer?: globalThis.PointerEvent) => {
      if (settled) return;
      settled = true;
      if (dragging || movedFar) {
        const stopClick = (ev: Event) => {
          ev.preventDefault();
          ev.stopPropagation();
        };
        handle.addEventListener("click", stopClick, true);
        window.setTimeout(() => handle.removeEventListener("click", stopClick, true), 0);
      }
      cleanup();
      onDrag(null);
      if (!commit || !dragging || !pointer) return;
      const hit = document.elementFromPoint(pointer.clientX, pointer.clientY)?.closest("[data-card]");
      const targetId = hit?.getAttribute("data-card");
      const targetKind = hit?.getAttribute("data-kind");
      if (targetId && targetKind === "project" && targetId !== card.id && (card.kind === "people" || card.kind === "repo") && hit?.closest("[data-lane]")?.getAttribute("data-lane") !== lane.id) {
        onPropose(card, targetId, pointer.clientX, pointer.clientY);
        return;
      }
      if (overId && overId !== card.id) onReorder(moveId(cards.map((row) => row.id), card.id, overId));
    };
    const move = (ev: Event) => {
      const pointer = point(ev);
      lastX = pointer.clientX;
      lastY = pointer.clientY;
      const dist = Math.hypot(pointer.clientX - startX, pointer.clientY - startY);
      if (!dragging) {
        if (touchBody) {
          if (dist > 10) {
            movedFar = true;
            finish(false);
          }
          return;
        }
        if (dist < 6) return;
        arm(pointer.pointerId, pointer.target);
      }
      const hit = document.elementFromPoint(pointer.clientX, pointer.clientY)?.closest("[data-card]");
      const hitLane = hit?.closest("[data-lane]")?.getAttribute("data-lane");
      const targetId = hit?.getAttribute("data-card") ?? null;
      const targetKind = hit?.getAttribute("data-kind");
      overId = hitLane === lane.id && targetId !== card.id ? targetId : null;
      linkId = targetKind === "project" && targetId && targetId !== card.id && hitLane !== lane.id && (card.kind === "people" || card.kind === "repo") ? targetId : null;
      onDrag({ card, laneId: lane.id, x: pointer.clientX, y: pointer.clientY, overId, linkId });
    };
    const up = (ev: Event) => finish(true, point(ev));
    const cancel = () => finish(false);
    // A touch on the grip already owns capture. Moving capture onto the card
    // makes the grip fire lostpointercapture, which would cancel the drag.
    const lost = (ev: Event) => {
      if (ev.target !== handle) return;
      finish(false);
    };
    const esc = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(false);
    };
    if (touchBody) {
      hold = window.setTimeout(() => {
        if (settled) return;
        arm(pointerId, event.target);
        onDrag({ card, laneId: lane.id, x: lastX, y: lastY, overId: null, linkId: null });
      }, 420);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    handle.addEventListener("lostpointercapture", lost);
    window.addEventListener("keydown", esc);
  };
  return (
    <section className="context-lane" data-lane={lane.id} data-kind={lane.kind} aria-label={lane.label}>
      <header className="lane-head">
        <h2>{lane.label}</h2>
        <span className="lane-count">{filtering ? `${matchCount} / ${lane.total}` : matchCount}</span>
        {lane.progress && lane.progress.total > 0 ? (
          <span className="text-[12px] text-muted">
            {lane.progress.done}/{lane.progress.total}
          </span>
        ) : null}
        {onAdd ? (
          <button type="button" className="btn ml-auto min-h-6 px-2" onClick={onAdd}>
            Add
          </button>
        ) : (
          <span className="ml-auto" />
        )}
      </header>
      {sharedMeta || repeated.size ? <p className="lane-shared">{[sharedMeta, ...repeated].filter(Boolean).join(" · ")}</p> : null}
      <div className="flex flex-col gap-2">
        {cards.map((card) => (
          <Card
            key={card.id}
            card={card}
            chips={card.chips.filter((chip) => !repeated.has(chip))}
            hideMeta={Boolean(sharedMeta)}
            dragging={drag?.card.id === card.id}
            drop={drag?.overId === card.id}
            link={drag?.linkId === card.id}
            neighbour={neighbours.has(card.id)}
            hovered={hoverId === card.id}
            onOpen={onOpen}
            onHover={onHover}
            onPointerDown={(event) => start(event, card)}
            onKey={(event) => {
              if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
                event.preventDefault();
                const index = cards.findIndex((row) => row.id === card.id);
                const neighbor = cards[index + (event.key === "ArrowDown" ? 1 : -1)];
                if (neighbor) onReorder(moveId(cards.map((row) => row.id), card.id, neighbor.id));
              }
            }}
          />
        ))}
        {cards.length === 0 && !filtering ? (
          <p className="empty-state text-[13px]">
            {lane.id.startsWith("project:") ? (
              "Nothing linked yet. Drop a person or a repo here to propose a link."
            ) : (
              (EMPTY[lane.kind] ?? "Nothing in this lane.")
            )}
          </p>
        ) : null}
        {hidden > 0 ? (
          <button type="button" className="btn min-h-6" onClick={onMore}>
            {hidden} more
          </button>
        ) : null}
      </div>
    </section>
  );
}

function Card({
  card,
  chips,
  hideMeta,
  onOpen,
  onPointerDown,
  dragging,
  drop,
  link,
  neighbour,
  hovered,
  onHover,
  onKey,
}: {
  card: BoardCard;
  chips?: string[];
  hideMeta?: boolean;
  onOpen: (card: BoardCard) => void;
  onPointerDown?: (event: React.PointerEvent) => void;
  dragging?: boolean;
  drop?: boolean;
  link?: boolean;
  neighbour?: boolean;
  hovered?: boolean;
  onHover?: (id: string | null) => void;
  onKey?: (event: React.KeyboardEvent) => void;
}) {
  const shown = (chips ?? card.chips).slice(0, 2);
  const extra = (chips ?? card.chips).length - shown.length;
  const meta = !hideMeta && card.meta && !PLACEHOLDER_META.has(card.meta) ? card.meta : null;
  return (
    <article
      className={`entity-card entity-card-${card.kind}`}
      data-card={card.id}
      data-kind={card.kind}
      data-dragging={dragging || undefined}
      data-drop-target={drop ? card.id : undefined}
      data-link-target={link ? card.id : undefined}
      data-neighbour={neighbour || undefined}
      data-hovered={hovered || undefined}
      onTouchStart={(event) => {
        if ((event.target as HTMLElement).closest("[data-drag-handle], a, input, select, textarea")) return;
        const el = event.currentTarget;
        const block = (ev: TouchEvent) => {
          if (el.dataset.dragArmed === "true") ev.preventDefault();
        };
        el.addEventListener("touchmove", block, { passive: false });
        const stop = () => {
          el.removeEventListener("touchmove", block);
          el.removeEventListener("touchend", stop);
          el.removeEventListener("touchcancel", stop);
        };
        el.addEventListener("touchend", stop);
        el.addEventListener("touchcancel", stop);
      }}
      onMouseEnter={() => onHover?.(card.id)}
      onMouseLeave={() => onHover?.(null)}
      onPointerDown={onPointerDown}
    >
      <button type="button" className="entity-grip" data-drag-handle={card.id} aria-label={`Reorder ${card.title}`} tabIndex={-1} />
      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpen(card)} onKeyDown={onKey}>
        <span className="flex min-w-0 items-start gap-2.5">
          <Mark card={card} />
          <span className="min-w-0 flex-1">
            <span className="card-title">{card.title}</span>
            {card.subtitle && card.subtitle !== card.title ? <span className="mt-0.5 block truncate text-[12.5px] text-muted">{card.subtitle}</span> : null}
          </span>
        </span>
        {card.kind === "project" && card.progress ? (
          <span className="progress-row">
            <span className="progress" aria-label={`${card.progress.done} of ${card.progress.total} done`}>
              <span style={{ width: `${card.progress.total ? Math.round((card.progress.done / card.progress.total) * 100) : 0}%` }} />
            </span>
            <span className="progress-label">
              {card.progress.done}/{card.progress.total}
            </span>
          </span>
        ) : null}
        {meta ? <span className="mt-1.5 block truncate text-[12.5px] text-muted">{meta}</span> : null}
        {card.kind === "project" && card.members.length ? (
          <span className="avatar-stack" aria-hidden>
            {card.members.map((letters, index) => (
              <span key={`${letters}-${index}`} className="avatar avatar-sm" data-kind="people">
                {letters}
              </span>
            ))}
          </span>
        ) : null}
        {shown.length ? (
          <span className="mt-2 flex min-w-0 flex-wrap gap-1">
            {shown.map((chip) => (
              <span key={chip} className="chip" data-kind={card.kind}>
                {chip}
              </span>
            ))}
            {extra > 0 ? <span className="chip">+{extra}</span> : null}
          </span>
        ) : null}
      </button>
    </article>
  );
}

function Mark({ card }: { card: BoardCard }) {
  if (card.kind === "repo") {
    return <span className="lang-dot" style={{ background: LANG[card.language ?? ""] ?? "var(--kind-repo)" }} title={card.language ?? "Repo"} />;
  }
  if ((card.kind === "meeting" || card.kind === "artifact") && card.day) {
    return (
      <span className="date-block" aria-hidden>
        <span>{card.day}</span>
        <span>{card.month}</span>
      </span>
    );
  }
  if (card.kind === "artifact") {
    if (card.artifactKind === "task") return null;
    return (
      <span className="file-mark" data-kind={card.artifactKind ?? "file"} aria-hidden>
        {card.artifactKind === "deliverable" ? "DL" : "FILE"}
      </span>
    );
  }
  return (
    <span className="avatar" data-kind={card.kind} aria-hidden>
      {card.initials}
    </span>
  );
}

function kindName(kind: BoardCard["kind"], labels?: Record<string, string>): string {
  if (kind === "project" && labels?.project) return labels.project;
  if (kind === "people" && labels?.people) return labels.people;
  return KIND_LABEL[kind];
}

function List({ cards, onOpen }: { cards: BoardCard[]; onOpen: (card: BoardCard) => void }) {
  const labels = useShellLabels();
  if (!cards.length) return <p className="text-[13.5px] text-muted">Nothing matches.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-separate border-spacing-y-1 text-left">
        <thead>
          <tr className="text-[12px] uppercase tracking-[0.06em] text-muted">
            <th className="px-2 py-1 font-medium">Name</th>
            <th className="px-2 py-1 font-medium">Kind</th>
            <th className="px-2 py-1 font-medium">Detail</th>
            <th className="px-2 py-1 font-medium">Linked</th>
          </tr>
        </thead>
        <tbody>
          {cards.slice(0, 80).map((card) => (
            <tr key={`${card.lane}-${card.id}`} className="entity-row" data-card={card.id}>
              <td className="rounded-l-lg px-2 py-1.5">
                <button type="button" className="flex min-h-6 items-center gap-2 text-left" onClick={() => onOpen(card)}>
                  <Mark card={card} />
                  <span className="text-[14px] font-medium">{card.title}</span>
                </button>
              </td>
              <td className="px-2 py-1.5 text-[13px] text-muted">{kindName(card.kind, labels)}</td>
              <td className="px-2 py-1.5 text-[13px] text-muted">{card.subtitle || card.meta}</td>
              <td className="rounded-r-lg px-2 py-1.5 text-[13px] text-muted">{card.chips.slice(0, 2).join(", ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Peek({ card, cards, onOpen, onClose, onChanged }: { card: BoardCard; cards: BoardCard[]; onOpen: (card: BoardCard) => void; onClose: () => void; onChanged: () => void }) {
  const labels = useShellLabels();
  const toast = emitToast;
  const panel = useRef<HTMLElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const menuOpen = useRef(false);
  menuOpen.current = menu;
  const [menuAt, setMenuAt] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [name, setName] = useState(card.title);
  const [detail, setDetail] = useState(card.subtitle ?? "");
  const [linkId, setLinkId] = useState("");
  const [seen, setSeen] = useState({ id: card.id, title: card.title, subtitle: card.subtitle ?? "" });
  if (seen.id !== card.id || seen.title !== card.title || seen.subtitle !== (card.subtitle ?? "")) {
    const next = { id: card.id, title: card.title, subtitle: card.subtitle ?? "" };
    setSeen(next);
    setName(next.title);
    setDetail(next.subtitle);
    setLinkId("");
    setMenu(false);
    setConfirm(false);
  }
  const related = cards.filter((other) => other.id !== card.id && linked(card, other)).slice(0, 12);
  const editable = card.kind === "people" || card.kind === "project";
  const linkChoices = cards.filter((other) => {
    if (card.kind === "project") return other.kind === "people" && !card.personIds.includes(other.id);
    if (card.kind === "people" || card.kind === "repo") return other.kind === "project" && !card.projectIds.includes(other.id);
    return false;
  });
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = panel.current;
    root?.querySelector<HTMLElement>("button, a")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (menuOpen.current) {
          setMenu(false);
          return;
        }
        onClose();
        return;
      }
      if (event.key !== "Tab" || !root) return;
      const items = [
        ...root.querySelectorAll<HTMLElement>("button, a, input, select"),
        ...document.querySelectorAll<HTMLElement>("[data-peek-menu] button, [data-peek-menu] a"),
      ];
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
    // Close stays the function from the open. Rebinding on every parent render would steal focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id]);
  const undone = (label: string, run: () => Promise<unknown>) => {
    toast(label, {
      action: {
        label: "Undo",
        run: () => {
          void run().then(() => onChanged());
        },
      },
    });
    onChanged();
  };
  const saveDetails = async () => {
    const nextName = name.trim();
    if (!nextName) return;
    const previousName = card.title;
    const previousDetail = card.subtitle ?? "";
    try {
      if (card.kind === "people") await api.patchPerson(card.id, { name: nextName, role: detail.trim() });
      else if (card.kind === "project") await api.patchProject(card.id, { name: nextName, summary: detail.trim() });
      else return;
      undone("Saved.", async () => {
        if (card.kind === "people") await api.patchPerson(card.id, { name: previousName, role: previousDetail });
        else await api.patchProject(card.id, { name: previousName, summary: previousDetail });
      });
    } catch (error) {
      toast((error as Error).message, { tone: "error" });
    }
  };
  const changeLink = async (other: BoardCard, linkedNow: boolean) => {
    const project = card.kind === "project" ? card : other.kind === "project" ? other : null;
    if (!project) return;
    const person = card.kind === "people" ? card : other.kind === "people" ? other : null;
    const repo = card.kind === "repo" ? card : other.kind === "repo" ? other : null;
    try {
      if (person) {
        const next = linkedNow ? project.personIds.filter((id) => id !== person.id) : [...project.personIds, person.id];
        await api.patchProject(project.id, { personIds: next });
        undone(linkedNow ? `Unlinked ${person.title}.` : `Linked ${person.title}.`, () => api.patchProject(project.id, { personIds: project.personIds }));
      } else if (repo) {
        const next = linkedNow ? project.repoIds.filter((id) => id !== repo.id) : [...project.repoIds, repo.id];
        await api.patchProject(project.id, { repoIds: next });
        undone(linkedNow ? `Unlinked ${repo.title}.` : `Linked ${repo.title}.`, () => api.patchProject(project.id, { repoIds: project.repoIds }));
      }
      setLinkId("");
    } catch (error) {
      toast((error as Error).message, { tone: "error" });
    }
  };
  const openMenu = () => {
    const rect = moreRef.current?.getBoundingClientRect();
    const next = rect
      ? placeAnchoredPanel({
          anchor: rect,
          panelWidth: 240,
          panelHeight: 180,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          gap: 6,
        })
      : { left: 8, top: 80, maxHeight: 320 };
    setMenuAt({ left: next.left, top: next.top, maxHeight: next.maxHeight });
    setConfirm(false);
    setMenu(true);
  };
  const remove = async () => {
    try {
      if (card.kind === "people") await api.deletePerson(card.id);
      else if (card.kind === "project") await api.deleteProject(card.id);
      else return;
      const kind = card.kind === "people" ? "person" : "project";
      const id = card.id;
      const title = card.title;
      toast(`Removed ${title}.`, {
        action: {
          label: "Undo",
          run: () => {
            void api.restoreDeleted({ kind, id }).then(() => onChanged());
          },
        },
      });
      onClose();
      onChanged();
    } catch (error) {
      toast((error as Error).message, { tone: "error" });
    }
  };
  return (
    <>
      <button type="button" className="peek-scrim" aria-label="Close details" onClick={onClose} />
      <aside ref={panel} className="context-peek" data-peek={card.id} role="dialog" aria-modal="true" aria-label={card.title}>
        <div className="peek-band" data-kind={card.kind}>
          <Mark card={card} />
          <div className="min-w-0 flex-1">
            <div className="text-[12px] font-medium text-muted">{kindName(card.kind, labels)}</div>
            <h2 className="truncate text-[22px] font-semibold leading-tight">{card.title}</h2>
            {card.subtitle ? <p className="mt-1 truncate text-[13.5px] text-muted">{card.subtitle}</p> : null}
          </div>
          <button type="button" className="btn min-h-6" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <AskEnsemble prominent surface="context" anchorKey={`context:${card.id}`} label={`Ask about ${card.title}`} entityIds={[card.id]} contextLabel={card.title} />
          {card.kind === "project" ? (
            <Link href={`/projects/${card.id}`} className="btn min-h-8">
              Open project
            </Link>
          ) : null}
          {card.href ? (
            <a href={card.href} className="btn min-h-8" target={card.href.startsWith("http") ? "_blank" : undefined} rel="noreferrer">
              Open
            </a>
          ) : null}
          {card.kind === "people" || card.kind === "project" ? (
            <button ref={moreRef} type="button" className="btn min-h-8" aria-label="More actions" aria-expanded={menu} onClick={openMenu}>
              More
            </button>
          ) : null}
        </div>
        {card.meta && !PLACEHOLDER_META.has(card.meta) ? <p className="mt-4 text-[13.5px] text-muted">{card.meta}</p> : null}
        {card.progress ? (
          <p className="mt-2 text-[13px] text-muted">
            {card.progress.done} of {card.progress.total} done
          </p>
        ) : null}
        {editable ? (
          <form
            className="mt-4 flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void saveDetails();
            }}
          >
            <label className="text-[12px] text-muted">
              Name
              <input className="field mt-1 w-full" value={name} onChange={(event) => setName(event.target.value)} aria-label="Name" />
            </label>
            <label className="text-[12px] text-muted">
              {card.kind === "people" ? "Role" : "Summary"}
              <input className="field mt-1 w-full" value={detail} onChange={(event) => setDetail(event.target.value)} aria-label={card.kind === "people" ? "Role" : "Summary"} />
            </label>
            <button type="submit" className="btn min-h-6 self-start">
              Save
            </button>
          </form>
        ) : null}
        <h3 className="mb-2 mt-5 text-[13px] font-medium">Linked</h3>
        {related.length ? (
          <div className="flex flex-col gap-1">
            {related.map((other) => (
              <div key={other.id} className="peek-link">
                <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => onOpen(other)}>
                  <Mark card={other} />
                  <span className="min-w-0 flex-1 truncate">{other.title}</span>
                </button>
                <span className="text-[12px] text-muted">{kindName(other.kind, labels)}</span>
                {canUnlink(card, other) ? (
                  <button type="button" className="btn min-h-6 px-2" onClick={() => void changeLink(other, true)}>
                    Unlink
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[13.5px] text-muted">No direct links yet.</p>
        )}
        {linkChoices.length ? (
          <form
            className="mt-2 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const other = linkChoices.find((row) => row.id === linkId);
              if (other) void changeLink(other, false);
            }}
          >
            <select className="field min-w-0 flex-1 py-1" aria-label="Link to" value={linkId} onChange={(event) => setLinkId(event.target.value)}>
              <option value="">Link…</option>
              {linkChoices.map((other) => (
                <option key={other.id} value={other.id}>
                  {other.title}
                </option>
              ))}
            </select>
            <button type="submit" className="btn min-h-6" disabled={!linkId}>
              Link
            </button>
          </form>
        ) : null}
        <h3 className="mb-2 mt-5 text-[13px] font-medium">Recent</h3>
        {card.activity.length ? (
          <ul className="flex flex-col gap-1">
            {card.activity.map((item) => (
              <li key={item.id} className="peek-link">
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                <span className="text-[12px] text-muted">{item.when}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13.5px] text-muted">No recent tasks on this record.</p>
        )}
      </aside>
      {menu && menuAt
        ? createPortal(
            <div className="menu-pop menu-fixed overflow-y-auto" data-peek-menu style={{ left: menuAt.left, top: menuAt.top, maxHeight: menuAt.maxHeight }} role="menu">
              {confirm ? (
                <div className="px-2 py-1.5 text-[13px]">
                  Remove {card.title}?
                  <div className="mt-2 flex gap-2">
                    <button type="button" className="btn-danger min-h-6" onClick={() => void remove()}>
                      Remove
                    </button>
                    <button type="button" className="btn min-h-6" onClick={() => setConfirm(false)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button type="button" className="menu-item text-danger" onClick={() => setConfirm(true)}>
                  Remove
                </button>
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
