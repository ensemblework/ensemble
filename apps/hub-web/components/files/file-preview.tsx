"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { Component, Suspense, lazy, type ComponentType, type ReactNode } from "react";
import { fileFormat, type FileFormat, type FileRecord } from "@ensemble/shared-types";
import { ApiError } from "@/lib/api";
import { viewerFor, type ViewerKind } from "@/lib/files/formats";
import { Spinner, cx } from "../ui";
import { useFileBytes, useFileRecord } from "./use-file";
import { DetailsCard } from "./viewers/details-card";
import { ViewerNote, type ViewerProps } from "./viewers/shared";

/**
 * Shows one file the way its format allows (components/files/viewers/*).
 * `compact` is the small card used inside pages; the full view is /files/[id].
 */
export type FilePreviewProps = {
  fileId: string;
  /** Inside a page: a short preview with an Open button. */
  compact?: boolean;
  /** Pixel height for compact previews (pages remember it per embed). */
  height?: number;
  className?: string;
};

// Each viewer, and the library it needs, loads only when a file of its kind is opened.
const VIEWERS: Record<Exclude<ViewerKind, "details">, ComponentType<ViewerProps>> = {
  pdf: lazy(() => import("./viewers/pdf-viewer")),
  docx: lazy(() => import("./viewers/docx-viewer")),
  pptx: lazy(() => import("./viewers/pptx-viewer")),
  sheet: lazy(() => import("./viewers/sheet-viewer")),
  image: lazy(() => import("./viewers/image-viewer")),
  audio: lazy(() => import("./viewers/media-viewer")),
  video: lazy(() => import("./viewers/media-viewer")),
  text: lazy(() => import("./viewers/text-viewer")),
};

export const COMPACT_HEIGHT = 320;

function Loading() {
  return (
    <div className="flex h-full min-h-[96px] items-center justify-center" role="status" aria-label="Loading preview">
      <Spinner />
    </div>
  );
}

class ViewerBoundary extends Component<{ children: ReactNode; file: FileRecord; compact: boolean }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <ViewerNote title="This preview stopped working" file={this.props.file} compact={this.props.compact}>
          Reload the page to try again, or download the file to open it on your computer.
        </ViewerNote>
      );
    }
    return this.props.children;
  }
}

function Loaded({ file, format, kind, compact }: { file: FileRecord; format: FileFormat; kind: Exclude<ViewerKind, "details">; compact: boolean }) {
  const bytes = useFileBytes(file);
  if (bytes.error) {
    const missing = bytes.error instanceof ApiError && (bytes.error.status === 404 || bytes.error.status === 410);
    return <ViewerNote title={missing ? "This file was removed." : bytes.error.message || "The file could not be loaded."} compact={compact} />;
  }
  if (!bytes.data) return <Loading />;
  const Viewer = VIEWERS[kind];
  return (
    <ViewerBoundary key={file.sha256} file={file} compact={compact}>
      <Suspense fallback={<Loading />}>
        <Viewer file={file} format={format} bytes={bytes.data} compact={compact} />
      </Suspense>
    </ViewerBoundary>
  );
}

export function FilePreview({ fileId, compact = false, height, className }: FilePreviewProps) {
  const record = useFileRecord(fileId);
  const file = record.data?.file;
  const style = compact ? { height: height ?? COMPACT_HEIGHT } : undefined;
  let body: ReactNode;
  if (record.error) {
    const missing = record.error instanceof ApiError && (record.error.status === 404 || record.error.status === 410);
    body = <ViewerNote title={missing ? "This file was removed." : record.error.message || "The file could not be loaded."} compact={compact} />;
  } else if (!file) {
    body = <Loading />;
  } else {
    const format = fileFormat(file.filename);
    const kind = viewerFor(format);
    body = kind === "details" ? <DetailsCard file={file} format={format} compact={compact} /> : <Loaded file={file} format={format} kind={kind} compact={compact} />;
  }
  return (
    <div
      data-file-preview={fileId}
      data-compact={compact ? "true" : "false"}
      className={cx("relative min-h-0 overflow-hidden", compact ? "w-full" : "h-full w-full", className)}
      style={style}
    >
      {body}
    </div>
  );
}
