"use client";

import Link from "next/link";
import { useState } from "react";
import { ApiError } from "@/lib/api";
import { importsApi, type ImportJobRecord } from "@/lib/api-imports";

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

export function summaryTitle(job: ImportJobRecord): string {
  if (job.status === "done") return `Imported from ${job.sourceLabel}`;
  if (job.status === "failed") return "The import stopped";
  if (job.status === "cancelled") return "Import cancelled";
  if (job.status === "interrupted") return "The import was interrupted";
  if (job.status === "undone") return "Import undone";
  return `Importing from ${job.sourceLabel}…`;
}

/** "12 tasks added, 3 updated · 2 pages added · 1 project added". */
export function countsLine(job: ImportJobRecord): string {
  const parts: string[] = [];
  const tasks = job.counts.tasks;
  if (tasks && tasks.created + tasks.updated + tasks.unchanged) {
    const bits = [`${plural(tasks.created, "task")} added`];
    if (tasks.updated) bits.push(`${tasks.updated.toLocaleString()} updated`);
    if (tasks.unchanged) bits.push(`${tasks.unchanged.toLocaleString()} unchanged`);
    parts.push(bits.join(", "));
  }
  const pages = job.counts.pages;
  if (pages && pages.created + pages.updated + pages.unchanged + pages.keptEdits) {
    const bits = [`${plural(pages.created, "page")} added`];
    if (pages.updated) bits.push(`${pages.updated.toLocaleString()} updated`);
    if (pages.keptEdits) bits.push(`${pages.keptEdits.toLocaleString()} kept with your edits`);
    parts.push(bits.join(", "));
  }
  const projects = job.counts.projects;
  if (projects?.created) parts.push(`${plural(projects.created, "project")} added`);
  return parts.join(" · ") || "Nothing new came over.";
}

/** Links that open what an import brought. */
export function ImportLinks({ job, onNavigate }: { job: ImportJobRecord; onNavigate?: () => void }) {
  if (job.status === "undone") return null;
  const links: Array<{ href: string; label: string }> = [{ href: "/board", label: "Open the board" }];
  for (const project of job.links.projects.slice(0, 4)) links.push({ href: `/projects/${project.id}`, label: project.name });
  for (const label of job.links.labels.slice(0, 4)) links.push({ href: `/board?q=${encodeURIComponent(`#${label}`)}`, label: `#${label}` });
  if (job.links.pages.length) {
    links.push({ href: `/pages/${job.links.pages[0]}`, label: job.progress.created.pages > 1 ? `Imported pages (${job.progress.created.pages})` : "Imported page" });
  }
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Open what came over">
      {links.map((link) => (
        <li key={link.href}>
          <Link href={link.href} className="btn min-h-7 px-2 text-[12.5px]" onClick={onNavigate}>
            {link.label}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Counts, links and "Undo this import" with a confirmation. */
export function ImportSummary({ job, onChange, onNavigate }: { job: ImportJobRecord; onChange: (job: ImportJobRecord) => void; onNavigate?: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const created = job.progress.created;
  const undo = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await importsApi.undo(job.id);
      setConfirming(false);
      onChange(result.job);
    } catch (caught) {
      setError(caught instanceof ApiError || caught instanceof Error ? caught.message : "Could not undo. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3 text-[13px]">
      {job.status === "undone" && job.progress.undone ? (
        <p role="status">
          Removed {plural(job.progress.undone.tasks, "task")}, {plural(job.progress.undone.pages, "page")} and {plural(job.progress.undone.projects, "project")} this import added.
          Items it only updated were left as they are.
        </p>
      ) : (
        <p role="status">{countsLine(job)}</p>
      )}
      {job.error ? <p className="text-danger">{job.error}</p> : null}
      {job.progress.note ? <p className="text-muted">{job.progress.note}</p> : null}
      <ImportLinks job={job} onNavigate={onNavigate} />
      {job.canUndo && created.tasks + created.pages + created.projects > 0 ? (
        confirming ? (
          <div className="card space-y-2 p-3" role="group" aria-label="Confirm undo">
            <p>
              This removes the {plural(created.tasks, "task")}, {plural(created.pages, "page")} and {plural(created.projects, "project")} this import added. Items it only
              updated stay as they are.
            </p>
            <div className="flex gap-2">
              <button type="button" className="btn-primary" disabled={busy} onClick={() => void undo()}>
                Undo import
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => setConfirming(false)}>
                Keep it
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn" onClick={() => setConfirming(true)}>
            Undo this import
          </button>
        )
      ) : null}
      {error ? (
        <p role="alert" className="text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
