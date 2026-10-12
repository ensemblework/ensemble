"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useQuery } from "@tanstack/react-query";
import { CheckSquare, FileText, Link2, Search } from "lucide-react";
import { useMemo, useState } from "react";
import type { FileRecord } from "@ensemble/shared-types";
import { api } from "@/lib/api";
import { attachFileToPage, type PageTarget } from "@/lib/files/attach";
import { relative } from "@/lib/format";
import { emitToast } from "@/lib/toast-bus";
import { Dialog, SkeletonRows, Spinner } from "../ui";

const LIMIT = 30;
const CLOSED = new Set(["done", "dropped"]);

function matches(title: string, needle: string): boolean {
  return !needle || title.toLowerCase().includes(needle);
}

/** Pick a page or a task's page; the file is added at the end of it. */
export function AttachToPage({ file, open, onClose, onOpen }: { file: FileRecord; open: boolean; onClose: () => void; onOpen: (href: string) => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Attach to a page" width={560}>
      {open ? <AttachBody file={file} onClose={onClose} onOpen={onOpen} /> : null}
    </Dialog>
  );
}

function AttachBody({ file, onClose, onOpen }: { file: FileRecord; onClose: () => void; onOpen: (href: string) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pages = useQuery({ queryKey: ["pages"], queryFn: api.pages, staleTime: 30_000 });
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: api.tasks, staleTime: 30_000 });
  const needle = text.trim().toLowerCase();

  const targets = useMemo(() => {
    const standalone: Array<PageTarget & { detail: string; href: string }> = (pages.data?.pages ?? [])
      .filter((page) => matches(page.title || "Untitled", needle))
      .slice(0, LIMIT)
      .map((page) => ({ kind: "page", id: page.id, title: page.title || "Untitled", detail: `Page · edited ${relative(page.updatedAt)}`, href: `/pages/${page.id}` }));
    const taskPages: Array<PageTarget & { detail: string; href: string }> = (tasks.data?.tasks ?? [])
      .filter((task) => matches(task.title, needle))
      .sort((a, b) => Number(CLOSED.has(a.status)) - Number(CLOSED.has(b.status)) || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, LIMIT)
      .map((task) => ({ kind: "task", id: task.id, title: task.title, detail: `Task page${CLOSED.has(task.status) ? " · closed" : ""}`, href: `/tasks/${task.id}` }));
    return { standalone, taskPages };
  }, [pages.data, tasks.data, needle]);

  const attach = async (target: PageTarget & { href: string }) => {
    setBusy(`${target.kind}:${target.id}`);
    setError(null);
    try {
      const result = await attachFileToPage(target, file);
      onClose();
      emitToast(result === "already" ? `${file.filename} is already on “${target.title}”.` : `Attached ${file.filename} to “${target.title}”.`, {
        tone: "ok",
        action: { label: "Open", run: () => onOpen(target.href) },
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not attach the file.");
    } finally {
      setBusy(null);
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/files/${file.id}`);
      emitToast("Link copied.", { tone: "ok" });
    } catch {
      emitToast("Could not copy the link. Copy it from the address bar instead.", { tone: "error" });
    }
  };

  const loading = pages.isPending || tasks.isPending;
  const none = !loading && !targets.standalone.length && !targets.taskPages.length;
  const group = (title: string, rows: Array<PageTarget & { detail: string; href: string }>, Icon: typeof FileText) =>
    rows.length ? (
      <section aria-label={title}>
        <h4 className="mb-1 mt-3 text-[11.5px] font-semibold uppercase tracking-[0.08em] text-faint">{title}</h4>
        <ul className="space-y-0.5">
          {rows.map((row) => (
            <li key={`${row.kind}:${row.id}`}>
              <button
                type="button"
                className="row-tile flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left disabled:opacity-50"
                disabled={Boolean(busy)}
                onClick={() => void attach(row)}
                data-attach-target={`${row.kind}:${row.id}`}
              >
                <Icon size={14} className="shrink-0 text-muted" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] text-ink">{row.title}</span>
                  <span className="block truncate text-[12px] text-muted">{row.detail}</span>
                </span>
                {busy === `${row.kind}:${row.id}` ? <Spinner size={12} /> : null}
              </button>
            </li>
          ))}
        </ul>
      </section>
    ) : null;

  return (
    <div className="text-[13px]">
      <label className="flex h-9 items-center gap-2 rounded-lg border border-line bg-panel px-2.5 focus-within:border-accent">
        <Search size={14} className="shrink-0 text-muted" aria-hidden />
        <input
          autoFocus
          type="search"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Search pages and tasks"
          aria-label="Search pages and tasks"
          className="min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-faint"
        />
      </label>
      <div className="mt-1 max-h-[min(52dvh,420px)] overflow-y-auto">
        {loading ? (
          <SkeletonRows count={4} rowClassName="h-10" className="mt-3 space-y-2" />
        ) : none ? (
          <p className="mt-3 text-muted">{needle ? `No pages or tasks match “${text.trim()}”.` : "You have no pages or tasks yet."}</p>
        ) : (
          <>
            {group("Pages", targets.standalone, FileText)}
            {group("Task pages", targets.taskPages, CheckSquare)}
          </>
        )}
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-[12.5px] text-danger">
          {error}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3 text-[12.5px] text-muted">
        <span>Or type @ and the file name on any page.</span>
        <button type="button" className="btn-ghost" onClick={() => void copyLink()}>
          <Link2 size={13} aria-hidden /> Copy link
        </button>
      </div>
    </div>
  );
}
