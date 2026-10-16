"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useRef } from "react";

import { PageHeader, SectionCard, Spinner } from "@/components/ui";
import { LoadError } from "@/components/load-error";
import { useToast } from "@/components/toast";
import { api } from "@/lib/api";
import { plural, relative } from "@/lib/format";
import { confirmAction } from "@/components/ask-dialog";

type TrashItem = { kind: string; id: string; label: string; detail?: string | null; href?: string | null };

const KIND_NAME: Record<string, string> = { document: "file", meeting: "meeting notes", person: "person", repo: "repository" };

export function TrashList({ embedded = false }: { embedded?: boolean }) {
  const client = useQueryClient();
  const toast = useToast();
  const router = useRouter();
  const list = useRef<HTMLDivElement>(null);
  const deleted = useQuery({ queryKey: ["deleted"], queryFn: api.deleted });
  const restore = useMutation({
    mutationFn: (item: TrashItem | null) => api.restoreDeleted(item ? { kind: item.kind, id: item.id } : {}),
    onSuccess: (result, item) => {
      if (!item) toast(result.restored ? `Restored ${plural(result.restored, "item")}.` : "Nothing was restored.", { tone: "ok" });
      else if (!result.restored) toast(`“${item.label}” is no longer in Trash.`, { tone: "error" });
      else {
        const href = item.href;
        toast(`Restored ${KIND_NAME[item.kind] ?? item.kind} “${item.label}”.`, { tone: "ok", action: href ? { label: "Open", run: () => router.push(href) } : undefined });
      }
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

  // The restored row leaves the list: keep keyboard focus in Trash, on the next row's Restore.
  const restoreOne = (item: TrashItem, button: HTMLButtonElement) => {
    if (restore.isPending) return;
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>("button[data-restore]") ?? [])];
    const at = buttons.indexOf(button);
    const next = buttons[at + 1] ?? buttons[at - 1];
    (next ?? list.current)?.focus();
    restore.mutate(item);
  };

  const actions = (
    <>
      <button type="button" className="btn" onClick={() => restore.mutate(null)} disabled={!items.length}>
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
      {deleted.isError ? <LoadError error={deleted.error} what="Trash" retrying={deleted.isFetching} onRetry={() => void deleted.refetch()} /> : null}
      {deleted.isSuccess && items.length === 0 ? (
        <div className="empty-panel">
          <h2 className="text-[18px] font-semibold">Trash is empty</h2>
          <p className="mt-1 max-w-[42ch] text-[14px] leading-5 text-muted">Deleted notes, meetings, people, projects, and tasks wait here until the retention window. Restoring a project brings its links back.</p>
        </div>
      ) : null}
      <div ref={list} tabIndex={-1} aria-label="Items in Trash" className="flex flex-col gap-2 focus:outline-none">
        {items.map((item) => (
          <div key={`${item.kind}-${item.id}`} className="record-row items-start">
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] uppercase tracking-[0.04em] text-muted">{KIND_NAME[item.kind] ?? item.kind}</span>
              <span className="block truncate text-[15px] font-medium">{item.label}</span>
              {item.detail ? <span className="mt-0.5 block truncate text-[12.5px] text-muted">{item.detail}</span> : null}
              <span className="mt-0.5 block text-[12px] text-muted">Deleted {relative(item.deletedAt)}</span>
            </span>
            <button type="button" className="btn" data-restore aria-label={`Restore ${item.label}`} aria-disabled={restore.isPending || undefined} onClick={(event) => restoreOne(item, event.currentTarget)}>
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
