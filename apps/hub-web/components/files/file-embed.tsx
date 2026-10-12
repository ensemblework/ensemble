"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Download, File, FileAudio, FileCode, FileImage, FileSpreadsheet, FileText, FileVideo, Presentation, type LucideIcon } from "lucide-react";
import { fileFormat, mentionHref, type FileKind } from "@ensemble/shared-types";
import { ApiError, inItemView } from "@/lib/api";
import { FILE_QUERY, filesApi, formatBytes } from "@/lib/api-files";
import { saveBlob } from "@/lib/export/formats";
import { emitToast } from "@/lib/toast-bus";
import { createHeightHandle, storedEmbedHeight } from "../editor/embed-resize";
import { FilePreview } from "./file-preview";

const KIND_ICON: Record<FileKind, LucideIcon> = {
  pdf: FileText,
  document: FileText,
  slides: Presentation,
  sheet: FileSpreadsheet,
  image: FileImage,
  text: FileText,
  code: FileCode,
  audio: FileAudio,
  video: FileVideo,
  other: File,
};

export function fileKindIcon(kind: FileKind): LucideIcon {
  return KIND_ICON[kind] ?? File;
}

/** The original bytes as a download. Shared and public pages use this: /files/<id> is outside what they can open. */
export async function downloadOriginal(id: string, filename: string): Promise<void> {
  try {
    saveBlob(new Blob([await filesApi.original(id)]), filename);
  } catch (error) {
    emitToast(error instanceof Error ? error.message : "Could not download the file.", { tone: "error" });
  }
}

/** "Open" for the signed-in space, "Download" on a shared item or public link. */
export function OpenFileLink({ id, filename, className, children }: { id: string; filename: string; className?: string; children?: React.ReactNode }) {
  if (inItemView()) {
    return (
      <button type="button" className={className} onClick={() => void downloadOriginal(id, filename)}>
        {children ?? (
          <>
            <Download size={12} aria-hidden /> Download
          </>
        )}
      </button>
    );
  }
  return (
    <a href={mentionHref({ kind: "file", id, label: filename })} className={className}>
      {children ?? "Open"}
    </a>
  );
}

type FileEmbedProps = { id: string; label: string; height?: number | null; onResize?: (height: number) => void };

/** A file inside a page: what it is, a live preview, and a way to open it. */
export function FileEmbed({ id, label, height: storedHeight = null, onResize }: FileEmbedProps) {
  const record = useQuery({ queryKey: FILE_QUERY.one(id), queryFn: () => filesApi.get(id) });
  const [height, setHeight] = useState<number | null>(() => storedEmbedHeight(storedHeight));
  const heightRef = useRef(height);
  heightRef.current = height;
  const bodyRef = useRef<HTMLDivElement>(null);
  const handleHost = useRef<HTMLDivElement>(null);
  const commitRef = useRef(onResize);
  commitRef.current = onResize;
  useEffect(() => setHeight(storedEmbedHeight(storedHeight)), [storedHeight]);

  const file = record.data?.file;
  const name = file?.filename || label || "File";
  const format = fileFormat(name);
  const Icon = fileKindIcon(file?.kind ?? format.kind);
  const removed = record.error instanceof ApiError && (record.error.status === 404 || record.error.status === 410);

  const resizable = Boolean(onResize) && !removed;
  useEffect(() => {
    const host = handleHost.current;
    if (!host || !resizable) return;
    const handle = createHeightHandle({
      label: `Resize ${name}`,
      read: () => heightRef.current ?? bodyRef.current?.clientHeight ?? 320,
      apply: (next) => {
        heightRef.current = next;
        setHeight(next);
      },
      commit: (next) => commitRef.current?.(next),
    });
    host.append(handle);
    return () => handle.remove();
  }, [resizable, name]);

  return (
    <div className="plot-inline file-embed" contentEditable={false} data-file-embed={id}>
      <div className="diagram-inline-head items-center">
        <Icon size={14} className="shrink-0 text-muted" aria-hidden />
        <span className="diagram-inline-title min-w-0 flex-1 truncate" title={name}>
          {name}
        </span>
        {file ? <span className="shrink-0 text-[12px] text-muted">{[format.label, formatBytes(file.byteSize)].join(" · ")}</span> : null}
        {removed ? null : <OpenFileLink id={id} filename={name} className="diagram-inline-edit inline-flex items-center gap-1" />}
      </div>
      {removed ? (
        <p className="px-3 py-2.5 text-[13px] text-muted">This file was removed.</p>
      ) : record.error ? (
        <p role="alert" className="px-3 py-2.5 text-[13px] text-danger">
          {record.error.message || "Could not load this file."}
        </p>
      ) : (
        <div ref={bodyRef} className="file-embed-body">
          <FilePreview fileId={id} compact height={height ?? undefined} />
        </div>
      )}
      {resizable ? <div ref={handleHost} /> : null}
    </div>
  );
}

export type FileCardHandle = { destroy: () => void; setHeight: (height: number | null) => void };

let ownClient: QueryClient | null = null;

/** Mounts a file card into a page's mention node. `client` is the app's query cache, so the card and its preview share reads. */
export function mountFileCard(
  host: HTMLElement,
  id: string,
  label: string,
  options: { height?: number | null; onResize?: (height: number) => void; client?: QueryClient | null } = {},
): FileCardHandle {
  host.replaceChildren();
  host.className = "file-mention";
  host.contentEditable = "false";
  const client = options.client ?? (ownClient ??= new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 20_000 } } }));
  const root = createRoot(host);
  const render = (height: number | null) =>
    root.render(
      <QueryClientProvider client={client}>
        <FileEmbed id={id} label={label} height={height} onResize={options.onResize} />
      </QueryClientProvider>,
    );
  render(options.height ?? null);
  return {
    destroy: () => queueMicrotask(() => root.unmount()),
    setHeight: render,
  };
}
