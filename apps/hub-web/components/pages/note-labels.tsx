"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Tag as TagIcon } from "lucide-react";
import { api, type StandalonePageRecord } from "@/lib/api";
import { LabelChips, LabelPicker, MAX_LABELS } from "../task/labels";
import { useToast } from "../toast";

/** A note's labels under its title: picked from its board's list (the Ensemble board's when it is on none). */
export function NoteLabels({ pageId, labels, editable, shared }: { pageId: string; labels: string[]; editable: boolean; shared: boolean }) {
  const client = useQueryClient();
  const toast = useToast();
  const save = useMutation({
    mutationFn: (next: string[]) => api.setPageLabels(pageId, next),
    onMutate: async (next) => {
      await client.cancelQueries({ queryKey: ["standalone-page", pageId] });
      const previous = client.getQueryData<StandalonePageRecord>(["standalone-page", pageId]);
      if (previous) client.setQueryData<StandalonePageRecord>(["standalone-page", pageId], { ...previous, labels: next });
      return { previous };
    },
    onSuccess: ({ labels: saved }) => {
      client.setQueryData<StandalonePageRecord>(["standalone-page", pageId], (old) => (old ? { ...old, labels: saved } : old));
    },
    onError: (error: Error, _next, context) => {
      if (context?.previous) client.setQueryData(["standalone-page", pageId], context.previous);
      toast(error.message, { tone: "error" });
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ["labels"] });
      // A custom board's card shows a note's labels.
      void client.invalidateQueries({ queryKey: ["boards"] });
    },
  });
  if (!labels.length && !editable) return null;
  // Opened from a share: the board's list is not shared with the page, so its names show in the colours they hash to.
  if (shared) return <div className="mt-2"><LabelChips labels={labels} max={MAX_LABELS} /></div>;
  return (
    <div className="mt-2 flex min-h-7 items-center gap-1.5 text-[13px] text-muted">
      <TagIcon size={14} strokeWidth={1.8} aria-hidden />
      <LabelPicker of={{ page: pageId }} value={labels} disabled={!editable} empty="Add labels" onChange={(next) => save.mutate(next)} />
    </div>
  );
}
