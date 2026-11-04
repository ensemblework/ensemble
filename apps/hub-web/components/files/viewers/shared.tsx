"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { Download } from "lucide-react";
import { createContext, useContext, useState } from "react";
import { createPortal } from "react-dom";
import type { FileFormat, FileRecord } from "@ensemble/shared-types";
import { emitToast } from "@/lib/toast-bus";
import { cx } from "../../ui";
import { downloadFile } from "../use-file";

export type ViewerProps = {
  file: FileRecord;
  format: FileFormat;
  bytes: ArrayBuffer;
  /** The small preview inside a page. */
  compact: boolean;
};

/**
 * Present mode on the file's own screen (/files/[id]). The screen owns the full-screen mode
 * (lib/fullscreen.ts) because the browser only grants fullscreen to the click on its button;
 * the slide viewer draws the presentation into it.
 */
export type PresentControl = {
  active: boolean;
  /** The ref for the presentation layer. */
  layer: (node: HTMLElement | null) => void;
  exit: () => void;
  /** F while presenting: in and out of the browser's fullscreen, still presenting. */
  toggleNative: () => void;
  /** The viewer has its pages or slides and can present them. */
  setReady: (ready: boolean) => void;
};

export const PresentContext = createContext<PresentControl | null>(null);

export function DownloadButton({ file, bytes, className, label = "Download", iconOnly = false }: { file: FileRecord; bytes?: ArrayBuffer; className?: string; label?: string; iconOnly?: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={cx(iconOnly ? "icon-btn" : "btn", className)}
      aria-label={iconOnly ? `${label} ${file.filename}` : undefined}
      title={iconOnly ? label : undefined}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        downloadFile(file, bytes)
          .catch((error: unknown) => emitToast(error instanceof Error ? error.message : "Could not download the file.", { tone: "error" }))
          .finally(() => setBusy(false));
      }}
    >
      <Download size={iconOnly ? 15 : 13} aria-hidden /> {iconOnly ? null : label}
    </button>
  );
}

/** A calm message in the viewer's place: why it cannot show the file, and a way to get it. */
export function ViewerNote({ title, children, file, bytes, compact }: { title: string; children?: React.ReactNode; file?: FileRecord; bytes?: ArrayBuffer; compact?: boolean }) {
  return (
    <div className={cx("flex h-full min-h-[120px] flex-col items-center justify-center gap-2 px-4 text-center", compact ? "py-4" : "py-10")} data-viewer-note>
      <p className="text-[13.5px] font-medium text-ink">{title}</p>
      {children ? <div className="max-w-md text-[12.5px] leading-5 text-muted">{children}</div> : null}
      {file && !compact ? <DownloadButton file={file} bytes={bytes} className="mt-1" /> : null}
    </div>
  );
}

/**
 * On a file's own screen, the bar the viewer's controls join (page, zoom, sheets), so the file gets
 * the room and there is one thin bar above it. Elsewhere (a card in a page, full screen) the controls
 * keep their own bar on the viewer.
 */
export const ToolbarSlot = createContext<HTMLElement | null>(null);

export function Toolbar({ children, className }: { children: React.ReactNode; className?: string }) {
  const slot = useContext(ToolbarSlot);
  if (slot) return createPortal(<div className={cx("file-bar-tools flex min-w-0 flex-wrap items-center gap-1 text-[12.5px] text-muted", className)}>{children}</div>, slot);
  return <div className={cx("flex min-h-10 shrink-0 flex-wrap items-center gap-1 border-b border-line px-2 py-1 text-[12.5px] text-muted", className)}>{children}</div>;
}
