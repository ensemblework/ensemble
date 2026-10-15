"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Orbit, ArrowUpRight } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type TaskRecord } from "@/lib/api";
import { startOfDay } from "@/lib/format";
import { AssignDialog } from "../agent/assign-dialog";
import { useQuickAssign } from "../agent/use-quick-assign";
import { usePeek } from "../shell/peek";
import { useToast } from "../toast";
import { cx } from "../ui";

type Decision = "mine" | "drop" | "later";

/** The real proposal inbox on persona Today desks; previews remain fictional and inert. */
export function ProposalsWidget() {
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: api.tasks });
  const client = useQueryClient();
  const toast = useToast();
  const peek = usePeek();
  const [selected, setSelected] = useState(0);
  const [options, setOptions] = useState<string | null>(null);
  const quick = useQuickAssign(setOptions);
  const proposals = (tasks.data?.tasks ?? []).filter((task) => task.status === "proposed" && (!task.snoozedUntil || new Date(task.snoozedUntil).getTime() <= Date.now()));
  const decide = useMutation({
    mutationFn: ({ task, action }: { task: TaskRecord; action: Decision }) => {
      if (action === "mine") return api.patchTask(task.id, { owner: "me", status: "todo" });
      if (action === "drop") return api.patchTask(task.id, { status: "dropped" });
      const tomorrow = startOfDay(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9);
      return api.patchTask(task.id, { snoozedUntil: tomorrow.toISOString() });
    },
    onSuccess: (result, { action }) => {
      void client.invalidateQueries();
      toast({ mine: "On your board.", drop: "Dropped.", later: "Back tomorrow morning." }[action], { action: { label: "Undo", run: () => { void api.undo(result?.undoEntryId ?? undefined).then(() => client.invalidateQueries()).catch((error: Error) => toast(error.message, { tone: "error" })); } } });
    },
    onError: (error: Error) => toast(error.message, { tone: "error" }),
  });
  const busy = quick.isPending || decide.isPending;
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || busy || options || peek.peekId || document.querySelector("[data-modal-layer], [data-layout-editing]")) return;
      if ((event.target as HTMLElement).closest("input, textarea, select, [contenteditable=true]")) return;
      const task = proposals[Math.min(selected, proposals.length - 1)];
      if (!task) return;
      switch (event.key.toLowerCase()) {
        case "j": case "arrowdown": setSelected((index) => Math.min(index + 1, proposals.length - 1)); break;
        case "k": case "arrowup": setSelected((index) => Math.max(index - 1, 0)); break;
        case "m": decide.mutate({ task, action: "mine" }); break;
        case "a": quick.mutate(task.id); break;
        case "d": decide.mutate({ task, action: "drop" }); break;
        case "l": decide.mutate({ task, action: "later" }); break;
        case "o": case "enter": peek.open(task.id); break;
        default: return;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [proposals, selected, busy, options, peek.peekId, decide.mutate, quick.mutate, peek.open]);
  return <div className="proposal-inbox flex min-h-0 flex-1 flex-col overflow-y-auto" data-proposals-widget>
    <p className="mb-2 text-[11px] text-muted">M · me &nbsp; A · default agent &nbsp; L · later &nbsp; D · drop</p>
    {!proposals.length ? <p className="py-2 text-[12px] text-muted">No proposals waiting. Snoozed work returns tomorrow.</p> : proposals.map((task, index) => <div key={task.id} className={cx("mb-2 rounded-lg border border-transparent p-2", selected === index && "border-line bg-raised")} onMouseEnter={() => setSelected(index)} onFocus={() => setSelected(index)}>
      <button type="button" className="flex w-full items-start gap-2 text-left text-[13px] font-medium leading-5" onClick={() => peek.open(task.id)}><span className="min-w-0 flex-1">{task.title}</span><ArrowUpRight size={12} className="mt-1 shrink-0 text-faint" /></button>
      {task.rationale ? <p className="mt-1 line-clamp-2 text-[11.5px] leading-4 text-muted">{task.rationale}</p> : null}
      <div className="mt-2 flex flex-wrap gap-1">
        <button type="button" className="btn-primary px-2 py-0.5 text-[11px]" disabled={busy} onClick={() => decide.mutate({ task, action: "mine" })}>Me <kbd>M</kbd></button>
        <button type="button" className="btn px-2 py-0.5 text-[11px]" disabled={busy} title="Use the default run profile" onClick={() => quick.mutate(task.id)}><Orbit size={11} /> Agent <kbd>A</kbd></button>
        <button type="button" className="btn-ghost px-1.5 py-0.5 text-[11px]" disabled={busy} onClick={() => decide.mutate({ task, action: "later" })}>Later <kbd>L</kbd></button>
        <button type="button" className="btn-ghost px-1.5 py-0.5 text-[11px]" disabled={busy} onClick={() => decide.mutate({ task, action: "drop" })}>Drop <kbd>D</kbd></button>
      </div>
    </div>)}
    <AssignDialog open={Boolean(options)} taskId={options ?? undefined} onClose={() => setOptions(null)} />
  </div>;
}
