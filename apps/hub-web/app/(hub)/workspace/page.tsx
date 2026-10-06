"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pause, Play, Settings2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { AssignDialog } from "@/components/agent/assign-dialog";
import { JobCard } from "@/components/agent/job-card";
import { useToast } from "@/components/toast";
import { Held } from "@/components/motion/held";
import { PageHeader, QueryError, SkeletonRows, cx } from "@/components/ui";
import { ApiError, api, type AgentJob } from "@/lib/api";

function Lane({ title, hint, items, empty, wide }: { title: string; hint?: string; items: AgentJob[]; empty: string; wide?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-baseline gap-2">
        <span className="text-[13px] font-semibold">{title}</span>
        <span className="text-[12px] text-muted">{items.length}</span>
        {hint ? <span className="truncate text-[12px] text-faint">{hint}</span> : null}
      </div>
      <div className="space-y-2">{items.length ? items.map((job) => <JobCard key={job.id} job={job} wide={wide} />) : <div className="rounded-md border border-dashed border-line px-3 py-4 text-[12.5px] text-muted">{empty}</div>}</div>
    </div>
  );
}

export default function WorkspacePage() {
  const client = useQueryClient();
  const toast = useToast();
  const board = useQuery({
    queryKey: ["workspace"], queryFn: api.workspace,
    refetchInterval: (query) => query.state.error instanceof ApiError && query.state.error.status === 403 ? false : 5000,
  });
  const [assigning, setAssigning] = useState(false);
  const data = board.data;
  const toggle = useMutation({
    mutationFn: () => (data?.paused ? api.resumeAgent() : api.pauseAgent()),
    onSuccess: () => {
      toast(data?.paused ? "Resumed. Queued work starts again." : "Paused. Everything running was stopped.");
      void client.invalidateQueries();
    },
    onError: (error) => toast(error.message, { tone: "error" }),
  });
  return (
    <div className="mx-auto max-w-[1240px] px-10 pb-24 pt-8">
      <PageHeader
        title="Workspace"
        description={
          <>
            The agent&apos;s queue. Up to {data?.maxConcurrent ?? 3} tasks run at once; the rest wait here in order. Tasks on the same folder, and steps that continue an earlier task, wait their turn.
            {data?.root ? <div className="mt-1 font-mono text-[12px] text-faint">{data.root}</div> : null}
          </>
        }
        actions={
          <>
            <Link href="/settings#orchestration" className="icon-btn" title="How many run at once, limits">
              <Settings2 size={15} />
            </Link>
            <button type="button" className={cx("btn", data?.paused && "border-warn text-warn")} onClick={() => toggle.mutate()} disabled={!data || toggle.isPending}>
              {data?.paused ? <Play size={13} /> : <Pause size={13} />} {data?.paused ? "Resume" : "Pause all"}
            </button>
            <button type="button" className="btn-primary" onClick={() => setAssigning(true)}>
              Assign task
            </button>
          </>
        }
      />
      {data?.paused ? (
        <div className="mb-5 rounded-md border border-warn/40 bg-[var(--tag-yellow-bg)] px-3 py-2 text-[13px] text-[var(--tag-yellow-fg)]">
          The agent is paused. Nothing new starts and no model is called until you resume. Queued tasks keep their place.
        </div>
      ) : null}
      {board.error ? (
        <QueryError error={board.error} retry={() => void board.refetch()}>
          {board.error instanceof ApiError && board.error.status === 403 ? <Link href="/settings#devices" className="text-accent underline">Set up a paired computer</Link> : null}
        </QueryError>
      ) : <Held pending={board.isLoading || !data} fallback={<SkeletonRows count={4} />}>
        {data ? (
        <>
          <div className="grid grid-cols-3 gap-6">
            <Lane title="Up next" hint={data.queued.length ? "in the order they start" : undefined} items={data.queued} empty="Nothing queued. Assign a task to the agent." />
            <Lane title="Working now" hint={`${data.running.length}/${data.maxConcurrent} slots`} items={data.running} empty="Nothing is running." />
            <Lane title="Needs you" hint={data.waiting.length ? "not using a slot" : undefined} items={data.waiting} empty="The agent is not waiting on you." />
          </div>
          <div className="mt-10 grid grid-cols-2 gap-6">
            <Lane title="Recently done" items={data.completed} empty="Nothing finished in the last 14 days." wide />
            <Lane title="Stopped or failed" hint="no model calls; open to retry or take over" items={data.stopped} empty="Nothing stopped." wide />
          </div>
        </>
        ) : null}
      </Held>}
      <AssignDialog open={assigning} onClose={() => setAssigning(false)} />
    </div>
  );
}
