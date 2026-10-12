"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { FileAudio } from "lucide-react";
import { useState } from "react";
import { useBlobUrl } from "../use-file";
import { ViewerNote, type ViewerProps } from "./shared";

/** Audio and video in the browser's own players. */
export default function MediaViewer({ file, format, bytes, compact }: ViewerProps) {
  const url = useBlobUrl(bytes, format.mime);
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <ViewerNote title="This browser cannot play it" file={file} bytes={bytes} compact={compact}>
        {format.label} files do not play in every browser. Download it to play it on your computer.
      </ViewerNote>
    );
  }
  if (!url) return null;
  if (format.kind === "audio") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-4 py-4">
        {compact ? null : <FileAudio size={40} strokeWidth={1.4} className="text-faint" aria-hidden />}
        <audio controls preload="metadata" src={url} className="w-full max-w-xl" onError={() => setFailed(true)} />
      </div>
    );
  }
  return (
    <div className="flex h-full items-center justify-center bg-black">
      <video controls playsInline preload="metadata" src={url} className="max-h-full max-w-full" onError={() => setFailed(true)} />
    </div>
  );
}
