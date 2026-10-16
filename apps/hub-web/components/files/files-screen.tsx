"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, LayoutGrid, List, Plug, Search, Trash2, UploadCloud, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { FILE_KIND_LABEL, fileFormat, type FileKind, type FileRecord, type FileUsage } from "@ensemble/shared-types";
import { FILE_QUERY, filesApi, formatBytes } from "@/lib/api-files";
import { FILE_ACCEPT } from "@/lib/files/formats";
import { type FilesView } from "@/lib/files/links";
import { useSpaceAccess } from "@/lib/access";
import { relative } from "@/lib/format";
import { BrandLogo, brandName } from "../connectors/brand-logo";
import { LoadError } from "../load-error";
import { Dialog, Empty, PageHeader, SkeletonRows, cx } from "../ui";
import { DeleteFileDialog } from "./delete-file";
import { FileIcon } from "./file-icon";
import { FromApps } from "./from-apps";
import { ImportFromApps } from "./import-from-apps";
import { useBlobUrl, useFileBytes } from "./use-file";
import { useFileUploads, type Duplicate, type DuplicateChoice, type UploadItem } from "./use-uploads";

const KIND_ORDER: FileKind[] = ["pdf", "document", "slides", "sheet", "image", "text", "code", "audio", "video", "other"];
const THUMB_MAX = 4 * 1024 * 1024;
const VIEW_KEY = "ensemble.files.view";

export function usageLine(usage: FileUsage): string | null {
  if (usage.maxCount === null) return null;
  const bytes = usage.maxBytes === null ? "" : ` · ${formatBytes(usage.bytes)} of ${formatBytes(usage.maxBytes)}`;
  return `${usage.count} of ${usage.maxCount} files${bytes}`;
}

/** Hosted accounts only: how much of the file allowance is used. */
export function UsageMeter({ usage }: { usage: FileUsage }) {
  const line = usageLine(usage);
  if (!line || usage.maxCount === null) return null;
  const share = Math.min(1, Math.max(usage.count / usage.maxCount, usage.maxBytes ? usage.bytes / usage.maxBytes : 0));
  const full = share >= 1;
  return (
    <div className="mb-4 max-w-md" data-testid="file-usage">
      <div className="mb-1 flex items-baseline justify-between gap-2 text-[12.5px]">
        <span className={full ? "font-medium text-warn" : "text-muted"}>{line}</span>
        {full ? <span className="text-faint">Delete a file to add another</span> : null}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-line" role="meter" aria-label="Files used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)}>
        <div className={cx("h-full rounded-full", full ? "bg-warn" : "bg-accent")} style={{ width: `${Math.round(share * 100)}%` }} />
      </div>
    </div>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

function ImageThumb({ file }: { file: FileRecord }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setSeen(true);
        observer.disconnect();
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const format = fileFormat(file.filename);
  const bytes = useFileBytes(file, seen);
  const url = useBlobUrl(bytes.data, format.mime);
  return (
    <span ref={ref} className="flex h-full w-full items-center justify-center overflow-hidden">
      {url ? <img src={url} alt="" className="h-full w-full object-cover" draggable={false} /> : <FileIcon kind="image" size={40} />}
    </span>
  );
}

function Preview({ file }: { file: FileRecord }) {
  const format = fileFormat(file.filename);
  if (format.kind === "image" && format.preview && file.byteSize <= THUMB_MAX) return <ImageThumb file={file} />;
  return <FileIcon kind={file.kind ?? format.kind} size={40} />;
}

/** A long name shortened in the middle, so the start and the extension both stay in view. The full name is the tooltip. */
export function shortFileName(filename: string, max = 56): string {
  if (filename.length <= max) return filename;
  const dot = filename.lastIndexOf(".");
  const ext = dot > 0 && filename.length - dot <= 8 ? filename.slice(dot) : "";
  const stem = filename.slice(0, filename.length - ext.length);
  const tail = Math.min(8, Math.floor(stem.length / 4));
  const head = Math.max(1, max - ext.length - tail - 1);
  return `${stem.slice(0, head)}…${stem.slice(stem.length - tail)}${ext}`;
}

const kindOf = (file: FileRecord): FileKind => file.kind ?? fileFormat(file.filename).kind;

function meta(file: FileRecord): string {
  const format = fileFormat(file.filename);
  return [format.ext ? format.label : FILE_KIND_LABEL.other, formatBytes(file.byteSize), relative(file.createdAt)].filter(Boolean).join(" · ");
}

function Source({ file }: { file: FileRecord }) {
  if (!file.source) return null;
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-[12px] text-faint" title={`From ${file.source.label}`}>
      <BrandLogo id={file.source.app} name={brandName(file.source.app, file.source.label)} size={13} decorative />
      <span className="truncate">{file.source.label}</span>
    </span>
  );
}

function RemoveFile({ file, onRemove, className }: { file: FileRecord; onRemove: () => void; className?: string }) {
  return (
    <button type="button" className={cx("icon-btn", className)} aria-label={`Delete ${file.filename}`} title="Delete" onClick={onRemove}>
      <Trash2 size={14} />
    </button>
  );
}

function FileCard({ file, onRemove }: { file: FileRecord; onRemove?: () => void }) {
  return (
    <li className="group relative">
      <Link href={`/files/${file.id}`} prefetch={false} className="tile flex h-full flex-col overflow-hidden rounded-xl bg-panel" data-file-row={file.id}>
        <span className="flex h-28 items-center justify-center border-b border-line bg-raised">
          <Preview file={file} />
        </span>
        <span className="min-w-0 space-y-0.5 px-3 py-2.5">
          <span className="line-clamp-2 text-[13.5px] font-medium leading-5 text-ink [overflow-wrap:anywhere]" title={file.filename}>
            {shortFileName(file.filename)}
          </span>
          <span className="block truncate text-[12px] text-muted">{meta(file)}</span>
          <Source file={file} />
        </span>
      </Link>
      {onRemove ? (
        <RemoveFile
          file={file}
          onRemove={onRemove}
          className="absolute right-1.5 top-1.5 border-line bg-panel shadow-sm [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:focus-visible:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100 [@media(hover:hover)]:group-hover:opacity-100"
        />
      ) : null}
    </li>
  );
}

function FileLine({ file, onRemove }: { file: FileRecord; onRemove?: () => void }) {
  return (
    <li className="flex items-center gap-1">
      <Link href={`/files/${file.id}`} prefetch={false} className="row-tile flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-2" data-file-row={file.id}>
        <FileIcon kind={file.kind ?? fileFormat(file.filename).kind} size={30} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-medium text-ink" title={file.filename}>{shortFileName(file.filename, 96)}</span>
          <span className="block truncate text-[12px] text-muted">{meta(file)}</span>
        </span>
        <Source file={file} />
      </Link>
      {onRemove ? <RemoveFile file={file} onRemove={onRemove} /> : null}
    </li>
  );
}

export function Uploads({ items, onDismiss }: { items: UploadItem[]; onDismiss: (key: string) => void }) {
  if (!items.length) return null;
  return (
    <ul className="mb-4 space-y-1.5 rounded-xl border border-line bg-panel p-3 text-[12.5px]" aria-label="Uploads" data-testid="file-uploads">
      {items.map((item) => (
        <li key={item.key} className="flex items-center gap-3" data-upload-state={item.state}>
          <span className="w-[40%] min-w-0 truncate text-ink" title={item.name}>
            {item.name}
          </span>
          {item.state === "failed" ? (
            <span className="min-w-0 flex-1 truncate text-danger" title={item.error}>
              {item.error}
            </span>
          ) : item.state === "done" ? (
            <span className="flex flex-1 items-center gap-1 text-muted">
              <CheckCircle2 size={13} className="text-ok" aria-hidden /> Uploaded
            </span>
          ) : (
            <span className="flex flex-1 items-center gap-2">
              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-line" role="progressbar" aria-label={`Uploading ${item.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(item.progress * 100)}>
                <span className={cx("block h-full rounded-full bg-accent transition-[width]", item.state === "waiting" && "opacity-40")} style={{ width: `${Math.max(4, Math.round(item.progress * 100))}%` }} />
              </span>
              <span className="w-14 text-right tabular-nums text-muted">{item.state === "waiting" ? "…" : item.progress >= 1 ? "Saving…" : `${Math.round(item.progress * 100)}%`}</span>
            </span>
          )}
          <span className="w-16 text-right text-faint">{formatBytes(item.size)}</span>
          {item.state === "done" || item.state === "failed" ? (
            <button type="button" className="icon-btn" aria-label={`Dismiss ${item.name}`} onClick={() => onDismiss(item.key)}>
              <X size={13} />
            </button>
          ) : (
            <span className="w-7" />
          )}
        </li>
      ))}
    </ul>
  );
}

/** Files picked again that are already in Files: skip them, keep both, or put the new version in the old one's place. */
export function DuplicateDialog({ duplicates, onChoose }: { duplicates: Duplicate[] | null; onChoose: (choice: DuplicateChoice | "cancel") => void }) {
  const rows = duplicates ?? [];
  const versions = rows.filter((row) => row.same === "name").length;
  const title = rows.length === 1 ? `You already have ${shortFileName(rows[0]!.match.filename, 40)}` : `${rows.length} of these are already in Files`;
  return (
    <Dialog open={duplicates !== null} onClose={() => onChoose("cancel")} title={title} width={480}>
      <div className="space-y-3 text-[13px] leading-5" data-testid="file-duplicates">
        <ul className="max-h-48 space-y-1.5 overflow-y-auto">
          {rows.map((row, index) => (
            <li key={`${row.file.name}-${index}`} data-duplicate={row.same}>
              <span className="font-medium [overflow-wrap:anywhere]">{row.file.name}</span>{" "}
              <span className="text-muted">
                {row.same === "content"
                  ? row.match.filename === row.file.name
                    ? `is already in Files, uploaded ${relative(row.match.createdAt)}.`
                    : `is the same file as ${row.match.filename}.`
                  : `has the name of a file uploaded ${relative(row.match.createdAt)}, with different content.`}
              </span>
            </li>
          ))}
        </ul>
        {versions ? <p className="text-[12px] text-muted">Replace puts the new version in the old file&rsquo;s place, so pages it is attached to show the new one. A file that is an exact copy is skipped.</p> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={() => onChoose("keep")}>
            Keep both
          </button>
          {versions ? (
            <button type="button" className="btn" onClick={() => onChoose("replace")}>
              Replace
            </button>
          ) : null}
          <button type="button" className="btn-primary" onClick={() => onChoose("skip")}>
            Skip {rows.length === 1 ? "it" : "them"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** Drag files anywhere on the screen to upload them. */
function useDropAnywhere(onFiles: (files: File[]) => void): boolean {
  const [over, setOver] = useState(false);
  const handler = useRef(onFiles);
  handler.current = onFiles;
  useEffect(() => {
    let depth = 0;
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth += 1;
      setOver(true);
    };
    const overHandler = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const leave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setOver(false);
    };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setOver(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length) handler.current(files);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", overHandler);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", overHandler);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, []);
  return over;
}

/** The library shows only files people uploaded or explicitly imported. */
export function FilesScreen({ view = "files", item = null, navigate = () => undefined }: { view?: FilesView; item?: string | null; navigate?: (href: string) => void }) {
  return (
    <div className="mx-auto max-w-[1080px] px-4 pb-24 pt-8 sm:px-10" data-testid="files-screen">
      {view === "apps" ? <><PageHeader title="Connected items" description="Items opened explicitly from a connected app or an assistant link." /><FromApps item={item} onItem={(id) => navigate(`/files?view=apps${id ? `&item=${encodeURIComponent(id)}` : ""}`)} onOpenFile={(id) => navigate(`/files/${encodeURIComponent(id)}`)} /></> : <YourFiles />}
    </div>
  );
}

function YourFiles() {
  const { canEdit } = useSpaceAccess();
  const [removing, setRemoving] = useState<FileRecord | null>(null);
  const [text, setText] = useState("");
  const q = useDebounced(text.trim(), 250);
  const list = useQuery({ queryKey: FILE_QUERY.list(q), queryFn: () => filesApi.list(q), placeholderData: keepPreviousData });
  // The empty search holds the account's usage, which uploads check before sending, and every kind of file kept.
  const everything = useQuery({ queryKey: FILE_QUERY.list(""), queryFn: () => filesApi.list(""), enabled: Boolean(q) });
  const [kind, setKind] = useState<FileKind | "all">("all");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [importing, setImporting] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const uploads = useFileUploads();
  const dropping = useDropAnywhere(uploads.start);

  useEffect(() => {
    try {
      if (localStorage.getItem(VIEW_KEY) === "list") setView("list");
    } catch {
      // Storage can be off; the grid is the default.
    }
  }, []);
  const chooseView = (next: "grid" | "list") => {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // Not remembered this time.
    }
  };

  const files = list.data?.files ?? [];
  const usage = list.data?.usage;
  // The kind buttons come from every file, so a search keeps them and the kind chosen.
  const kept = (q ? everything.data?.files : list.data?.files) ?? files;
  const kinds = KIND_ORDER.filter((value) => kept.some((file) => kindOf(file) === value));
  const shown = kind === "all" ? files : files.filter((file) => kindOf(file) === kind);
  const settled = q ? everything.isSuccess && !everything.isPlaceholderData : list.isSuccess && !list.isPlaceholderData;
  useEffect(() => {
    if (kind !== "all" && settled && !kinds.includes(kind)) setKind("all");
  }, [kind, kinds, settled]);
  // Retries go on quietly; the error and Retry show from the first failure instead of a skeleton.
  const failure = list.data ? null : (list.error ?? list.failureReason);
  const client = useQueryClient();
  // refetch() waits for a retry that is sleeping out its delay; cancel it so Retry asks now.
  const retry = () => void client.cancelQueries({ queryKey: FILE_QUERY.list(q), exact: true }).then(() => list.refetch());

  return (
    <>
      <PageHeader
        title="Files"
        description="PDFs, Word and Excel files, slides, pictures and more. Preview them here, edit spreadsheets, turn documents into pages, and attach files to any page."
        actions={
          <>
            <button type="button" className="btn" onClick={() => setImporting(true)}>
              <Plug size={13} aria-hidden /> Add from your apps
            </button>
            <button type="button" className="btn-primary" onClick={() => input.current?.click()}>
              <UploadCloud size={13} aria-hidden /> Upload
            </button>
            <input
              ref={input}
              type="file"
              multiple
              accept={FILE_ACCEPT}
              className="sr-only"
              aria-label="Upload files"
              tabIndex={-1}
              onChange={(event) => {
                uploads.start(Array.from(event.target.files ?? []));
                event.target.value = "";
              }}
            />
          </>
        }
      />
      <div id="files-panel" role="tabpanel" aria-label="Your files">
        {usage ? <UsageMeter usage={usage} /> : null}
        <Uploads items={uploads.items} onDismiss={uploads.dismiss} />

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <label className="flex h-9 min-w-0 flex-[1_1_16rem] items-center gap-2 rounded-lg border border-line bg-panel px-2.5 focus-within:border-accent">
            <Search size={14} className="shrink-0 text-muted" aria-hidden />
            <input
              type="search"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Search files by name"
              aria-label="Search files"
              className="search-line min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-faint"
            />
          </label>
          <div className="inline-flex rounded-lg bg-raised p-0.5" role="radiogroup" aria-label="Show files as">
            {(
              [
                ["grid", LayoutGrid, "Grid"],
                ["list", List, "List"],
              ] as const
            ).map(([id, Icon, label]) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={view === id}
                aria-label={label}
                title={label}
                onClick={() => chooseView(id)}
                className={cx("rounded-md px-2 py-1", view === id ? "bg-panel text-ink shadow-sm" : "text-muted hover:text-ink")}
              >
                <Icon size={14} />
              </button>
            ))}
          </div>
        </div>
        {kinds.length > 1 ? (
          <div className="mb-4 flex flex-wrap gap-1.5" role="group" aria-label="Kind of file">
            {(["all", ...kinds] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={kind === value}
                onClick={() => setKind(value)}
                className={cx(
                  "rounded-full border px-2.5 py-1 text-[12.5px]",
                  kind === value ? "border-accent bg-accent-soft font-medium text-ink" : "border-line text-muted hover:text-ink",
                )}
              >
                {value === "all" ? "All" : FILE_KIND_LABEL[value]}
              </button>
            ))}
          </div>
        ) : null}

        {failure ? (
          <LoadError error={failure} what="your files" onRetry={retry} />
        ) : list.isPending ? (
          <SkeletonRows count={4} rowClassName="h-14" />
        ) : !files.length ? (
          q ? (
            <p className="text-[13.5px] text-muted">No files match “{q}”.</p>
          ) : (
            <Empty title="No files yet">Upload a file, drop files anywhere on this screen, or add them from your apps.</Empty>
          )
        ) : !shown.length ? (
          <p className="text-[13.5px] text-muted" data-testid="files-no-kind">
            No {kind === "all" ? "" : `${kind === "pdf" ? "PDF" : kind === "other" ? "other" : FILE_KIND_LABEL[kind].toLowerCase()} `}files{q ? ` match “${q}”` : " here"}.{" "}
            <button type="button" className="text-accent hover:underline" onClick={() => setKind("all")}>
              Show all kinds
            </button>
          </p>
        ) : view === "grid" ? (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" aria-label="Files">
            {shown.map((file) => (
              <FileCard key={file.id} file={file} onRemove={canEdit ? () => setRemoving(file) : undefined} />
            ))}
          </ul>
        ) : (
          <ul className="space-y-0.5" aria-label="Files">
            {shown.map((file) => (
              <FileLine key={file.id} file={file} onRemove={canEdit ? () => setRemoving(file) : undefined} />
            ))}
          </ul>
        )}

        {dropping ? (
          <div className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-6" data-testid="file-drop-overlay">
            <div className="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-accent bg-panel px-10 py-8 text-center shadow-pop">
              <UploadCloud size={28} className="text-accent" aria-hidden />
              <p className="text-[15px] font-medium">Drop to upload to Files</p>
              {usage?.maxCount !== null && usage ? <p className="text-[12.5px] text-muted">Up to {formatBytes(usage.maxFileBytes)} each</p> : null}
            </div>
          </div>
        ) : null}
      </div>
      <ImportFromApps open={importing} onClose={() => setImporting(false)} />
      <DeleteFileDialog file={removing} onClose={() => setRemoving(null)} />
      <DuplicateDialog duplicates={uploads.review?.duplicates ?? null} onChoose={uploads.resolve} />
    </>
  );
}
