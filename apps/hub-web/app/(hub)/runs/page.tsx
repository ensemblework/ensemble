"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Clock3, Cpu, Trash2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { usePeek } from "@/components/shell/peek";
import { Held } from "@/components/motion/held";
import { RunsSkeleton } from "@/components/motion/skeletons";
import { Empty, PageHeader, Spinner, Tag, cx } from "@/components/ui";
import { api, type RunSummary } from "@/lib/api";
import { credits, dateTime, plural, shortDate } from "@/lib/format";

const OUTCOME: Record<string, { label: string; tone: "green" | "red" | "yellow" | "gray" | "orange" }> = {
  success: { label: "Done", tone: "green" },
  failed: { label: "Failed", tone: "red" },
  cancelled: { label: "Cancelled", tone: "gray" },
  needs_info: { label: "Needs info", tone: "orange" },
  waiting_approval: { label: "Waiting for you", tone: "yellow" },
};

function RunDetail({ id }: { id: string }) {
  const run = useQuery({ queryKey: ["run", id], queryFn: () => api.run(id) });
  if (run.isLoading) return <Spinner />;
  if (!run.data) return null;
  const detail = run.data.run;
  return (
    <div className="mt-2 space-y-2 border-l border-line pb-2 pl-4">
      {detail.error ? <div className="text-[13px] text-[#ffb4ae]">{detail.error}</div> : null}
      {detail.steps.length === 0 ? <div className="text-[12.5px] text-muted">No steps recorded.</div> : null}
      {detail.steps.map((step) => (
        <div key={step.id} className="text-[13px]">
          <div className="flex items-center gap-2">
            <span className="w-5 text-right text-faint">{step.index + 1}</span>
            <span className="font-medium">{step.title}</span>
            <Tag tone={step.status === "done" ? "green" : step.status === "failed" ? "red" : step.status === "needs_approval" ? "yellow" : "gray"}>
              {step.status.replace("_", " ")}
            </Tag>
            {step.model ? <span className="text-[12px] text-faint">{step.model}</span> : null}
          </div>
          {step.output || step.error ? (
            <pre className="ml-7 mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded border border-line bg-raised p-2 text-[12px] leading-5 text-muted">
              {step.error ?? step.output}
            </pre>
          ) : null}
        </div>
      ))}
      {detail.result ? (
        <div className="mt-2">
          <div className="text-[12.5px] font-semibold">Result</div>
          <div className="mt-1 whitespace-pre-wrap text-[13.5px] leading-6">{detail.result}</div>
        </div>
      ) : null}
    </div>
  );
}

function RunRow({ run, open, onToggle }: { run: RunSummary; open: boolean; onToggle: () => void }) {
  const peek = usePeek();
  const client = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.deleteRun(run.id),
    onSuccess: () => client.invalidateQueries({ queryKey: ["runs"] }),
  });
  const outcome = run.outcome ? OUTCOME[run.outcome] : { label: "Running", tone: "yellow" as const };
  return (
    <div className="border-b border-line">
      <div className="row-tile group flex items-center gap-3 rounded-md px-2 py-2.5" onClick={onToggle} role="button">
        <ChevronRight size={14} className={cx("shrink-0 text-faint transition-transform", open && "rotate-90")} />
        <div className="min-w-0 flex-1">
          <button
            type="button"
            className="truncate text-left text-[14.5px] font-semibold hover:underline"
            onClick={(event) => {
              event.stopPropagation();
              peek.open(run.taskId);
            }}
          >
            {run.title}
          </button>
          <div className="mt-0.5 flex items-center gap-2 text-[12.5px] text-muted">
            <Clock3 size={12} /> {shortDate(run.startedAt)}
            <span>·</span>
            <Cpu size={12} /> {run.model ?? "model unknown"}
            <span>·</span>
            {credits(run.credits)} (est.)
            <span>·</span>
            {plural(run.stepCount, "step")}
          </div>
        </div>
        <Tag tone={outcome.tone}>{outcome.label}</Tag>
        <button
          type="button"
          className="icon-btn opacity-0 group-hover:opacity-100"
          title="Delete run"
          onClick={(event) => {
            event.stopPropagation();
            remove.mutate();
          }}
        >
          <Trash2 size={13} />
        </button>
      </div>
      {open ? <RunDetail id={run.id} /> : null}
    </div>
  );
}

export default function RunsPage() {
  const params = useSearchParams();
  const router = useRouter();
  const [all, setAll] = useState(false);
  const runs = useQuery({ queryKey: ["runs", all], queryFn: () => api.runs(all ? 200 : 10) });
  const openId = params.get("run");
  const toggle = (id: string) => router.replace(openId === id ? "/runs" : `/runs?run=${id}`, { scroll: false });
  return (
    <div className="mx-auto max-w-[900px] px-4 pb-24 pt-8 sm:px-10">
      <PageHeader title="Recent runs" description="Every delegated task leaves a trace: its plan, each step, the model it used and what it cost." />
      <Held pending={runs.isLoading} fallback={<RunsSkeleton />}>
        {(runs.data?.runs ?? []).length === 0 ? (
        <Empty>No runs yet. Hand a task to the agent from its page or from Today.</Empty>
      ) : (
        <>
          {runs.data!.runs.map((run) => (
            <RunRow key={run.id} run={run} open={openId === run.id} onToggle={() => toggle(run.id)} />
          ))}
          <div className="mt-4 text-[13px]">
            {runs.data!.total > runs.data!.runs.length ? (
              <button type="button" className="text-accent underline-offset-2 hover:underline" onClick={() => setAll(true)}>
                Show all runs ({runs.data!.total})
              </button>
            ) : (
              <span className="text-muted">That is every run. Hover a run to delete it.</span>
            )}
          </div>
        </>
        )}
      </Held>
      <div className="mt-6 text-[12px] text-faint">Times are shown in your browser&apos;s zone · last refreshed {dateTime(new Date())}</div>
    </div>
  );
}
