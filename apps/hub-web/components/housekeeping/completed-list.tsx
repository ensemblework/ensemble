"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AskEnsemble } from "@/components/ensemble/ask-button";
import { PageHeader, SectionCard, Spinner, Tag } from "@/components/ui";
import { useToast } from "@/components/toast";
import { api } from "@/lib/api";
import { relative } from "@/lib/format";

export function CompletedList({ embedded = false }: { embedded?: boolean }) {
  const client = useQueryClient();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"all" | "task" | "deliverable">("all");
  const list = useQuery({ queryKey: ["completed", q, kind], queryFn: () => api.completed({ q, kind }) });
  const reopen = useMutation({
    mutationFn: (item: { kind: string; id: string }) => (item.kind === "deliverable" ? api.reopenDeliverable(item.id) : api.reopenTask(item.id)),
    onSuccess: () => {
      toast("Reopened.", { tone: "ok" });
      void client.invalidateQueries();
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const pin = useMutation({
    mutationFn: (item: { kind: string; id: string; pinned: boolean }) =>
      item.kind === "deliverable" ? api.pinDeliverable(item.id, !item.pinned) : api.pinTask(item.id, !item.pinned),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["completed"] }),
  });
  const items = list.data?.items ?? [];
  const body = (
    <>
      <div className="mb-4 flex flex-wrap gap-2">
        <input value={q} onChange={(event) => setQ(event.target.value)} aria-label="Search completed" placeholder="Search…" className="field w-full min-w-0 sm:w-64" />
        <select aria-label="Kind" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)} className="field">
          <option value="all">Tasks and deliverables</option>
          <option value="task">Tasks</option>
          <option value="deliverable">Deliverables</option>
        </select>
      </div>
      {list.isLoading ? <Spinner /> : null}
      {list.isError ? <p className="text-[13.5px] text-danger">Completed items could not be loaded.</p> : null}
      {!list.isLoading && items.length === 0 ? <p className="text-[14px] text-muted">Nothing completed in this view.</p> : null}
      <div className="flex flex-col gap-2">
        {items.map((item) => (
          <div key={`${item.kind}-${item.id}`} className="record-row flex-col !items-stretch sm:flex-row sm:!items-center">
            <div className="min-w-0 flex-1">
              <div className="break-words text-[14px]">{item.title}</div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-faint">
                <Tag tone="gray">{item.kind}</Tag>
                {item.projectName ? <span className="break-words">{item.projectName}</span> : null}
                <span>{relative(item.completedAt)}</span>
              </div>
            </div>
            <div className="flex shrink-0 gap-2">
              <button type="button" className="btn" aria-label={`${item.pinned ? "Unpin" : "Pin"} ${item.title}`} onClick={() => pin.mutate(item)} disabled={pin.isPending}>
                {item.pinned ? "Unpin" : "Pin"}
              </button>
              <button type="button" className="btn" aria-label={`Reopen ${item.title}`} onClick={() => reopen.mutate(item)} disabled={reopen.isPending}>Reopen</button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
  if (embedded) {
    return (
      <SectionCard
        title="Completed"
        description="Everything finished, including rows the board hides after the recent few. Pinned items are kept past the purge window."
        actions={<AskEnsemble surface="completed" anchorKey="completed" label="Ask Ensemble about completed" />}
      >
        {body}
      </SectionCard>
    );
  }
  return (
    <div className="page-read mx-auto max-w-[760px] px-6 pb-24 pt-8">
      <PageHeader
        title="Completed"
        description="Everything finished, including rows the board hides after the recent few. Pinned items are kept past the purge window."
        actions={<AskEnsemble surface="completed" anchorKey="completed" label="Ask Ensemble about completed" />}
      />
      {body}
    </div>
  );
}
