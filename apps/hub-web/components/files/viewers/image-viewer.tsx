"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { Minus, Plus, Scan } from "lucide-react";
import { useState } from "react";
import { useBlobUrl } from "../use-file";
import { CHECKER, Toolbar, ViewerNote, type ViewerProps } from "./shared";

const STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

/** Pictures, SVG included, as an <img> from a blob URL: an SVG shown this way cannot run scripts. */
export default function ImageViewer({ file, format, bytes, compact }: ViewerProps) {
  const url = useBlobUrl(bytes, format.mime);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <ViewerNote title="This picture could not be shown" file={file} bytes={bytes} compact={compact}>
        Your browser cannot open this {format.label}. Download it to view it.
      </ViewerNote>
    );
  }
  const image = url ? (
    <img
      src={url}
      alt={file.filename}
      draggable={false}
      onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
      onError={() => setFailed(true)}
      className={zoom === "fit" ? "max-h-full max-w-full object-contain" : "max-w-none"}
      style={zoom !== "fit" && natural ? { width: natural.width * zoom, height: natural.height * zoom } : undefined}
    />
  ) : null;
  if (compact) {
    return (
      <div className="flex h-full items-center justify-center overflow-hidden p-2" style={CHECKER}>
        {image}
      </div>
    );
  }
  const step = (direction: 1 | -1) => {
    const current = zoom === "fit" ? 1 : zoom;
    const next = direction > 0 ? STEPS.find((value) => value > current + 0.001) : [...STEPS].reverse().find((value) => value < current - 0.001);
    setZoom(next ?? current);
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar>
        <button type="button" className="icon-btn" aria-label="Zoom out" title="Zoom out" onClick={() => step(-1)}>
          <Minus size={14} />
        </button>
        <span className="w-12 text-center tabular-nums" aria-live="polite">
          {zoom === "fit" ? "Fit" : `${Math.round(zoom * 100)}%`}
        </span>
        <button type="button" className="icon-btn" aria-label="Zoom in" title="Zoom in" onClick={() => step(1)}>
          <Plus size={14} />
        </button>
        <button type="button" className="btn-ghost" aria-pressed={zoom === "fit"} onClick={() => setZoom("fit")}>
          <Scan size={13} aria-hidden /> Fit
        </button>
        <button type="button" className="btn-ghost" aria-pressed={zoom === 1} onClick={() => setZoom(1)}>
          100%
        </button>
        {natural ? <span className="ml-auto pr-1 text-faint">{natural.width} × {natural.height}</span> : null}
      </Toolbar>
      <div className={zoom === "fit" ? "flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4" : "min-h-0 flex-1 overflow-auto p-4"} style={CHECKER}>
        {image}
      </div>
    </div>
  );
}
