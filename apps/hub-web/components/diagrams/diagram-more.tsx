"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { explainDiagram, toMermaid, type DiagramModel } from "@ensemble/block-diagrams";
import { useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import { useToast } from "@/components/toast";
import { api } from "@/lib/api";
import { VersionHistoryDialog } from "../history/version-history";
import { copyDiagramPng } from "./export-image";
import { prefillAssistant, refreshDiagramPrompt } from "./make-diagram";

export function DiagramMore({
  id,
  model,
  onAdopt,
}: {
  id: string;
  model: DiagramModel;
  onAdopt: (source: string, version: number) => void;
}) {
  const toast = useToast();
  const router = useRouter();
  const client = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [explain, setExplain] = useState(false);
  const [history, setHistory] = useState(false);
  const freshness = useQuery({ queryKey: ["diagram-freshness", id], queryFn: () => api.diagramFreshness(id) });
  const revisions = useQuery({ queryKey: ["diagram-revisions", id], queryFn: () => api.diagramRevisions(id), enabled: history });
  useEffect(() => { if (history && revisions.data?.revisions.length && !revisions.data.revisions.some(item => String(item.version) === selected)) setSelected(String(revisions.data.revisions[0]!.version)); }, [history, revisions.data, selected]);
  const title = model.meta.title || "Untitled diagram";

  const restore = useMutation({
    mutationFn: (version: number) => api.restoreDiagram(id, version),
    onSuccess: (result) => {
      onAdopt(result.diagram.source, result.diagram.version);
      void client.invalidateQueries({ queryKey: ["diagram-revisions", id] });
      toast("Restored that version.");
    },
    onError: (error) => toast(error instanceof Error ? error.message : "Couldn't restore that version.", { tone: "error" }),
  });
  const duplicate = useMutation({
    mutationFn: () => api.duplicateDiagram(id),
    onSuccess: (result) => router.push(`/diagrams/${result.diagram.id}`),
    onError: (error) => toast(error instanceof Error ? error.message : "Couldn't duplicate that diagram.", { tone: "error" }),
  });

  return (
    <div className="border-b border-line px-3 py-1.5">
      {freshness.data?.stale ? (
        <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
          <span>{freshness.data.reasons[0] ?? "This drawing may be out of date."}</span>
          <button type="button" className="btn-ghost" onClick={() => prefillAssistant(refreshDiagramPrompt(id, title))}>
            Refresh with AI
          </button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" className="btn-ghost" aria-expanded={explain} onClick={() => setExplain((open) => !open)}>
          Explain
        </button>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => {
            void navigator.clipboard.writeText(toMermaid(model)).then(
              () => toast("Copied Mermaid."),
              () => toast("Couldn't copy Mermaid.", { tone: "error" }),
            );
          }}
        >
          Copy Mermaid
        </button>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => {
            void copyDiagramPng(model).then(
              () => toast("Copied image."),
              () => toast("Couldn't copy the image.", { tone: "error" }),
            );
          }}
        >
          Copy image
        </button>
        <button type="button" className="btn-ghost" disabled={duplicate.isPending} onClick={() => duplicate.mutate()}>
          Duplicate
        </button>
        <button type="button" className="btn-ghost" aria-expanded={history} onClick={() => setHistory((open) => !open)}>
          History
        </button>
      </div>
      {explain ? <p className="mt-2 max-w-[68ch] whitespace-pre-wrap text-[13px] leading-5 text-muted">{explainDiagram(model)}</p> : null}
      <VersionHistoryDialog open={history} onClose={() => setHistory(false)} title="Diagram" versions={(revisions.data?.revisions ?? []).map(item => ({ ...item, id: String(item.version) }))} selected={selected} onSelect={setSelected} loading={revisions.isPending} error={revisions.error?.message ?? restore.error?.message} onRetry={() => void revisions.refetch()} restoring={restore.isPending} onRestore={() => { if (selected) restore.mutate(Number(selected)); }} preview={<p className="text-[13px] text-muted">{selected ? `Version ${selected} · ${revisions.data?.revisions.find(item => String(item.version) === selected)?.title ?? "Diagram"}` : "Choose a saved version."}</p>} />
    </div>
  );
}
