"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import type { FileFormat, FileRecord } from "@ensemble/shared-types";
import { FILE_KIND_LABEL } from "@ensemble/shared-types";
import { formatBytes } from "@/lib/api-files";
import { FileIcon } from "../file-icon";
import { DownloadButton } from "./shared";

/** Formats Ensemble cannot show: what the file is, what to do about it, and a download. */
export function DetailsCard({ file, format, compact }: { file: FileRecord; format: FileFormat; compact: boolean }) {
  return (
    <div className="flex h-full items-center justify-center p-4" data-file-details={file.id}>
      <div className="flex max-w-md items-start gap-3">
        <FileIcon kind={file.kind ?? format.kind} size={compact ? 32 : 44} />
        <div className="min-w-0 text-[13px]">
          <p className="truncate font-medium text-ink" title={file.filename}>
            {file.filename}
          </p>
          <p className="text-[12.5px] text-muted">
            {format.ext ? format.label : FILE_KIND_LABEL.other} · {formatBytes(file.byteSize)}
          </p>
          {format.note ? <p className="mt-1.5 leading-5 text-muted">{format.note}</p> : null}
          {compact ? null : <DownloadButton file={file} className="mt-3" />}
        </div>
      </div>
    </div>
  );
}
