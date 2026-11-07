"use client";

/**
 * Routines (docs/02 §3.10): work the assistant does on a schedule. One calm list: each routine says
 * when it runs, when it runs next and what its last run found; it runs now, pauses, changes in place
 * and opens its conversation in the assistant. New ones start from a blank card or an idea.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarRange, Inbox, MessageSquare, Moon, Pencil, Play, Plus, Repeat, Sparkles, Sunrise, Trash2, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Routine, type RoutineCadence } from "@/lib/api";
import { relative } from "@/lib/format";
import { useToast } from "@/components/toast";
import { TimeInput } from "@/components/date-time";
import { InfoTip, PageHeader, Segmented, SkeletonRows, Spinner, Toggle, cx } from "@/components/ui";

type Every = "hour" | "day" | "weekday" | "week" | "month" | "custom";
type Day = NonNullable<RoutineCadence["days"]>[number];
const DAYS: Array<[Day, string]> = [["mon", "M"], ["tue", "T"], ["wed", "W"], ["thu", "T"], ["fri", "F"], ["sat", "S"], ["sun", "S"]];
const DAY_NAMES: Record<Day, string> = { sun: "Sun", mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat" };
const CRON_DAY: Day[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

type Draft = { title: string; instruction: string; every: Every; time: string; days: Day[]; dayOfMonth: number; cron: string };

const BLANK: Draft = { title: "", instruction: "", every: "weekday", time: "09:00", days: ["mon"], dayOfMonth: 1, cron: "" };

const IDEAS: Array<{ icon: LucideIcon; draft: Draft; blurb: string }> = [
  {
    icon: Inbox,
    blurb: "Weekdays at 08:30",
    draft: { ...BLANK, title: "Morning inbox digest", every: "weekday", time: "08:30", instruction: "Read my unread email from the last 24 hours and list what needs a reply from me, most urgent first, one line each. Skip newsletters and notifications." },
  },
  {
    icon: CalendarRange,
    blurb: "Mondays at 09:00",
    draft: { ...BLANK, title: "Plan my week", every: "week", days: ["mon"], time: "09:00", instruction: "Look at my tasks due this week, anything overdue and my calendar. Propose a plan: the three things that matter most, and what to move or drop." },
  },
  {
    icon: Sunrise,
    blurb: "Weekdays at 08:00",
    draft: { ...BLANK, title: "Meeting prep", every: "weekday", time: "08:00", instruction: "For each of today's meetings, gather the related tasks, notes and recent messages, and write a three-line brief: why it matters, open questions, what I owe." },
  },
  {
    icon: Moon,
    blurb: "Fridays at 16:00",
    draft: { ...BLANK, title: "Friday board tidy", every: "week", days: ["fri"], time: "16:00", instruction: "Find tasks that look done but are not marked, tasks untouched for two weeks, and tasks with no owner. Suggest what to close, snooze or reassign." },
  },
];

/** A routine's cron back as the picker's fields; anything else stays a custom schedule. */
function draftOf(routine: Routine): Draft {
  const base: Draft = { ...BLANK, title: routine.title, instruction: routine.instruction, cron: routine.cron };
  const parts = routine.cron.trim().split(/\s+/);
  if (parts.length !== 5) return { ...base, every: "custom" };
  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];
  const pad = (value: string) => value.padStart(2, "0");
  if (!/^\d+$/.test(minute) || month !== "*") return { ...base, every: "custom" };
  if (hour === "*" && dom === "*" && dow === "*") return { ...base, every: "hour", time: `00:${pad(minute)}` };
  if (!/^\d+$/.test(hour)) return { ...base, every: "custom" };
  const time = `${pad(hour)}:${pad(minute)}`;
  if (dom === "*" && dow === "*") return { ...base, every: "day", time };
  if (dom === "*" && dow === "1-5") return { ...base, every: "weekday", time };
  if (dom === "*" && /^[0-6](,[0-6])*$/.test(dow)) return { ...base, every: "week", time, days: dow.split(",").map((day) => CRON_DAY[Number(day)]!) };
  if (/^\d+$/.test(dom) && Number(dom) <= 28 && dow === "*") return { ...base, every: "month", time, dayOfMonth: Number(dom) };
  return { ...base, every: "custom" };
}

function cadenceOf(draft: Draft): RoutineCadence {
  if (draft.every === "custom") return { cron: draft.cron.trim() };
  return { every: draft.every, time: draft.time, ...(draft.every === "week" ? { days: draft.days } : {}), ...(draft.every === "month" ? { dayOfMonth: draft.dayOfMonth } : {}) };
}

/** The schedule in words while it is being picked. */
function sayCadence(draft: Draft): string {
  switch (draft.every) {
    case "hour":
      return `Every hour at :${draft.time.slice(3, 5)}`;
    case "day":
      return `Every day at ${draft.time}`;
    case "weekday":
      return `Weekdays at ${draft.time}`;
    case "week":
      return draft.days.length ? `Every ${CRON_DAY.filter((day) => draft.days.includes(day)).map((day) => DAY_NAMES[day]).join(", ")} at ${draft.time}` : "Pick a day";
    case "month":
      return `Every month on day ${draft.dayOfMonth} at ${draft.time}`;
    case "custom":
      return draft.cron.trim() ? `Cron: ${draft.cron.trim()}` : "Five-field cron, in your time zone";
  }
}

/** "in 20 min", "today at 16:00", "tomorrow at 09:00", "Mon 10 Nov at 09:00" for a time still to come. */
function ahead(value: string | null): string {
  if (!value) return "";
  const at = new Date(value);
  const minutes = Math.round((at.getTime() - Date.now()) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `in ${minutes} min`;
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  if (at.toDateString() === today.toDateString()) return `today at ${time}`;
  if (at.toDateString() === tomorrow.toDateString()) return `tomorrow at ${time}`;
  return `${at.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} at ${time}`;
}

function openConversation(id: string) {
  window.dispatchEvent(new CustomEvent("ensemble:assistant-open-conversation", { detail: { id } }));
}

function Editor({ initial, saving, error, onSave, onCancel, saveLabel }: { initial: Draft; saving: boolean; error: string; onSave: (draft: Draft) => void; onCancel: () => void; saveLabel: string }) {
  const [draft, setDraft] = useState(initial);
  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const title = useRef<HTMLInputElement>(null);
  const instruction = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    (initial.title ? instruction.current : title.current)?.focus();
  }, [initial.title]);
  // The instruction grows with what is written.
  useEffect(() => {
    const field = instruction.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, 320)}px`;
  }, [draft.instruction]);
  const ready = Boolean(draft.title.trim() && draft.instruction.trim() && (draft.every !== "week" || draft.days.length) && (draft.every !== "custom" || draft.cron.trim()));
  return (
    <form
      className="routine-editor"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !saving) onSave(draft);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <input
        ref={title}
        value={draft.title}
        onChange={(event) => set({ title: event.target.value })}
        placeholder="Name it"
        aria-label="Routine name"
        maxLength={120}
        className="w-full bg-transparent text-[18px] font-semibold tracking-tight outline-none placeholder:text-faint"
      />
      <textarea
        ref={instruction}
        value={draft.instruction}
        onChange={(event) => set({ instruction: event.target.value })}
        placeholder="What should the assistant do each time? Write it so it stands on its own: it runs while you are away."
        aria-label="What the assistant does each time"
        rows={3}
        maxLength={4000}
        className="mt-2 w-full resize-none bg-transparent text-[14px] leading-6 text-ink outline-none placeholder:text-faint"
      />
      <div className="mt-3 flex flex-col gap-3 border-t border-line pt-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Segmented<Every>
            value={draft.every}
            onChange={(every) => set({ every, cron: every === "custom" && !draft.cron ? "0 9 * * 1-5" : draft.cron })}
            label="How often"
            options={[
              { id: "hour", label: "Hourly" },
              { id: "day", label: "Daily" },
              { id: "weekday", label: "Weekdays" },
              { id: "week", label: "Weekly" },
              { id: "month", label: "Monthly" },
              { id: "custom", label: "Custom" },
            ]}
          />
          {draft.every === "custom" ? (
            <input value={draft.cron} onChange={(event) => set({ cron: event.target.value })} aria-label="Cron schedule" placeholder="0 9 * * 1-5" spellCheck={false} className="field w-40 py-1 font-mono text-[12.5px]" />
          ) : (
            <TimeInput label={draft.every === "hour" ? "Minute past the hour" : "Time"} value={draft.time} step={draft.every === "hour" ? 5 : 15} className="w-32" onChange={(time) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time) && set({ time })} />
          )}
        </div>
        {draft.every === "week" ? (
          <div className="flex items-center gap-1" role="group" aria-label="Days of the week">
            {DAYS.map(([day, letter]) => {
              const on = draft.days.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={on}
                  aria-label={DAY_NAMES[day]}
                  title={DAY_NAMES[day]}
                  onClick={() => set({ days: on ? draft.days.filter((row) => row !== day) : [...draft.days, day] })}
                  className="routine-day"
                  data-on={on || undefined}
                >
                  {letter}
                </button>
              );
            })}
          </div>
        ) : null}
        {draft.every === "month" ? (
          <label className="flex items-center gap-2 text-[13px] text-muted">
            On day
            <input type="number" min={1} max={28} value={draft.dayOfMonth} onChange={(event) => set({ dayOfMonth: Math.min(28, Math.max(1, Number(event.target.value) || 1)) })} className="field w-16 py-1 text-[13px]" />
          </label>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-[12.5px] text-muted">
            <Repeat size={12} aria-hidden /> {sayCadence(draft)}
            <InfoTip text="Times are in your time zone (Settings › Account). Each run uses your assistant's default model, your connected apps and your write policy: a change that needs your OK waits in the routine's conversation." />
          </span>
          <span className="flex items-center gap-2">
            <button type="button" className="btn-ghost text-[13px]" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="btn-primary text-[13px]" disabled={!ready || saving}>
              {saving ? <Spinner size={12} /> : null} {saveLabel}
            </button>
          </span>
        </div>
        {error ? (
          <p role="alert" className="text-[12.5px] text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </form>
  );
}

function RoutineCard({ routine, focused, onEdit }: { routine: Routine; focused: boolean; onEdit: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const card = useRef<HTMLElement>(null);
  const [arming, setArming] = useState(false);
  useEffect(() => {
    if (focused) card.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focused]);
  useEffect(() => {
    if (!arming) return;
    const timer = window.setTimeout(() => setArming(false), 3000);
    return () => window.clearTimeout(timer);
  }, [arming]);
  const refresh = () => client.invalidateQueries({ queryKey: ["routines"] });
  const toggle = useMutation({ mutationFn: (active: boolean) => api.updateRoutine(routine.id, { status: active ? "active" : "paused" }), onSuccess: refresh, onError: (error) => toast((error as Error).message, { tone: "error" }) });
  const run = useMutation({
    mutationFn: () => api.runRoutine(routine.id),
    onSuccess: () => {
      toast(`Running “${routine.title}”. The result lands in the bell.`, { tone: "ok" });
      void refresh();
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const remove = useMutation({ mutationFn: () => api.deleteRoutine(routine.id), onSuccess: refresh, onError: (error) => toast((error as Error).message, { tone: "error" }) });
  const running = routine.lastStatus === "running" || run.isPending;
  const paused = routine.status === "paused";
  const tone = running ? "running" : paused ? "paused" : routine.lastStatus === "failed" ? "failed" : "active";
  const toneLabel = { running: "Running now", paused: "Paused", failed: "The last run did not finish", active: "On" }[tone];
  return (
    <article ref={card} className="routine-card" data-paused={paused || undefined} data-focused={focused || undefined}>
      <div className="flex min-w-0 items-start gap-3">
        <span className="routine-icon" aria-hidden>
          <Repeat size={15} />
          <span className="routine-dot" data-tone={tone} title={toneLabel} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[14.5px] font-semibold tracking-tight">{routine.title}</h3>
          <p className="mt-0.5 text-[12.5px] text-muted">
            {routine.when}
            {paused ? " · paused" : routine.nextRunAt ? ` · next ${ahead(routine.nextRunAt)}` : ""}
            <span className="sr-only"> · {toneLabel}</span>
          </p>
          <p className="mt-2 line-clamp-2 text-[13px] leading-5 text-ink/80" title={routine.instruction}>
            {routine.instruction}
          </p>
          {running ? (
            <p className="routine-result mt-2.5 flex items-center gap-2 text-[12.5px] text-muted">
              <Spinner size={11} /> Running now…
            </p>
          ) : routine.lastRunAt ? (
            <div className="routine-result mt-2.5" data-tone={routine.lastStatus ?? undefined}>
              <span className="text-[11px] font-medium uppercase tracking-wide text-faint">
                Last run · {relative(routine.lastRunAt)}
                {routine.lastStatus === "failed" ? " · did not finish" : ""}
              </span>
              {routine.lastSummary ? <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-5 text-muted">{routine.lastSummary}</p> : null}
            </div>
          ) : null}
        </div>
        <Toggle label={paused ? `Resume ${routine.title}` : `Pause ${routine.title}`} checked={!paused} disabled={toggle.isPending} onChange={(active) => toggle.mutate(active)} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1 sm:pl-11">
        <button type="button" className="btn-ghost h-7 px-2 text-[12.5px]" disabled={running} onClick={() => run.mutate()} title="Run it now, whatever its schedule">
          <Play size={12} /> Run now
        </button>
        <button type="button" className="btn-ghost h-7 px-2 text-[12.5px]" onClick={onEdit}>
          <Pencil size={12} /> Edit
        </button>
        {routine.conversationId ? (
          <button type="button" className="btn-ghost h-7 px-2 text-[12.5px]" onClick={() => openConversation(routine.conversationId!)} title="Every run of this routine, in the assistant">
            <MessageSquare size={12} /> Conversation
          </button>
        ) : null}
        <button
          type="button"
          className={cx("btn-ghost ml-auto h-7 px-2 text-[12.5px]", arming && "text-danger")}
          disabled={remove.isPending}
          onClick={() => (arming ? remove.mutate() : setArming(true))}
          aria-label={arming ? `Confirm: delete ${routine.title}` : `Delete ${routine.title}`}
          title={arming ? "Click again to delete" : "Delete"}
        >
          <Trash2 size={12} />
          {arming ? " Delete?" : null}
        </button>
      </div>
    </article>
  );
}

export function RoutinesPage() {
  const client = useQueryClient();
  const toast = useToast();
  const params = useSearchParams();
  const focus = params.get("routine");
  const data = useQuery({
    queryKey: ["routines"],
    queryFn: api.routines,
    // While a run goes on, look again now and then (the live stream says when it ends, too).
    refetchInterval: (query) => (query.state.data?.routines.some((row) => row.lastStatus === "running") ? 5000 : false),
  });
  const [composing, setComposing] = useState<Draft | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const routines = useMemo(() => data.data?.routines ?? [], [data.data]);
  const enabled = data.data?.enabled !== false;
  const refresh = () => client.invalidateQueries({ queryKey: ["routines"] });
  const create = useMutation({
    mutationFn: (draft: Draft) => api.createRoutine({ title: draft.title, instruction: draft.instruction, cadence: cadenceOf(draft) }),
    onSuccess: ({ routine }) => {
      setComposing(null);
      setError("");
      toast(`Added “${routine.title}”: ${routine.when.toLowerCase()}.`, { tone: "ok" });
      void refresh();
    },
    onError: (failure) => setError((failure as Error).message),
  });
  const update = useMutation({
    mutationFn: ({ id, draft }: { id: string; draft: Draft }) => api.updateRoutine(id, { title: draft.title, instruction: draft.instruction, cadence: cadenceOf(draft) }),
    onSuccess: () => {
      setEditing(null);
      setError("");
      void refresh();
    },
    onError: (failure) => setError((failure as Error).message),
  });
  const compose = (draft: Draft) => {
    setEditing(null);
    setError("");
    setComposing(draft);
  };
  const cancel = () => {
    setComposing(null);
    setEditing(null);
    setError("");
  };
  const unused = IDEAS.filter((idea) => !routines.some((row) => row.title.toLowerCase() === idea.draft.title.toLowerCase()));
  return (
    <div className="mx-auto max-w-[860px] px-4 pb-24 pt-8 sm:px-10">
      <PageHeader
        title="Routines"
        description="Work your assistant does on a schedule, with your apps and your settings. Each result lands in the bell."
        actions={
          enabled ? (
            <button type="button" className="btn-primary" onClick={() => compose(BLANK)} disabled={Boolean(composing)}>
              <Plus size={14} /> New routine
            </button>
          ) : null
        }
      />
      {!enabled ? (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-panel px-4 py-3 text-[13px]">
          <span className="text-muted">Routines are off: none of them run.</span>
          <Link href="/settings?tab=notifications#routines" className="text-accent hover:underline">
            Turn them on in Settings
          </Link>
        </div>
      ) : null}
      {composing ? (
        <div className="mb-5">
          <Editor key={composing.title || "blank"} initial={composing} saving={create.isPending} error={error} saveLabel="Add routine" onSave={(draft) => create.mutate(draft)} onCancel={cancel} />
        </div>
      ) : null}
      {data.isLoading ? (
        <SkeletonRows count={3} rowClassName="h-24" className="space-y-3" />
      ) : data.error ? (
        <p role="alert" className="text-[13px] text-danger">
          {(data.error as Error).message}
        </p>
      ) : (
        <>
          {routines.length ? (
            <div className="space-y-3">
              {routines.map((routine) =>
                editing === routine.id ? (
                  <Editor key={routine.id} initial={draftOf(routine)} saving={update.isPending} error={error} saveLabel="Save" onSave={(draft) => update.mutate({ id: routine.id, draft })} onCancel={cancel} />
                ) : (
                  <RoutineCard
                    key={routine.id}
                    routine={routine}
                    focused={focus === routine.id}
                    onEdit={() => {
                      setComposing(null);
                      setError("");
                      setEditing(routine.id);
                    }}
                  />
                ),
              )}
            </div>
          ) : !composing ? (
            <div className="routine-empty">
              <span className="routine-empty-mark" aria-hidden>
                <Repeat size={20} />
              </span>
              <h2 className="mt-3 text-[16px] font-semibold tracking-tight">Nothing runs on a schedule yet</h2>
              <p className="mx-auto mt-1 max-w-md text-[13px] leading-5 text-muted">Give the assistant work that comes round again: a digest of your mail each morning, a plan every Monday. Or ask it in the dock: “every weekday at 9, …”.</p>
            </div>
          ) : null}
          {enabled && unused.length ? (
            <section className="mt-8">
              <h2 className="mb-2.5 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-faint">
                <Sparkles size={12} aria-hidden /> Start from an idea
              </h2>
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {unused.map(({ icon: Icon, draft, blurb }) => (
                  <button key={draft.title} type="button" className="routine-idea" onClick={() => compose(draft)}>
                    <span className="routine-idea-icon" aria-hidden>
                      <Icon size={15} />
                    </span>
                    <span className="min-w-0 text-left">
                      <span className="block truncate text-[13.5px] font-medium">{draft.title}</span>
                      <span className="block truncate text-[12px] text-muted">{blurb}</span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
