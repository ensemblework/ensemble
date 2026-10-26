"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useQuery } from "@tanstack/react-query";
import { Paperclip, Search } from "lucide-react";
import { useState } from "react";
import { FILE_KIND_LABEL, fileFormat, type FileRecord, type PageMention } from "@ensemble/shared-types";
import { FILE_QUERY, filesApi, formatBytes } from "@/lib/api-files";
import { whenLabel } from "@/lib/format";
import { Modal } from "../settings/modal";
import { FileIcon } from "./file-icon";

/** "PDF · 1.2 MB · 28 Sept": tells two files with the same name apart. */
export function fileDetails(file: Partial<Pick<FileRecord, "kind" | "byteSize" | "createdAt">>): string {
  return [file.kind ? FILE_KIND_LABEL[file.kind] : null, typeof file.byteSize === "number" ? formatBytes(file.byteSize) : null, file.createdAt ? whenLabel(file.createdAt) : null].filter(Boolean).join(" · ");
}

/**
 * This picker reads saved Ensemble files only. Connected-app searches require a separate request.
 * With `open` it is controlled and has no button of its own.
 */
export function AddFileToMessage({
  onInsert,
  open: controlled,
  onOpenChange,
  attached = [],
}: {
  onInsert: (mention: PageMention, file: FileRecord) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Files already on the message, marked in the list. */
  attached?: string[];
}) {
  const [own, setOwn] = useState(false);
  const open = controlled ?? own;
  const setOpen = (next: boolean) => {
    if (controlled === undefined) setOwn(next);
    onOpenChange?.(next);
  };
  const [search, setSearch] = useState("");
  const files = useQuery({ queryKey: FILE_QUERY.list(search.trim()), queryFn: () => filesApi.list(search.trim()), enabled: open });
  const choose = (file: FileRecord) => {
    onInsert({ kind: "file", id: file.id, label: file.filename }, file);
    setOpen(false);
    setSearch("");
  };
  return <>
    {controlled === undefined ? <button type="button" className="flex items-center gap-1 hover:text-ink" onClick={() => setOpen(true)}><Paperclip size={13} aria-hidden /> Attach file</button> : null}
    <Modal open={open} onClose={() => setOpen(false)} title="Attach from Files" description="Choose a file already saved in Ensemble.">
      <label className="flex items-center gap-2 rounded-lg border border-line bg-raised px-3 py-2">
        <Search size={15} className="shrink-0 text-muted" aria-hidden />
        <input autoFocus type="search" aria-label="Search saved files" placeholder="Search your files…" className="min-w-0 flex-1 bg-transparent text-sm outline-none" value={search} onChange={event => setSearch(event.target.value)} />
      </label>
      <div className="mt-3 max-h-80 overflow-auto">
        {files.isLoading ? <p role="status" className="p-3 text-sm text-muted">Loading files…</p> : files.error ? <p role="alert" className="p-3 text-sm text-danger">{files.error.message}</p> : !files.data?.files.length ? <p className="p-3 text-sm text-muted">{search ? "No files match." : "No saved files yet. Upload a file in Files to attach it here."}</p> : files.data.files.map(file => {
          const details = fileDetails(file);
          const already = attached.includes(file.id);
          return <button key={file.id} type="button" className="row-tile flex w-full items-center gap-3 rounded-lg p-3 text-left" title={file.filename} aria-label={`${file.filename}${details ? `, ${details}` : ""}${already ? ", already attached" : ""}`} onClick={() => choose(file)}>
            <FileIcon kind={file.kind ?? fileFormat(file.filename).kind} size={28} />
            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{file.filename}</span>{details ? <span className="block truncate text-xs text-muted">{details}</span> : null}</span><span className={already ? "text-xs text-muted" : "text-xs text-accent"}>{already ? "Attached" : "Attach"}</span>
          </button>;
        })}
      </div>
    </Modal>
  </>;
}
