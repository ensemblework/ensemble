"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { explainDiagram, type DiagramModel } from "@ensemble/block-diagrams";
import { BookOpen, CopyPlus, History, MoreHorizontal, RefreshCw, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import { useToast } from "@/components/toast";
import { api } from "@/lib/api";
import { Dialog, Popover } from "../ui";
import { VersionHistoryDialog } from "../history/version-history";
import { prefillAssistant, refreshDiagramPrompt } from "./make-diagram";
import { ToolButton } from "./toolbar";

function MenuRow({ icon: Icon, label, disabled, onClick }: { icon: LucideIcon; label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" disabled={disabled} onClick={onClick} className="dg-pop-item">
      <Icon size={15} aria-hidden className="dg-pop-icon" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

/** A thin notice under the top bar when the work this diagram was drawn from changed since. */
export function DiagramFreshness({ id, title }: { id: string; title: string }) {
  const freshness = useQuery({ queryKey: ["diagram-freshness", id], queryFn: () => api.diagramFreshness(id) });
  if (!freshness.data?.stale) return null;
  return (
    <div className="dg-notice" role="status">
      <RefreshCw size={14} aria-hidden className="shrink-0 text-accent" />
      <span className="min-w-0 flex-1 truncate">{freshness.data.reasons[0] ?? "This drawing may be out of date."}</span>
      <button type="button" className="btn-ghost h-7 shrink-0 px-2 text-[12.5px]" onClick={() => prefillAssistant(refreshDiagramPrompt(id, title))}>
        Refresh with AI
      </button>
    </div>
  );
}

/** The quieter actions in the editor's top bar: explain, duplicate, version history. */
export function DiagramMoreMenu({
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
  const revisions = useQuery({ queryKey: ["diagram-revisions", id], queryFn: () => api.diagramRevisions(id), enabled: history });
  useEffect(() => { if (history && revisions.data?.revisions.length && !revisions.data.revisions.some(item => String(item.version) === selected)) setSelected(String(revisions.data.revisions[0]!.version)); }, [history, revisions.data, selected]);

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
    <>
      <Popover
        align="right"
        width={216}
        trigger={(open, toggle) => (
          <ToolButton label="More actions" tipAlign="end" aria-haspopup="menu" aria-expanded={open} active={open} onClick={toggle}>
            <MoreHorizontal size={17} aria-hidden />
          </ToolButton>
        )}
      >
        {(close) => (
          <div role="menu" aria-label="More actions" className="dg-pop-menu">
            <MenuRow icon={BookOpen} label="Explain this diagram" onClick={() => { close(); setExplain(true); }} />
            <MenuRow icon={CopyPlus} label={duplicate.isPending ? "Duplicating…" : "Duplicate"} disabled={duplicate.isPending} onClick={() => { close(); duplicate.mutate(); }} />
            <MenuRow icon={History} label="Version history" onClick={() => { close(); setHistory(true); }} />
          </div>
        )}
      </Popover>
      <Dialog open={explain} onClose={() => setExplain(false)} title="About this diagram" width={560}>
        <p className="max-w-[68ch] whitespace-pre-wrap text-[13.5px] leading-6 text-muted">{explainDiagram(model)}</p>
      </Dialog>
      <VersionHistoryDialog open={history} onClose={() => setHistory(false)} title="Diagram" versions={(revisions.data?.revisions ?? []).map(item => ({ ...item, id: String(item.version) }))} selected={selected} onSelect={setSelected} loading={revisions.isPending} error={revisions.error?.message ?? restore.error?.message} onRetry={() => void revisions.refetch()} restoring={restore.isPending} onRestore={() => { if (selected) restore.mutate(Number(selected)); }} preview={<p className="text-[13px] text-muted">{selected ? `Version ${selected} · ${revisions.data?.revisions.find(item => String(item.version) === selected)?.title ?? "Diagram"}` : "Choose a saved version."}</p>} />
    </>
  );
}
