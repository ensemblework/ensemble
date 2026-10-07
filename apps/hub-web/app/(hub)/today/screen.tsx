"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Mail, Plus } from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AssignDialog } from "@/components/agent/assign-dialog";
import { usePeek } from "@/components/shell/peek";
import { DeliverablesRail, RemindersRail } from "@/components/today/rail";
import { MeetingCues } from "@/components/today/meeting-cues";
import { StaleNudges } from "@/components/today/stale-nudges";
import { WorkCalendar } from "@/components/today/work-calendar";
import { useToast } from "@/components/toast";
import { PriorityTag, SkeletonRows, cx } from "@/components/ui";
import { api, type TaskRecord, type TaskStatus } from "@/lib/api";
import { dueLabel, startOfDay } from "@/lib/format";
import { safeDate } from "@/lib/safe-date";
import { PageErrorBoundary } from "@/components/page-error";
import { AskEnsemble } from "@/components/ensemble/ask-button";
import { WidgetCanvas } from "@/components/widgets/canvas";
import type { LayoutPayload, TodayCues, TodayNudges } from "@/lib/server-layout";
import { MorningBrief, NeedsMeCount, PeopleGlance, ReposGlance, WeekRecapLink } from "@/components/widgets/glances";
import { useTodayData } from "@/lib/home";
import { WIDGET_REGISTRY, type Size, type TileConfig, type WidgetId } from "@ensemble/shared-types/widgets";
const LensTile = dynamic(() => import("@/components/widgets/lenses").then((mod) => mod.LensTile), { ssr: false });
import { invalidateSoon } from "@/lib/invalidate";
import { useWarmEditors, warmTask } from "@/lib/warm";

const COMPLETABLE: TaskStatus[] = ["todo", "in_progress", "waiting_approval"];

function dueByToday(due: string | null): boolean {
  const date = due ? safeDate(due) : null;
  if (!date) return false;
  return startOfDay(date).getTime() <= startOfDay().getTime();
}

function Orbit({
  known,
  focus,
  proposed,
  deliverables,
  people,
  projects,
  size = "m",
}: {
  known: boolean;
  focus: number;
  proposed: number;
  deliverables: number | null;
  people: string[];
  projects: string[];
  size?: Size;
}) {
  const router = useRouter();
  const rowRef = useRef<HTMLDivElement>(null);
  const [spread, setSpread] = useState(false);
  useLayoutEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const measure = () => {
      const kids = Array.from(el.children) as HTMLElement[];
      if (kids.length < 2) {
        setSpread(true);
        return;
      }
      const top = kids[0]!.offsetTop;
      setSpread(kids.every((kid) => Math.abs(kid.offsetTop - top) < 2));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const text = (value: number | null) => (known && value !== null ? String(value) : "-");
  const beads = [
    { key: "focus", n: text(known ? focus : null), label: "in focus", onClick: () => scrollTo("focus") },
    { key: "proposed", n: text(known ? proposed : null), label: "proposed", onClick: () => scrollTo("proposed") },
    {
      key: "deliverables",
      n: text(deliverables),
      label: deliverables === 1 ? "deliverable" : "deliverables",
      onClick: () => scrollTo("deliverables"),
    },
    {
      key: "people",
      n: text(known ? people.length : null),
      label: people.length === 1 ? "person" : "people",
      onClick: () => router.push(people.length ? `/context?tab=people&who=${people.map(encodeURIComponent).join(",")}` : "/context?tab=people"),
    },
    {
      key: "projects",
      n: text(known ? projects.length : null),
      label: projects.length === 1 ? "project" : "projects",
      onClick: () =>
        router.push(projects.length ? `/context?tab=projects&ids=${projects.map(encodeURIComponent).join(",")}` : "/context?tab=projects"),
    },
  ];
  return (
    <div className="relative min-w-0 overflow-hidden">
      {spread && size !== "s" ? (
        <svg className="pointer-events-none absolute inset-x-2 top-1/2 h-6 w-[calc(100%-1rem)] -translate-y-1/2" viewBox="0 0 100 16" preserveAspectRatio="none" aria-hidden>
          <path d="M0 10 C 18 10, 22 4, 40 4 S 62 13, 80 6 S 92 8, 100 7" fill="none" stroke="rgb(var(--accent-rgb))" strokeOpacity="0.45" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
        </svg>
      ) : null}
      <div ref={rowRef} className={cx("relative grid gap-1", size === "s" ? "grid-cols-2" : "flex flex-wrap items-center")}>
        {beads.map((bead) => (
          <button
            key={bead.key}
            type="button"
            onClick={bead.onClick}
            className={cx("flex min-w-0 items-center gap-1.5 rounded-full bg-panel/95 px-2 py-1 hover:bg-panel", size !== "s" && spread && "flex-1 justify-center")}
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
            <span className="display inline-block text-center text-[16px] leading-none">{bead.n}</span>
            <span className="truncate text-[12px] text-muted">{bead.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function isFocus(task: TaskRecord): boolean {
  if (task.status === "done" || task.status === "dropped" || task.status === "proposed") return false;
  if (task.todayFocus === "hidden") return false;
  if (task.todayFocus === "keep") return true;
  if (task.priority === "p0") return true;
  return Boolean(task.due && startOfDay(new Date(task.due)) <= startOfDay());
}

function ProposedCard({
  task,
  active,
  onSelect,
  onAct,
}: {
  task: TaskRecord;
  active: boolean;
  onSelect: () => void;
  onAct: (action: "mine" | "agent" | "later" | "drop" | "open") => void;
}) {
  const client = useQueryClient();
  const [details, setDetails] = useState(false);
  return (
    <div
      className="tile rounded-xl bg-panel px-3 py-2.5"
      data-active={active || undefined}
      onMouseEnter={() => {
        warmTask(client, task.id);
        onSelect();
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="text-[14px] font-semibold leading-5">{task.title}</div>
        <PriorityTag priority={task.priority} />
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-[12px] text-muted">
        <Mail size={12} />
        {task.sourceKind}
      </div>
      <button
        type="button"
        onClick={() => setDetails(!details)}
        className="mt-1 flex items-center gap-1 text-[12px] text-muted hover:text-ink"
      >
        <ChevronRight size={12} className={cx("transition-transform", details && "rotate-90")} />
        Details &amp; source
      </button>
      {details ? (
        <div className="mt-1.5 space-y-1 border-l border-line pl-3 text-[12.5px] leading-5 text-muted">
          {task.rationale ? <p>{task.rationale}</p> : null}
          {task.excerpt ? <p className="italic">“{task.excerpt}”</p> : null}
          {task.sourceUrl ? (
            <a href={task.sourceUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">
              Open the original ↗
            </a>
          ) : (
            <p>{task.sourceRef || "Added by hand."}</p>
          )}
        </div>
      ) : null}
      <div className="mt-2 flex items-center gap-1">
        <button type="button" className="btn-primary px-2 py-0.5 text-[12px]" onClick={() => onAct("mine")}>
          I&apos;ll do it
        </button>
        <button type="button" className="btn px-2 py-0.5 text-[12px]" onClick={() => onAct("agent")}>
          Agent does it
        </button>
        <button type="button" className="btn-ghost px-2 py-0.5 text-[12px]" onClick={() => onAct("later")}>
          Later
        </button>
        <button type="button" className="btn-ghost px-2 py-0.5 text-[12px]" onClick={() => onAct("drop")}>
          Drop
        </button>
        <button type="button" className="btn-ghost px-2 py-0.5 text-[12px]" onClick={() => onAct("open")}>
          Open
        </button>
      </div>
    </div>
  );
}

export function TodayScreen({
  initialLayout = null,
  initialNudges = null,
  initialCues = null,
  samples = false,
}: {
  initialLayout?: LayoutPayload | null;
  initialNudges?: TodayNudges | null;
  initialCues?: TodayCues | null;
  samples?: boolean;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const peek = usePeek();
  useWarmEditors("peek");
  const { home, ready, timezone } = useTodayData();
  const params = useSearchParams();
  const deliverableId = params.get("deliverable");
  const tasks = useQuery({
    queryKey: ["tasks"],
    queryFn: api.tasks,
    enabled: ready || client.getQueryData(["tasks"]) !== undefined,
  });
  const [title, setTitle] = useState("");
  const [selected, setSelected] = useState(0);
  const [shortcuts, setShortcuts] = useState(false);
  const [assignTask, setAssignTask] = useState<string | null>(null);
  const waiting = !tasks.data && (home.isError || home.failureCount > 0);
  const known = Boolean(tasks.data);
  const list = tasks.data?.tasks ?? [];
  const focus = useMemo(
    () =>
      list
        .filter(isFocus)
        .sort((a, b) => a.priority.localeCompare(b.priority) || (a.due ?? "9").localeCompare(b.due ?? "9")),
    [list],
  );
  const proposed = useMemo(
    () =>
      list
        .filter((task) => task.status === "proposed" && (!task.snoozedUntil || new Date(task.snoozedUntil) <= new Date()))
        .sort((a, b) => a.boardOrder - b.boardOrder),
    [list],
  );
  const todayWork = useMemo(() => [...focus, ...proposed], [focus, proposed]);
  const todayPeople = useMemo(() => [...new Set(todayWork.flatMap((task) => task.people))], [todayWork]);
  const todayProjects = useMemo(
    () => [...new Set(todayWork.map((task) => task.projectId).filter((id): id is string => Boolean(id)))],
    [todayWork],
  );
  const deliverables = useQuery({
    queryKey: ["deliverables", false],
    queryFn: () => api.deliverables(false),
    enabled: ready || client.getQueryData(["deliverables", false]) !== undefined,
  });
  const todayDeliverables = deliverables.data ? deliverables.data.deliverables.filter((row) => dueByToday(row.due)).length : null;

  const create = useMutation({
    mutationFn: (value: string) => api.createTask({ title: value, status: "todo", owner: "me", todayFocus: "keep" }),
    onSuccess: () => {
      setTitle("");
      invalidateSoon(client, ["tasks"]);
    },
  });

  const act = useMutation({
    mutationFn: async ({ task, action }: { task: TaskRecord; action: "mine" | "later" | "drop" | "done" | "hide" }) => {
      if (action === "mine") return api.patchTask(task.id, { owner: "me", status: "todo" });
      if (action === "drop") return api.patchTask(task.id, { status: "dropped" });
      if (action === "done") return api.patchTask(task.id, { status: "done" });
      if (action === "hide") return api.patchTask(task.id, { todayFocus: "hidden" });
      const tomorrow = startOfDay();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(9);
      return api.patchTask(task.id, { snoozedUntil: tomorrow.toISOString() });
    },
    onMutate: async ({ task, action }) => {
      await client.cancelQueries({ queryKey: ["tasks"] });
      const previous = client.getQueryData<{ tasks: TaskRecord[] }>(["tasks"]);
      if (previous) {
        client.setQueryData(["tasks"], {
          tasks: previous.tasks.map((row) => {
            if (row.id !== task.id) return row;
            if (action === "mine") return { ...row, owner: "me" as const, status: "todo" as const };
            if (action === "drop") return { ...row, status: "dropped" as const };
            if (action === "done") return { ...row, status: "done" as const, completedAt: new Date().toISOString() };
            if (action === "hide") return { ...row, todayFocus: "hidden" as const };
            const tomorrow = startOfDay();
            tomorrow.setDate(tomorrow.getDate() + 1);
            tomorrow.setHours(9);
            return { ...row, snoozedUntil: tomorrow.toISOString() };
          }),
        });
      }
      return { previous };
    },
    onSuccess: (result, { action }) => {
      if (action === "hide") return;
      const text = { mine: "On your board.", later: "Back tomorrow morning.", drop: "Dropped.", done: "Marked done." }[action];
      const entryId = result?.undoEntryId ?? undefined;
      toast(text, {
        action: {
          label: "Undo",
          run: () => {
            void api
              .undo(entryId)
              .then(() => client.invalidateQueries())
              .catch((error: Error) => toast(error.message, { tone: "error" }));
          },
        },
      });
    },
    onError: (error, _vars, context) => {
      if (context?.previous) client.setQueryData(["tasks"], context.previous);
      toast((error as Error).message, { tone: "error" });
    },
    onSettled: () => invalidateSoon(client, ["tasks"]),
  });

  const handle = (task: TaskRecord, action: "mine" | "agent" | "later" | "drop" | "open") => {
    if (action === "open") peek.open(task.id);
    else if (action === "agent") setAssignTask(task.id);
    else act.mutate({ task, action });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (document.querySelector("[data-layout-editing]")) return;
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable=true]") || peek.peekId || assignTask) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (!proposed.length) return;
      const task = proposed[Math.min(selected, proposed.length - 1)];
      if (!task) return;
      const key = event.key.toLowerCase();
      if (key === "j" || key === "arrowdown") setSelected((value) => Math.min(value + 1, proposed.length - 1));
      else if (key === "k" || key === "arrowup") setSelected((value) => Math.max(value - 1, 0));
      else if (key === "m") handle(task, "mine");
      else if (key === "a") handle(task, "agent");
      else if (key === "l") handle(task, "later");
      else if (key === "d") handle(task, "drop");
      else if (key === "o" || key === "enter") handle(task, "open");
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposed, selected, peek.peekId]);


  const zone = timezone === "local time" ? Intl.DateTimeFormat().resolvedOptions().timeZone : timezone;
  const renderWidget = (type: string, size: Size, placement?: { config?: TileConfig }) => {
    if (type === "orbit") {
      return (
        <Orbit known={known} focus={focus.length} proposed={proposed.length} deliverables={todayDeliverables} people={todayPeople} projects={todayProjects} size={size} />
      );
    }
    if (type === "meeting-cues") return <MeetingCues />;
    if (type === "calendar") return <WorkCalendar timezone={timezone} size={size} />;
    if (type === "stale-nudges") return <StaleNudges />;
    if (type === "morning-brief") return <MorningBrief size={size} />;
    if (type === "week-recap") return <WeekRecapLink />;
    if (type === "needs-me") return <NeedsMeCount />;
    if (type === "people") return <PeopleGlance size={size} />;
    if (type === "repos") return <ReposGlance size={size} />;
    if (type === "deliverables") return <DeliverablesRail highlightId={deliverableId} size={size} />;
    if (type === "reminders") {
      return <RemindersRail timezone={zone} size={size} />;
    }
    if (type === "focus") {
      const cap = size === "m" ? 3 : size === "l" ? 6 : focus.length;
      const shown = focus.slice(0, cap);
      const more = focus.length - shown.length;
      return (
        <section id="focus">
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
            {size !== "m" ? (
              <form
                className="flex items-center gap-1"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (title.trim()) create.mutate(title.trim());
                }}
              >
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Add task"
                  className="w-28 min-w-0 bg-transparent text-right text-[12.5px] outline-none placeholder:text-muted focus:w-40 focus:text-left"
                />
                <button type="submit" className="icon-btn h-6 w-6" aria-label="Add task">
                  <Plus size={13} />
                </button>
              </form>
            ) : null}
          </div>
          <p className="mb-2 text-[12.5px] text-muted">High priority, due today, and anything you pin. Removing here keeps it on the board.</p>
          {waiting ? (
            <div className="py-6 text-[13px] text-muted">Waiting for Ensemble to reconnect.</div>
          ) : !tasks.data ? (
            <SkeletonRows count={3} rowClassName="h-10" className="divide-y divide-line" />
          ) : shown.length === 0 ? (
            <div className="py-3 text-[13px] text-muted">Nothing urgent. Pin a task from its page to keep it here.</div>
          ) : (
            <div>
              {shown.map((task) => {
                const due = dueLabel(task.due);
                return (
                  <div
                    key={task.id}
                    className="row-tile group flex cursor-pointer items-center gap-3 rounded-md border-b border-b-line px-2 py-2"
                    onMouseEnter={() => warmTask(client, task.id)}
                    onFocus={() => warmTask(client, task.id)}
                    onClick={() => peek.open(task.id)}
                    data-active={peek.peekId === task.id || undefined}
                  >
                    {COMPLETABLE.includes(task.status) ? (
                      <button
                        type="button"
                        aria-label={`Mark done: ${task.title}`}
                        className="h-6 w-6 shrink-0 rounded-full border border-line-strong hover:border-accent"
                        onClick={(event) => {
                          event.stopPropagation();
                          act.mutate({ task, action: "done" });
                        }}
                      />
                    ) : (
                      <span className="h-4 w-4 shrink-0" />
                    )}
                    <PriorityTag priority={task.priority} />
                    <span className="flex-1 truncate text-[14px] font-medium">{task.title}</span>
                    {task.taskType ? <span className="text-[11px] uppercase tracking-wide text-faint">{task.taskType}</span> : null}
                    {due ? <span className={cx("text-[12px]", due.overdue ? "text-[#ffb4ae]" : "text-muted")}>{due.text}</span> : null}
                    <button
                      type="button"
                      className="btn-ghost py-0 text-[12px] opacity-0 group-hover:opacity-100"
                      onClick={(event) => {
                        event.stopPropagation();
                        act.mutate({ task, action: "hide" });
                      }}
                    >
                      Remove
                    </button>
                  </div>
                );
              })}
              {more > 0 ? <div className="px-2 pt-2 text-[12px] text-muted">{more} more</div> : null}
            </div>
          )}
        </section>
      );
    }
    if (type === "proposals") {
      const cap = size === "m" ? 3 : proposed.length;
      const shown = proposed.slice(0, cap);
      const more = proposed.length - shown.length;
      return (
        <section id="proposed">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[13px] text-muted">{known && !waiting ? `${proposed.length} waiting` : "Waiting"}</span>
            <button type="button" className="flex items-center gap-1 text-[12px] text-muted hover:text-ink" onClick={() => setShortcuts(!shortcuts)}>
              <ChevronRight size={12} className={cx("transition-transform", shortcuts && "rotate-90")} />
              Keyboard shortcuts
            </button>
          </div>
          {shortcuts ? (
            <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
              <span><span className="kbd">J</span>/<span className="kbd">K</span> move</span>
              <span><span className="kbd">M</span> I&apos;ll do it</span>
              <span><span className="kbd">A</span> agent does it</span>
              <span><span className="kbd">L</span> later</span>
              <span><span className="kbd">D</span> drop</span>
              <span><span className="kbd">O</span> open</span>
            </div>
          ) : null}
          {waiting ? (
            <div className="py-6 text-[13px] text-muted">Waiting for Ensemble to reconnect.</div>
          ) : !tasks.data ? (
            <SkeletonRows count={2} rowClassName="h-[138px] sm:h-[118px] rounded-xl" />
          ) : shown.length === 0 ? (
            <div className="py-3 text-[13px] text-muted">Nothing proposed. Fetch now reads your switched-on sources and proposes todos here.</div>
          ) : (
            <div className="space-y-2">
              {shown.map((task, index) => (
                <ProposedCard key={task.id} task={task} active={index === selected} onSelect={() => setSelected(index)} onAct={(action) => handle(task, action)} />
              ))}
              {more > 0 ? <div className="text-[12px] text-muted">{more} more</div> : null}
            </div>
          )}
        </section>
      );
    }
    if (WIDGET_REGISTRY[type as WidgetId]?.blurb) return <LensTile type={type as WidgetId} config={placement?.config} />;
    return null;
  };

  return (
    <PageErrorBoundary title="Today hit a bad value">
      <WidgetCanvas
        surface="today"
        title="Today"
        kicker={new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short" }).format(new Date())}
        toolbar={<AskEnsemble surface="today" anchorKey="today" label="Ask Ensemble about today" />}
        initialLayout={initialLayout}
        initialNudges={initialNudges}
        initialCues={initialCues}
        samples={samples}
        render={renderWidget}
      />
      <AssignDialog open={Boolean(assignTask)} taskId={assignTask ?? undefined} onClose={() => setAssignTask(null)} />
    </PageErrorBoundary>
  );
}
