"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useQuery } from "@tanstack/react-query";
import { FileText, Paperclip, Search } from "lucide-react";
import { useState } from "react";
import type { PageMention } from "@ensemble/shared-types";
import { FILE_QUERY, filesApi, formatBytes } from "@/lib/api-files";
import { Modal } from "../settings/modal";

/** This picker reads saved Ensemble files only. Connected-app searches require a separate request. */
export function AddFileToMessage({ onInsert }: { onInsert: (mention: PageMention) => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const files = useQuery({ queryKey: FILE_QUERY.list(search.trim()), queryFn: () => filesApi.list(search.trim()), enabled: open });
  const choose = (file: { id: string; filename: string }) => {
    onInsert({ kind: "file", id: file.id, label: file.filename });
    setOpen(false);
    setSearch("");
  };
  return <>
    <button type="button" className="flex items-center gap-1 hover:text-ink" onClick={() => setOpen(true)}><Paperclip size={13} aria-hidden /> Attach file</button>
    <Modal open={open} onClose={() => setOpen(false)} title="Attach from Files" description="Choose a file already saved in Ensemble.">
      <label className="flex items-center gap-2 rounded-lg border border-line bg-raised px-3 py-2">
        <Search size={15} className="shrink-0 text-muted" aria-hidden />
        <input autoFocus type="search" aria-label="Search saved files" placeholder="Search your files…" className="min-w-0 flex-1 bg-transparent text-sm outline-none" value={search} onChange={event => setSearch(event.target.value)} />
      </label>
      <div className="mt-3 max-h-80 overflow-auto">
        {files.isLoading ? <p role="status" className="p-3 text-sm text-muted">Loading files…</p> : files.error ? <p role="alert" className="p-3 text-sm text-danger">{files.error.message}</p> : !files.data?.files.length ? <p className="p-3 text-sm text-muted">{search ? "No files match." : "No saved files yet. Upload a file in Files to attach it here."}</p> : files.data.files.map(file => <button key={file.id} type="button" className="row-tile flex w-full items-center gap-3 rounded-lg p-3 text-left" onClick={() => choose(file)}>
          <FileText size={18} className="shrink-0 text-accent" aria-hidden />
          <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{file.filename}</span><span className="text-xs text-muted">{formatBytes(file.byteSize)}</span></span><span className="text-xs text-accent">Attach</span>
        </button>)}
      </div>
    </Modal>
  </>;
}
