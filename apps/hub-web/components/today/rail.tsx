"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { usePeek } from "@/components/shell/peek";
import { api, type DeliverableRecord } from "@/lib/api";
import { clockLabel, isoDate, shortDate } from "@/lib/format";
import { useTodayData } from "@/lib/home";
import { useToast } from "../toast";
import { AskEnsemble } from "../ensemble/ask-button";
import { Dialog, Field, InfoTip, SkeletonRows, cx } from "../ui";
import type { Size } from "@ensemble/shared-types/widgets";

export function DeliverablesRail({ highlightId, size = "l" }: { highlightId?: string | null; size?: Size }) {
  const client = useQueryClient();
  const toast = useToast();
  const peek = usePeek();
  const [showCompleted, setShowCompleted] = useState(false);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState("");
  const [due, setDue] = useState("");
  const { ready } = useTodayData();
  const deliverables = useQuery({
    queryKey: ["deliverables", showCompleted],
    queryFn: () => api.deliverables(showCompleted),
    enabled: showCompleted || ready || client.getQueryData(["deliverables", false]) !== undefined,
  });
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects, enabled: creating });

  const toggle = useMutation({
    mutationFn: (input: { id: string; done: boolean }) =>
      api.patchDeliverable(input.id, { status: input.done ? "completed" : "upcoming" }),
    onMutate: async (input) => {
      await client.cancelQueries({ queryKey: ["deliverables", showCompleted] });
      const previous = client.getQueryData<{ deliverables: DeliverableRecord[] }>(["deliverables", showCompleted]);
      if (previous) {
        client.setQueryData(["deliverables", showCompleted], {
          deliverables: previous.deliverables.map((row) =>
            row.id === input.id ? { ...row, status: input.done ? "completed" : "upcoming" } : row,
          ),
        });
      }
      return { previous };
    },
    onError: (error, _vars, context) => {
      if (context?.previous) client.setQueryData(["deliverables", showCompleted], context.previous);
      toast((error as Error).message, { tone: "error" });
    },
    onSettled: () => client.invalidateQueries({ queryKey: ["deliverables"] }),
  });
  const create = useMutation({
    mutationFn: () => api.createDeliverable({ title, projectId, due: due ? new Date(due).toISOString() : null }),
    onSuccess: () => {
      setCreating(false);
      setTitle("");
      setDue("");
      void client.invalidateQueries({ queryKey: ["deliverables"] });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });

  useEffect(() => {
    if (!highlightId || !deliverables.data) return;
    document.getElementById(`deliverable-${highlightId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlightId, deliverables.data]);

  const cap = size === "s" ? 3 : size === "m" ? 5 : 8;
  const rows = deliverables.data?.deliverables ?? [];
  const shown = rows.slice(0, cap);
  const more = rows.length - shown.length;

  return (
    <section id="deliverables" className="min-w-0">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        {size === "s" ? null : <span className="text-[13px] text-muted">{rows.length ? `${rows.length} open` : "None open"}</span>}
        <button type="button" className="btn shrink-0 px-2 py-0.5" aria-label="New deliverable" onClick={() => setCreating(true)}>
          <Plus size={13} />
          {size === "s" ? null : "New"}
        </button>
      </div>
      {size === "s" ? null : (
      <label className="mb-2 flex items-center gap-2 text-[12.5px] text-muted">
        <input
          type="checkbox"
          checked={showCompleted}
          onChange={(event) => setShowCompleted(event.target.checked)}
          className="accent-[rgb(var(--accent-rgb))]"
        />
        Show completed
      </label>
      )}
      <div className="relative min-w-0">
        {!deliverables.data ? (
          <SkeletonRows count={2} rowClassName="h-10" />
        ) : rows.length === 0 ? (
          <div className="text-[12.5px] text-muted">No deliverables yet.</div>
        ) : (
          <>
            <div className="absolute bottom-3 left-[11px] top-3 w-px bg-[var(--line-strong)]" aria-hidden />
            {shown.map((row) => {
              const done = row.status === "completed";
              const active = highlightId === row.id;
              return (
                <div key={row.id} id={`deliverable-${row.id}`} className={cx("relative flex gap-2 rounded-md pb-3 pr-1", active && "bg-accent-soft ring-1 ring-accent")}>
                  <button
                    type="button"
                    aria-pressed={done}
                    aria-label={done ? `Mark upcoming: ${row.title}` : `Mark completed: ${row.title}`}
                    onClick={() => toggle.mutate({ id: row.id, done: !done })}
                    className="group/check relative z-[1] mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center"
                  >
                    <span
                      className={cx(
                        "flex h-4 w-4 items-center justify-center rounded-full border bg-panel text-accent transition-colors",
                        done ? "border-accent bg-accent text-[var(--accent-fg)]" : "border-line-strong group-hover/check:border-accent",
                      )}
                    >
                      <Check size={11} strokeWidth={2.5} className={cx(done ? "opacity-100" : "opacity-0 group-hover/check:opacity-100")} />
                    </span>
                  </button>
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      className={cx("block w-full truncate text-left text-[13.5px] font-medium leading-5 hover:underline", done && "text-muted line-through")}
                      onClick={() => peek.open(row.id, "deliverable")}
                    >
                      {row.title}
                    </button>
                    <div className="text-[12px] text-muted">
                      {row.project.name}
                      {row.due ? ` · ${shortDate(row.due)}` : ""}
                    </div>
                  </div>
                  {size === "s" ? null : (
                  <AskEnsemble
                    surface="deliverable"
                    anchorKey={`deliverable:${row.id}`}
                    label={`Ask Ensemble about ${row.title}`}
                    entityIds={[row.id]}
                    contextLabel={row.title}
                  />
                  )}
                </div>
              );
            })}
            {more > 0 ? <div className="pl-8 text-[12px] text-muted">{more} more</div> : null}
          </>
        )}
      </div>
      <Dialog open={creating} onClose={() => setCreating(false)} title="New deliverable">
        <div className="space-y-3">
          <Field label="What will exist when it is done?">
            <input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} className="field w-full" />
          </Field>
          <Field label="Project">
            <select value={projectId} onChange={(event) => setProjectId(event.target.value)} className="field w-full">
              <option value="">Choose a project…</option>
              {(projects.data?.projects ?? []).map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Due (optional)">
            <input type="date" value={due} onChange={(event) => setDue(event.target.value)} className="field [color-scheme:dark]" />
          </Field>
          <div className="flex justify-end">
            <button type="button" className="btn-primary" disabled={!title || !projectId} onClick={() => create.mutate()}>
              Add deliverable
            </button>
          </div>
        </div>
      </Dialog>
    </section>
  );
}

export function RemindersRail({ timezone, size = "l" }: { timezone: string; size?: Size }) {
  const client = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(isoDate(new Date()));
  const [time, setTime] = useState("");
  const reminders = useQuery({
    queryKey: ["reminders"],
    queryFn: api.reminders,
  });
  const create = useMutation({
    mutationFn: () => api.createReminder({ title, dueDate: date, dueTime: time || null, timeZone: timezone }),
    onSuccess: () => {
      setAdding(false);
      setTitle("");
      void client.invalidateQueries({ queryKey: ["reminders"] });
    },
  });
  const dismiss = useMutation({
    mutationFn: api.dismissReminder,
    onSuccess: () => client.invalidateQueries({ queryKey: ["reminders"] }),
  });
  const cap = size === "s" ? 3 : size === "m" ? 5 : 10;
  const rows = reminders.data?.reminders ?? [];
  const shown = rows.slice(0, cap);
  const more = rows.length - shown.length;
  return (
    <section className="min-w-0">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted">
          {size === "s" ? (more > 0 ? `${more} more` : rows.length ? `${rows.length} set` : "None set") : "Private to you"}
          {size === "s" ? null : <InfoTip text="Private to you. Reminders never become graph nodes or retrieval context." />}
        </span>
        <button type="button" className="btn shrink-0 px-2 py-0.5" aria-label="Add reminder" onClick={() => setAdding(true)}>
          <Plus size={13} />
          {size === "s" ? null : "Add"}
        </button>
      </div>
      {adding ? (
        <div className="tile mb-2 space-y-2 rounded-md bg-panel p-2">
          <input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Remind me to…"
            aria-label="Reminder"
            className="field w-full min-w-0"
          />
          <div className="flex min-w-0 flex-col gap-2">
            <input type="date" value={date} onChange={(event) => setDate(event.target.value)} className="field min-w-0 [color-scheme:dark]" />
            <input type="time" value={time} onChange={(event) => setTime(event.target.value)} className="field min-w-0 [color-scheme:dark]" />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button type="button" className="btn-primary" disabled={!title} onClick={() => create.mutate()}>
              Save
            </button>
          </div>
        </div>
      ) : null}
      {rows.length === 0 ? (
        <div className="text-[12.5px] text-muted" suppressHydrationWarning>
          {reminders.data ? "No active reminders." : " "}
        </div>
      ) : (
        <div className="space-y-1">
          {shown.map((row) => (
            <div key={row.id} className="row-tile group flex min-w-0 items-center justify-between gap-2 rounded-md px-1 py-1 text-[13px]">
              <div className="min-w-0">
                <div className="truncate">{row.title}</div>
                <div className="truncate text-[11.5px] text-muted">
                  {shortDate(row.dueDate)}
                  {row.dueTime ? ` · ${clockLabel(row.dueTime)}` : ""}
                </div>
              </div>
              <button
                type="button"
                className="icon-btn h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100"
                title="Dismiss"
                aria-label={`Dismiss ${row.title}`}
                onClick={() => dismiss.mutate(row.id)}
              >
                <X size={13} />
              </button>
            </div>
          ))}
          {size !== "s" && more > 0 ? <div className="shrink-0 px-1 text-[12px] text-muted">{more} more</div> : null}
        </div>
      )}
      {size === "s" ? null : <div className="mt-1 text-[11px] text-faint">{timezone}</div>}
    </section>
  );
}
