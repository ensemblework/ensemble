"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { VersionHistoryDialog } from "../history/version-history";
import { MarkdownText } from "../markdown-text";

export function PageHistory({ kind, id, open, onClose }: { kind: "page" | "task"; id: string; open: boolean; onClose: () => void }) {
  const client = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const list = useQuery({ queryKey: ["page-versions", kind, id], queryFn: () => api.pageVersions(kind, id), enabled: open });
  useEffect(() => { if (open && list.data?.versions.length && !list.data.versions.some(row => row.id === selected)) setSelected(list.data.versions[0]!.id); }, [open, list.data, selected]);
  const preview = useQuery({ queryKey: ["page-version", selected], queryFn: () => api.pageVersion(selected!), enabled: open && Boolean(selected) });
  const restore = useMutation({ mutationFn: () => api.restorePageVersion(selected!, list.data!.revision, list.data!.updatedAt!), onSuccess: async () => { window.dispatchEvent(new CustomEvent("ensemble:page", { detail: { action: "restore", ...(kind === "page" ? { id } : { taskId: id }) } })); await client.invalidateQueries(); onClose(); } });
  return <VersionHistoryDialog open={open} onClose={onClose} title="Page" versions={list.data?.versions ?? []} selected={selected} onSelect={setSelected} loading={list.isPending} restoring={restore.isPending} restoreDisabled={preview.isPending || Boolean(preview.error || list.error)} error={restore.error?.message ?? list.error?.message ?? preview.error?.message} onRetry={() => { void list.refetch(); if (selected) void preview.refetch(); }} onRestore={() => restore.mutate()} preview={preview.data ? <div className="prose-page"><h2 className="mb-4 text-[24px] font-semibold">{preview.data.version.title}</h2><MarkdownText text={preview.data.version.markdown} /></div> : <p className="text-[13px] text-muted">{selected ? "Loading preview…" : "Choose a version to preview it."}</p>} />;
}
