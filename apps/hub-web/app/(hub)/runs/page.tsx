"use client";
import Link from "next/link";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ModelLogo } from "@/components/connectors/provider-logo";
import { Clock3, PanelRightOpen, SquareArrowOutUpRight, Trash2, Wrench } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { usePeek } from "@/components/shell/peek";
import { Held } from "@/components/motion/held";
import { RunsSkeleton } from "@/components/motion/skeletons";
import { RUN_OUTCOME, RunPreview, RunWhere } from "@/components/runs/run-preview";
import { Empty, PageHeader, Tag } from "@/components/ui";
import { api, type RunSummary } from "@/lib/api";
import { credits, dateTime, plural, shortDate } from "@/lib/format";
import { duration, usd } from "@/lib/run-trace";

const LIVE_JOB = new Set(["queued", "claimed", "running", "stopping", "waiting_approval"]);

function RunRow({ run, onOpen }: { run: RunSummary; onOpen: () => void }) {
  const peek = usePeek();
  const client = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.deleteRun(run.id),
    onSuccess: () => client.invalidateQueries({ queryKey: ["runs"] }),
  });
  const outcome = run.outcome
    ? RUN_OUTCOME[run.outcome] ?? { label: run.outcome, tone: "gray" as const }
    : run.jobStatus && !LIVE_JOB.has(run.jobStatus)
      ? { label: "Ended", tone: "gray" as const }
      : { label: "Running", tone: "blue" as const };
  const took = run.endedAt ? duration(Date.parse(run.endedAt) - Date.parse(run.startedAt)) : "";
  const cost = run.costUsd != null ? usd(run.costUsd) : run.credits ? `${credits(run.credits)} (est.)` : "";
  return (
    <div className="border-b border-line">
      <div
        className="row-tile group grid cursor-pointer grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 rounded-md px-2 py-2.5 sm:flex"
        onClick={onOpen}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpen();
          }
        }}
        role="button"
        tabIndex={0}
        aria-label={`Preview the run of ${run.title}`}
      >
        <PanelRightOpen size={14} className="hidden shrink-0 text-faint sm:block" />
        <div className="col-span-3 min-w-0 flex-1 [overflow-wrap:anywhere]">
          <div className="text-[14.5px] font-semibold sm:truncate">{run.title}</div>
          {run.sourceRunId && <Link href={`/runs?run=${run.sourceRunId}`} onClick={event=>event.stopPropagation()} className="mt-1 block text-[12px] text-accent hover:underline">From feedback on an earlier run</Link>}
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px] text-muted">
            <span className="inline-flex items-center gap-1">
              <Clock3 size={12} /> {shortDate(run.startedAt)}
              {took ? ` · ${took}` : ""}
            </span>
            {run.engineName ? (
              <>
                <span>·</span>
                <span>{run.engineName}</span>
              </>
            ) : null}
            <span>·</span>
            <span className="inline-flex items-center gap-1">
              <ModelLogo model={run.model} /> {run.model ?? "model unknown"}
            </span>
            {run.where ? (
              <>
                <span>·</span>
                <RunWhere where={run.where} deviceName={run.deviceName} />
              </>
            ) : null}
            <span>·</span>
            <span className="inline-flex items-center gap-1">
              <Wrench size={12} /> {run.toolCalls != null ? plural(run.toolCalls, "tool call") : plural(run.stepCount, "step")}
            </span>
            {cost ? (
              <>
                <span>·</span>
                <span>{cost}</span>
              </>
            ) : null}
          </div>
        </div>
        <Tag tone={outcome.tone} className="justify-self-start">{outcome.label}</Tag>
        <button
          type="button"
          className="btn-ghost shrink-0 gap-1 px-1.5 py-0.5 text-[12px] text-muted opacity-70 hover:text-ink group-hover:opacity-100"
          title="Open the task"
          onClick={(event) => {
            event.stopPropagation();
            peek.open(run.taskId);
          }}
        >
          <SquareArrowOutUpRight size={12} /> Open task
        </button>
        <button
          type="button"
          className="icon-btn sm:opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          title="Delete run"
          aria-label="Delete run"
          onClick={(event) => {
            event.stopPropagation();
            remove.mutate();
          }}
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}

export default function RunsPage() {
  const params = useSearchParams();
  const router = useRouter();
  const [all, setAll] = useState(false);
  const runs = useQuery({
    queryKey: ["runs", all],
    queryFn: () => api.runs(all ? 200 : 10),
    refetchInterval: (query) => (query.state.data?.runs.some((run) => !run.endedAt && (!run.jobStatus || LIVE_JOB.has(run.jobStatus))) ? 5000 : false),
  });
  const openId = params.get("run");
  const open = (id: string) => router.replace(`/runs?run=${id}`, { scroll: false });
  const close = () => router.replace("/runs", { scroll: false });
  return (
    <div className="mx-auto max-w-[900px] px-4 pb-24 pt-8 sm:px-10">
      <PageHeader title="Recent runs" />
      <Held pending={runs.isLoading} fallback={<RunsSkeleton />}>
        {(runs.data?.runs ?? []).length === 0 ? (
          <Empty>No runs yet. Hand a task to the agent from its page or from Today.</Empty>
        ) : (
          <>
            {runs.data!.runs.map((run) => (
              <RunRow key={run.id} run={run} onOpen={() => open(run.id)} />
            ))}
            <div className="mt-4 text-[13px]">
              {runs.data!.total > runs.data!.runs.length ? (
                <button type="button" className="text-accent underline-offset-2 hover:underline" onClick={() => setAll(true)}>
                  Show all runs ({runs.data!.total})
                </button>
              ) : (
                <span className="text-muted">That is every run.</span>
              )}
            </div>
          </>
        )}
      </Held>
      {openId ? <RunPreview key={openId} runId={openId} onClose={close} /> : null}
    </div>
  );
}
