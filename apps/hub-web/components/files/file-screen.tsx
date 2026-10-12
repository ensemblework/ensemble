"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, FilePlus2, Info, Maximize2, Minimize2, Paperclip, Presentation, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { fileFormat, type FileRecord } from "@ensemble/shared-types";
import { ApiError } from "@/lib/api";
import { FILE_QUERY, filesApi, formatBytes } from "@/lib/api-files";
import { pageWay, viewerFor, type ViewerKind } from "@/lib/files/formats";
import { relative } from "@/lib/format";
import { useFullscreen } from "@/lib/fullscreen";
import { BrandLogo, brandName } from "../connectors/brand-logo";
import { useToast } from "../toast";
import { Spinner, cx } from "../ui";
import { AttachToPage } from "./attach-to-page";
import { FileIcon } from "./file-icon";
import { FilePreview } from "./file-preview";
import { DeleteFileDialog } from "./delete-file";
import { useFileRecord } from "./use-file";
import { DownloadButton, PresentContext, type PresentControl } from "./viewers/shared";

/** Previews that can fill the screen as they are. PDFs and slides present instead; audio has nothing to fill it with. */
const FULL_SCREEN = new Set<ViewerKind>(["docx", "sheet", "image", "video", "text"]);

function countLabel(file: FileRecord): string | null {
  if (file.pageCount === null) return null;
  const n = file.pageCount;
  if (file.kind === "pdf" || file.kind === "document") return `${n} ${n === 1 ? "page" : "pages"}`;
  if (file.kind === "slides") return `${n} ${n === 1 ? "slide" : "slides"}`;
  if (file.kind === "sheet") return `${n} ${n === 1 ? "sheet" : "sheets"}`;
  return null;
}

/** One file: what it is, the actions its format allows, and the preview. */
export function FileScreen({ id }: { id: string }) {
  const router = useRouter();
  const client = useQueryClient();
  const toast = useToast();
  const record = useFileRecord(id);
  const [converting, setConverting] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const screen = useFullscreen();
  const [canPresent, setCanPresent] = useState(false);
  const present = useMemo<PresentControl>(
    () => ({ active: screen.active, layer: screen.layer, exit: screen.exit, toggleNative: screen.toggleNative, setReady: setCanPresent }),
    [screen.active, screen.layer, screen.exit, screen.toggleNative],
  );
  const file = record.data?.file;

  if (record.error) {
    const missing = record.error instanceof ApiError && (record.error.status === 404 || record.error.status === 410);
    return (
      <div className="mx-auto max-w-[720px] px-4 pt-16 text-center sm:px-10">
        <p className="text-[15px] font-medium">{missing ? "This file is not here anymore." : record.error.message}</p>
        <p className="mt-1 text-[13px] text-muted">{missing ? "It may have been deleted." : "Try again in a moment."}</p>
        <Link href="/files" className="btn mt-4 inline-flex">
          Back to Files
        </Link>
      </div>
    );
  }
  if (!file) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const format = fileFormat(file.filename);
  const way = pageWay(format);
  const keepsFormatting = format.ext === "pdf" || format.ext === "docx";
  const viewer = viewerFor(format);
  const show = viewer === "pdf" || viewer === "pptx" ? "present" : FULL_SCREEN.has(viewer) ? "full" : null;
  const full = show === "full" && screen.active;

  const convert = async () => {
    setConverting("Getting ready…");
    try {
      const { convertToPage } = await import("@/lib/files/convert");
      const result = await convertToPage(
        file,
        () => client.fetchQuery({ queryKey: FILE_QUERY.original(file.id, file.sha256), queryFn: () => filesApi.original(file.id), staleTime: Number.POSITIVE_INFINITY }),
        setConverting,
      );
      void client.invalidateQueries({ queryKey: ["pages"] });
      void client.invalidateQueries({ queryKey: FILE_QUERY.one(file.id) });
      router.push(`/pages/${result.pageId}`);
      toast(result.notice, { tone: "ok", durationMs: 3500 });
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not make a page from this file.", { tone: "error" });
    } finally {
      setConverting(null);
    }
  };

  const facts = [format.ext ? format.label : "File", formatBytes(file.byteSize), countLabel(file), `Added ${relative(file.createdAt)}`].filter(Boolean).join(" · ");

  return (
    <div className="flex h-full min-h-0 flex-col" data-file-screen={file.id}>
      <header className="shrink-0 border-b border-line px-4 pb-3 pt-4 sm:px-6">
        <Link href="/files" className="inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-ink">
          <ArrowLeft size={13} aria-hidden /> Files
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-[1_1_20rem] items-start gap-3">
            <FileIcon kind={file.kind ?? format.kind} size={38} />
            <div className="min-w-0">
              <h1 className="truncate text-[20px] font-semibold leading-7" title={file.filename}>
                {file.filename}
              </h1>
              <p className="flex flex-wrap items-center gap-x-2 text-[12.5px] text-muted">
                <span>{facts}</span>
                {file.source ? (
                  <span className="inline-flex items-center gap-1">
                    ·
                    <BrandLogo id={file.source.app} name={brandName(file.source.app, file.source.label)} size={13} decorative />
                    {file.source.url ? (
                      <a href={file.source.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 hover:text-ink hover:underline">
                        From {file.source.label} <ExternalLink size={11} aria-hidden />
                      </a>
                    ) : (
                      <span>From {file.source.label}</span>
                    )}
                  </span>
                ) : null}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {show === "present" ? (
              <button
                type="button"
                className="btn"
                disabled={!canPresent}
                onClick={(event) => screen.enter(event.currentTarget)}
                title={`One ${viewer === "pptx" ? "slide" : "page"} at a time on the whole screen. Arrow keys move, Esc stops.`}
              >
                <Presentation size={13} aria-hidden /> Present
              </button>
            ) : show === "full" ? (
              <button type="button" className="btn" onClick={(event) => screen.enter(event.currentTarget)} title="Show the file on the whole screen. Esc leaves.">
                <Maximize2 size={13} aria-hidden /> Full screen
              </button>
            ) : null}
            <DownloadButton file={file} />
            {way ? (
              <button
                type="button"
                className="btn"
                disabled={Boolean(converting)}
                onClick={() => void convert()}
                title={keepsFormatting ? "Edit it as a page. Exporting back keeps the original's formatting." : "Make a page from the file's text."}
              >
                {converting ? <Spinner size={12} /> : <FilePlus2 size={13} aria-hidden />}
                {keepsFormatting ? "Convert to a page" : "Make a page"}
              </button>
            ) : null}
            <button type="button" className="btn" onClick={() => setAttaching(true)}>
              <Paperclip size={13} aria-hidden /> Attach to a page…
            </button>
            <button type="button" className="icon-btn" aria-label={`Delete ${file.filename}`} title="Delete" onClick={() => setDeleting(true)}>
              <Trash2 size={15} />
            </button>
          </div>
        </div>
        {converting ? (
          <p className="mt-2 text-[12.5px] text-muted" role="status">
            {converting}
          </p>
        ) : null}
        {file.warnings.length ? (
          <ul className="mt-2 space-y-0.5 text-[12.5px] text-muted" aria-label="About this file">
            {file.warnings.map((warning) => (
              <li key={warning} className="flex items-start gap-1.5">
                <Info size={13} className="mt-[3px] shrink-0 text-faint" aria-hidden /> {warning}
              </li>
            ))}
          </ul>
        ) : null}
      </header>
      <div
        ref={show === "full" ? screen.layer : undefined}
        tabIndex={full ? -1 : undefined}
        role={full ? "dialog" : undefined}
        aria-modal={full || undefined}
        aria-label={full ? file.filename : undefined}
        className={cx("min-h-[420px] flex-1", full && "fixed inset-0 z-[60] flex min-h-0 flex-col overscroll-contain bg-bg outline-none")}
        data-file-full-screen={full ? "true" : undefined}
      >
        {full ? (
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
            <FileIcon kind={file.kind ?? format.kind} size={18} />
            <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium" title={file.filename}>
              {file.filename}
            </span>
            <span className="text-[12px] text-faint max-sm:hidden">Esc to leave</span>
            <button type="button" className="btn-ghost" onClick={screen.exit}>
              <Minimize2 size={13} aria-hidden /> Exit full screen
            </button>
          </div>
        ) : null}
        <PresentContext.Provider value={show === "present" ? present : null}>
          <FilePreview fileId={file.id} className={full ? "min-h-0 flex-1" : undefined} />
        </PresentContext.Provider>
      </div>
      <AttachToPage file={file} open={attaching} onClose={() => setAttaching(false)} onOpen={(href) => router.push(href)} />
      <DeleteFileDialog file={deleting ? file : null} onClose={() => setDeleting(false)} onDeleted={() => router.push("/files")} />
    </div>
  );
}
