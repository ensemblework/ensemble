"use client";
import type { ReactNode } from "react";
import { Dialog } from "../ui";
import { friendlyDateTime } from "@/lib/format";

export type SavedVersion = { id: string; title: string; createdAt: string; author?: string };
/** Shared history browser for documents and diagrams; fetch only the selected preview. */
export function VersionHistoryDialog({ open, onClose, title, versions, selected, onSelect, preview, onRestore, restoring, restoreDisabled, loading, error, onRetry }: {
  open: boolean; onClose: () => void; title: string; versions: SavedVersion[]; selected: string | null; onSelect: (id: string) => void;
  preview: ReactNode; onRestore: () => void; restoring: boolean; restoreDisabled?: boolean; loading?: boolean; error?: string | null; onRetry?: () => void;
}) {
  return <Dialog open={open} onClose={onClose} title={`${title} · Version history`} width={900}>
    <p className="mb-4 text-[13px] text-muted">Recent saved versions. Restore keeps your current work as another version.</p>
    {error ? <p role="alert" className="mb-3 text-[13px] text-danger">{error}{onRetry ? <button type="button" className="btn ml-2" onClick={onRetry}>Retry</button> : null}</p> : null}
    {loading ? <p role="status" className="text-muted">Loading versions…</p> : null}
    <div className="grid min-h-0 gap-4 md:grid-cols-[240px_minmax(0,1fr)]"><ul aria-label="Saved versions" className="max-h-40 overflow-y-auto space-y-1 md:max-h-[50dvh]">{versions.map(version => <li key={version.id}><button type="button" className={`w-full rounded-lg border p-3 text-left ${selected === version.id ? "border-accent bg-accent-soft" : "border-line hover:bg-hover"}`} aria-pressed={selected === version.id} onClick={() => onSelect(version.id)}><span className="block text-[13px] font-medium">{friendlyDateTime(version.createdAt)}</span><small className="mt-1 block text-[12px] text-muted">{version.author || version.title}</small></button></li>)}{!loading && !versions.length ? <li className="p-3 text-[13px] text-muted">No earlier versions yet. Versions appear as you keep editing.</li> : null}</ul>
      <div className="min-w-0 rounded-xl border border-line bg-bg p-4"><div className="mb-3 flex items-center justify-between gap-3"><h4 className="text-[13px] font-semibold">Preview</h4><button type="button" className="btn-primary" disabled={!selected || restoring || restoreDisabled} onClick={onRestore}>{restoring ? "Restoring…" : "Restore this version"}</button></div><div className="max-h-[42dvh] overflow-auto" aria-label="Version preview">{preview}</div></div>
    </div>
  </Dialog>;
}
