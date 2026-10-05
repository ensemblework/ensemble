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
      <div className="mb-4 flex gap-2">
        <input value={q} onChange={(event) => setQ(event.target.value)} aria-label="Search completed" placeholder="Search…" className="field w-64" />
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
          <div key={`${item.kind}-${item.id}`} className="record-row">
            <Tag tone="gray">{item.kind}</Tag>
            <span className="min-w-0 flex-1 truncate text-[14px]">{item.title}</span>
            {item.projectName ? <span className="text-[12px] text-faint">{item.projectName}</span> : null}
            <span className="text-[12px] text-faint">{relative(item.completedAt)}</span>
            <button type="button" className="btn" onClick={() => pin.mutate(item)}>
              {item.pinned ? "Unpin" : "Pin"}
            </button>
            <button type="button" className="btn" onClick={() => reopen.mutate(item)}>
              Reopen
            </button>
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
