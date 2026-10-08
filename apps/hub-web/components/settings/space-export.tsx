"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Archive, BookOpen, CheckSquare, FileText, LineChart, Mic, Network, Shapes, type LucideIcon } from "lucide-react";

import { api } from "@/lib/api";
import { hasModule, type OptionalModule } from "@ensemble/shared-types/modules";
import type { ExportProgress, SpaceSection } from "@/lib/export/space";
import { saveBlob } from "@/lib/export/formats";
import { useSpacePeople } from "@/lib/space-people";
import { Dialog, SectionCard, cx } from "../ui";
import { useToast } from "../toast";

const SECTIONS: Array<{ id: SpaceSection; label: string; detail: string; icon: LucideIcon; feature?: OptionalModule }> = [
  { id: "pages", label: "Pages", detail: "Every page as Markdown", icon: FileText },
  { id: "tasks", label: "Tasks", detail: "Each task with its page, plus tasks.csv", icon: CheckSquare },
  { id: "context", label: "Context", detail: "People, projects, repos, deliverables", icon: Network },
  { id: "meetings", label: "Meeting notes", detail: "Yours and imported ones, as Markdown", icon: Mic },
  { id: "skills", label: "Skills", detail: "Each skill as Markdown", icon: BookOpen, feature: "skills" },
  { id: "diagrams", label: "Diagrams", detail: "PNG and SVG, plus the source", icon: Shapes, feature: "diagrams" },
  { id: "plots", label: "Plots", detail: "Settings and data as CSV", icon: LineChart, feature: "plots" },
];

/** Settings › Data: download the open space as one ZIP. Built in the browser; the server only answers reads. */
export function SpaceExportSection() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <SectionCard
        title="Download this space"
        description="Pick what to include and get one ZIP of Markdown, CSV and images. It is put together on this computer and opens in Notion, Obsidian, Excel or any editor."
        actions={
          <button type="button" className="btn h-8 gap-1.5 px-3 text-[13px]" onClick={() => setOpen(true)}>
            <Archive size={14} /> Download…
          </button>
        }
      />
      {open ? <SpaceExportDialog open={open} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export function SpaceExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000 });
  const space = useSpacePeople();
  const available = SECTIONS.filter((section) => !section.feature || hasModule(shell.data?.modules, section.feature));
  const [picked, setPicked] = useState<Set<SpaceSection>>(() => new Set(available.map((section) => section.id)));
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const cancelled = useRef(false);
  useEffect(() => {
    if (open) cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, [open]);

  const allOn = available.every((section) => picked.has(section.id));
  const toggle = (id: SpaceSection) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const spaceName = shell.data?.space?.name ?? "ensemble-space";

  const start = async () => {
    setBusy(true);
    try {
      const { exportSpace } = await import("@/lib/export/space");
      const result = await exportSpace({
        spaceName,
        people: { ownerId: space.ownerId, names: new Map(space.people.map((person) => [person.id, person.name])) },
        sections: available.filter((section) => picked.has(section.id)).map((section) => section.id),
        onProgress: (value) => {
          if (!cancelled.current) setProgress(value);
        },
      });
      if (cancelled.current) return;
      saveBlob(result.blob, result.name);
      toast(result.skipped.length ? `Downloaded. ${result.skipped.length} item${result.skipped.length === 1 ? "" : "s"} could not be read; the README lists them.` : "Downloaded.", { tone: "ok" });
      onClose();
    } catch (error) {
      toast(error instanceof Error ? `Download failed: ${error.message}` : "Download failed", { tone: "error" });
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const percent = progress ? (progress.total ? Math.round((progress.done / progress.total) * 100) : 0) : 0;

  return (
    <Dialog open={open} onClose={busy ? () => undefined : onClose} title="Download this space" width={520}>
      <p className="-mt-1 mb-3 text-[13px] leading-5 text-muted">
        Everything in <span className="text-ink">{spaceName}</span> you pick below, as one ZIP. Settings, keys and connected apps are never included.
      </p>
      <label className="mb-1.5 flex cursor-pointer items-center gap-2 px-1 text-[12.5px] text-muted">
        <input
          type="checkbox"
          checked={allOn}
          disabled={busy}
          onChange={() => setPicked(allOn ? new Set() : new Set(available.map((section) => section.id)))}
          className="accent-[rgb(var(--accent-rgb))]"
        />
        Select all
      </label>
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {available.map((section) => {
          const on = picked.has(section.id);
          const Icon = section.icon;
          const active = busy && progress?.section === section.id;
          return (
            <label
              key={section.id}
              className={cx(
                "flex cursor-pointer items-start gap-2.5 rounded-md border px-2.5 py-2 transition-colors",
                on ? "border-line-strong bg-hover" : "border-line hover:bg-hover/60",
                busy && "pointer-events-none",
              )}
            >
              <input type="checkbox" checked={on} disabled={busy} onChange={() => toggle(section.id)} className="mt-0.5 accent-[rgb(var(--accent-rgb))]" />
              <Icon size={15} className={cx("mt-0.5 shrink-0", on ? "text-ink" : "text-faint")} />
              <span className="min-w-0">
                <span className="block text-[13px] font-medium">{section.label}</span>
                <span className="block text-[12px] leading-4 text-muted">{active ? `${progress?.label} ${progress?.done}/${progress?.total}` : section.detail}</span>
              </span>
            </label>
          );
        })}
      </div>
      {busy ? (
        <div className="mt-4" aria-live="polite">
          <div className="h-1 overflow-hidden rounded-full bg-hover">
            <div className="h-full rounded-full bg-[rgb(var(--accent-rgb))] transition-[width] duration-300" style={{ width: `${progress?.section === "zip" ? 100 : Math.max(4, percent)}%` }} />
          </div>
          <div className="mt-1.5 text-[12px] text-muted">{progress?.label ?? "Starting"}…</div>
        </div>
      ) : null}
      <div className="mt-4 flex items-center justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn-primary" disabled={busy || picked.size === 0} onClick={() => void start()}>
          {busy ? "Preparing…" : "Download ZIP"}
        </button>
      </div>
    </Dialog>
  );
}
