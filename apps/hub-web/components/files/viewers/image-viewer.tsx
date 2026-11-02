"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { Minus, Plus, Scan } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useBlobUrl } from "../use-file";
import { Toolbar, ViewerNote, type ViewerProps } from "./shared";
import "./image-viewer.css";

const STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

/** Pictures, SVG included, as an <img> from a blob URL: an SVG shown this way cannot run scripts. */
export default function ImageViewer({ file, format, bytes, compact }: ViewerProps) {
  const url = useBlobUrl(bytes, format.mime);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [look, setLook] = useState<Look | null>(null);
  const picture = useRef<HTMLImageElement>(null);
  const shown = useShownScale(picture, natural?.width ?? 0);
  if (failed) {
    return (
      <ViewerNote title="This picture could not be shown" file={file} bytes={bytes} compact={compact}>
        Your browser cannot open this {format.label}. Download it to view it.
      </ViewerNote>
    );
  }
  const fit = zoom === "fit";
  const image = url ? (
    <img
      ref={picture}
      src={url}
      alt={file.filename}
      draggable={false}
      onLoad={(event) => {
        const element = event.currentTarget;
        setNatural({ width: element.naturalWidth, height: element.naturalHeight });
        setLook(readLook(element));
      }}
      onError={() => setFailed(true)}
      className={fit ? "image-stage-picture max-h-full max-w-full object-contain" : "image-stage-picture max-w-none"}
      style={!fit && natural ? { width: natural.width * zoom, height: natural.height * zoom } : undefined}
    />
  ) : null;
  if (compact) return <Stage url={url} look={look} fit compact>{image}</Stage>;
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
          {zoom === "fit" ? (shown ? `${Math.round(shown * 100)}%` : "Fit") : `${Math.round(zoom * 100)}%`}
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
      <Stage url={url} look={look} fit={fit}>{image}</Stage>
    </div>
  );
}

/** The scale the picture is drawn at when it fits the stage, kept up to date as the stage resizes. */
function useShownScale(picture: React.RefObject<HTMLImageElement | null>, naturalWidth: number): number | null {
  const [scale, setScale] = useState<number | null>(null);
  useEffect(() => {
    const element = picture.current;
    if (!element || !naturalWidth) return;
    const measure = () => setScale(element.clientWidth ? element.clientWidth / naturalWidth : null);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [picture, naturalWidth]);
  return scale;
}

/** What the picture looks like at a glance: its average colour, and whether it has see-through parts. */
type Look = { tone: string; dark: boolean; clear: boolean };

/** Reads the picture at a few pixels. A picture the browser will not let a canvas read keeps the plain stage. */
function readLook(element: HTMLImageElement): Look | null {
  try {
    const size = 24;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(element, 0, 0, size, size);
    const { data } = context.getImageData(0, 0, size, size);
    let red = 0;
    let green = 0;
    let blue = 0;
    let solid = 0;
    let clear = false;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3] < 250) clear = true;
      if (data[index + 3] < 200) continue;
      red += data[index];
      green += data[index + 1];
      blue += data[index + 2];
      solid += 1;
    }
    if (!solid) return { tone: "transparent", dark: false, clear: true };
    const [r, g, b] = [red / solid, green / solid, blue / solid].map(Math.round);
    return { tone: `rgb(${r} ${g} ${b})`, dark: 0.2126 * r + 0.7152 * g + 0.0722 * b < 128, clear };
  } catch {
    return null;
  }
}

/**
 * The picture on a backdrop made from itself: its own colours, blurred, behind it, so the space a
 * different shape leaves around it looks like part of the picture rather than an empty grid. A
 * picture with see-through parts sits on the plain surface with a soft glow of its colour instead.
 */
function Stage({ url, look, fit, compact, children }: { url: string | null; look: Look | null; fit: boolean; compact?: boolean; children: ReactNode }) {
  const ambient = Boolean(url && look && !look.clear);
  return (
    <div
      className="image-stage"
      data-ambient={ambient ? "true" : "false"}
      data-compact={compact ? "true" : undefined}
      data-tone={look ? (look.dark ? "dark" : "light") : undefined}
      style={look ? ({ "--image-tone": look.tone } as CSSProperties) : undefined}
    >
      {ambient ? <img src={url!} alt="" aria-hidden draggable={false} className="image-stage-glow" /> : null}
      <div className={fit ? "image-stage-frame" : "image-stage-frame image-stage-scroll"}>{children}</div>
    </div>
  );
}
