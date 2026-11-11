"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Download, ExternalLink, FilePlus2, Info, Maximize2, MoreHorizontal, Paperclip, Presentation, Trash2, X } from "lucide-react";
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
import { InfoTip, MenuItem, Popover, Spinner, cx } from "../ui";
import { AttachToPage } from "./attach-to-page";
import { FileIcon } from "./file-icon";
import { FilePreview } from "./file-preview";
import { DeleteFileDialog } from "./delete-file";
import { downloadFile, useFileRecord } from "./use-file";
import { DownloadButton, PresentContext, ToolbarSlot, type PresentControl } from "./viewers/shared";

/** Previews that can fill the screen as they are, with their own zoom. Slides present instead; audio has nothing to fill it with. */
const FULL_SCREEN = new Set<ViewerKind>(["pdf", "docx", "sheet", "image", "video", "text"]);

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
  const [toolbarSlot, setToolbarSlot] = useState<HTMLElement | null>(null);
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
  const show = viewer === "pptx" ? "present" : FULL_SCREEN.has(viewer) ? "full" : null;
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
      toast(result.notice, { tone: "ok" });
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not make a page from this file.", { tone: "error" });
    } finally {
      setConverting(null);
    }
  };

  const facts = [format.ext ? format.label : "File", formatBytes(file.byteSize), countLabel(file), `Added ${relative(file.createdAt)}`].filter(Boolean).join(" · ");

  const about = (
    <div className="space-y-1.5 text-[12.5px] leading-5">
      <p className="font-medium text-ink">{file.filename}</p>
      <p className="text-muted">{facts}</p>
      {file.source ? (
        <p className="flex items-center gap-1.5 text-muted">
          <BrandLogo id={file.source.app} name={brandName(file.source.app, file.source.label)} size={13} decorative />
          {file.source.url ? (
            <a href={file.source.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 hover:text-ink hover:underline">
              From {file.source.label} <ExternalLink size={11} aria-hidden />
            </a>
          ) : (
            <span>From {file.source.label}</span>
          )}
        </p>
      ) : null}
      {file.warnings.length ? (
        <ul className="space-y-0.5 border-t border-line pt-1.5 text-muted" aria-label="About this file">
          {file.warnings.map((warning) => (
            <li key={warning} className="flex items-start gap-1.5">
              <Info size={13} className="mt-[3px] shrink-0 text-warn" aria-hidden /> {warning}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col" data-file-screen={file.id}>
      {/* One thin bar: back, the name (details on the info icon), the viewer's own controls, the file's actions. */}
      <header className="file-bar shrink-0 border-b border-line">
        <div className="file-bar-title">
          <Link href="/files" className="icon-btn" aria-label="Back to Files" title="Files">
            <ArrowLeft size={16} aria-hidden />
          </Link>
          <FileIcon kind={file.kind ?? format.kind} size={20} />
          <h1 className="min-w-0 truncate text-[14px] font-semibold" title={file.filename}>
            {file.filename}
          </h1>
          <InfoTip text={about} label={file.warnings.length ? "About this file (has notes)" : "About this file"} />
          {file.warnings.length ? <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: "var(--warn)" }} aria-hidden /> : null}
        </div>
        <div ref={setToolbarSlot} className="file-bar-slot" />
        <div className="file-bar-actions">
          {converting ? (
            <span className="max-w-[16rem] truncate text-[12px] text-muted max-sm:flex max-sm:w-8 max-sm:justify-center" role="status" aria-live="polite">
              <span className="max-sm:sr-only">{converting}</span>
              <span className="sm:hidden"><Spinner size={12} /></span>
            </span>
          ) : null}
          {way ? (
            <button
              type="button"
              className="btn h-8 px-2.5 max-sm:hidden"
              disabled={Boolean(converting)}
              onClick={() => void convert()}
              aria-label={keepsFormatting ? "Convert to a page" : "Make a page"}
              title={keepsFormatting ? "Edit it as a page. Exporting back keeps the original's formatting." : "Make a page from the file's text."}
            >
              {converting ? <Spinner size={12} /> : <FilePlus2 size={14} aria-hidden />}
              <span className="max-lg:hidden">{keepsFormatting ? "Convert to a page" : "Make a page"}</span>
            </button>
          ) : null}
          {show === "present" ? (
            <button
              type="button"
              className="icon-btn"
              disabled={!canPresent}
              aria-label="Present"
              onClick={(event) => screen.enter(event.currentTarget)}
              title="Present: one slide at a time on the whole screen. Arrow keys move, Esc stops."
            >
              <Presentation size={15} aria-hidden />
            </button>
          ) : show === "full" ? (
            <button type="button" className="icon-btn" aria-label="Full screen" onClick={(event) => screen.enter(event.currentTarget)} title="Full screen (Esc leaves)">
              <Maximize2 size={15} aria-hidden />
            </button>
          ) : null}
          <DownloadButton file={file} iconOnly className="max-sm:hidden" />
          <button type="button" className="icon-btn max-sm:hidden" aria-label="Attach to a page" title="Attach to a page…" onClick={() => setAttaching(true)}>
            <Paperclip size={15} aria-hidden />
          </button>
          <button type="button" className="icon-btn hover:text-danger max-sm:hidden" aria-label={`Delete ${file.filename}`} title="Delete" onClick={() => setDeleting(true)}>
            <Trash2 size={15} />
          </button>
          {/* A phone keeps the name readable: the file's other actions share one menu. */}
          <Popover
            align="right"
            width={220}
            className="sm:hidden"
            trigger={(open, toggle) => (
              <button type="button" className="icon-btn" aria-label="File actions" aria-expanded={open} onClick={toggle}>
                <MoreHorizontal size={16} aria-hidden />
              </button>
            )}
          >
            {(close) => (
              <>
                {way ? (
                  <MenuItem disabled={Boolean(converting)} onClick={() => { close(); void convert(); }}>
                    <FilePlus2 size={14} aria-hidden /> {keepsFormatting ? "Convert to a page" : "Make a page"}
                  </MenuItem>
                ) : null}
                <MenuItem onClick={() => { close(); void downloadFile(file).catch((error: unknown) => toast(error instanceof Error ? error.message : "Could not download the file.", { tone: "error" })); }}>
                  <Download size={14} aria-hidden /> Download
                </MenuItem>
                <MenuItem onClick={() => { close(); setAttaching(true); }}>
                  <Paperclip size={14} aria-hidden /> Attach to a page
                </MenuItem>
                <MenuItem onClick={() => { close(); setDeleting(true); }}>
                  <Trash2 size={14} aria-hidden /> Delete
                </MenuItem>
              </>
            )}
          </Popover>
        </div>
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
            <button type="button" className="icon-btn" aria-label="Exit full screen" title="Exit full screen (Esc)" onClick={screen.exit}>
              <X size={16} />
            </button>
          </div>
        ) : null}
        <PresentContext.Provider value={show === "present" ? present : null}>
          <ToolbarSlot.Provider value={full ? null : toolbarSlot}>
            <FilePreview fileId={file.id} className={full ? "min-h-0 flex-1" : undefined} />
          </ToolbarSlot.Provider>
        </PresentContext.Provider>
      </div>
      <AttachToPage file={file} open={attaching} onClose={() => setAttaching(false)} onOpen={(href) => router.push(href)} />
      <DeleteFileDialog file={deleting ? file : null} onClose={() => setDeleting(false)} onDeleted={() => router.push("/files")} />
    </div>
  );
}
