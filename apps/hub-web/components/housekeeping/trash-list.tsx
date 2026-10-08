"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AskEnsemble } from "@/components/ensemble/ask-button";
import { PageHeader, SectionCard, Spinner } from "@/components/ui";
import { useToast } from "@/components/toast";
import { api } from "@/lib/api";
import { relative } from "@/lib/format";
import { confirmAction } from "@/components/ask-dialog";

export function TrashList({ embedded = false }: { embedded?: boolean }) {
  const client = useQueryClient();
  const toast = useToast();
  const deleted = useQuery({ queryKey: ["deleted"], queryFn: api.deleted });
  const restore = useMutation({
    mutationFn: api.restoreDeleted,
    onSuccess: (result) => {
      toast(`Restored ${result.restored}.`, { tone: "ok" });
      void client.invalidateQueries();
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const empty = useMutation({
    mutationFn: api.emptyDeleted,
    onSuccess: (result) => {
      toast(`Permanently removed ${result.removed}.`);
      void client.invalidateQueries({ queryKey: ["deleted"] });
    },
  });
  const items = deleted.data?.items ?? [];
  const actions = (
    <>
      <AskEnsemble surface="trash" anchorKey="trash" label="Ask Ensemble about trash" />
      <button type="button" className="btn" onClick={() => restore.mutate({})} disabled={!items.length}>
        Restore all
      </button>
      <button
        type="button"
        className="btn"
        disabled={!items.length}
        onClick={() => void confirmAction({ title: "Empty Trash?", body: "Everything in Trash is removed for good.", confirm: "Empty Trash", danger: true }).then((yes) => yes && empty.mutate())}
      >
        Empty trash
      </button>
    </>
  );
  const body = (
    <>
      {deleted.isLoading ? <Spinner /> : null}
      {deleted.isError ? <p className="text-[13.5px] text-danger">Trash could not be loaded.</p> : null}
      {!deleted.isLoading && items.length === 0 ? (
        <div className="empty-panel">
          <h2 className="text-[18px] font-semibold">Trash is empty</h2>
          <p className="mt-1 max-w-[42ch] text-[14px] leading-5 text-muted">Deleted people, projects, and tasks wait here until the retention window. Restoring a project brings its links back.</p>
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        {items.map((item) => (
          <div key={`${item.kind}-${item.id}`} className="record-row items-start">
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] uppercase tracking-[0.04em] text-muted">{item.kind}</span>
              <span className="block truncate text-[15px] font-medium">{item.label}</span>
              <span className="mt-0.5 block text-[12px] text-muted">Deleted {relative(item.deletedAt)}</span>
            </span>
            <button type="button" className="btn" onClick={() => restore.mutate({ kind: item.kind, id: item.id })}>
              Restore
            </button>
          </div>
        ))}
      </div>
    </>
  );
  if (embedded) {
    return (
      <SectionCard title="Trash" description="Deleted work stays here until the retention window, then it is removed. Restoring a project brings its links back." actions={actions}>
        {body}
      </SectionCard>
    );
  }
  return (
    <div className="page-read mx-auto max-w-[760px] px-6 pb-24 pt-8">
      <PageHeader title="Trash" description="Deleted work stays here until the retention window, then it is removed. Restoring a project brings its links back." actions={actions} />
      {body}
    </div>
  );
}
