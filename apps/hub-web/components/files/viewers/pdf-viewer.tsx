"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { Minus, MoveHorizontal, Plus } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { loadPdfjs } from "@/lib/files/pdfjs";
import { Spinner } from "../../ui";
import { Toolbar, ViewerNote, type ViewerProps } from "./shared";

type Size = { width: number; height: number };

const CSS_PER_PT = 96 / 72;
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
/** Largest canvas drawn for one page; past this the page renders at a lower pixel density. */
const MAX_PIXELS = 16_000_000;

export function pdfError(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "PasswordException") return "This PDF is password-protected. Download it and open it with its password.";
  if (name === "InvalidPDFException") return "This file is not a PDF Ensemble can read. It may be damaged.";
  return error instanceof Error && error.message ? error.message : "This PDF could not be opened.";
}

function usePdf(bytes: ArrayBuffer) {
  const [state, setState] = useState<{ doc: PDFDocumentProxy; first: Size } | { error: string } | null>(null);
  useEffect(() => {
    let live = true;
    let destroy: (() => void) | null = null;
    setState(null);
    loadPdfjs()
      .then(async ({ pdfjs, worker }) => {
        const task = pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)), worker });
        destroy = () => void task.destroy();
        if (!live) destroy();
        const doc = await task.promise;
        const page = await doc.getPage(1);
        const viewport = page.getViewport({ scale: 1 });
        if (live) setState({ doc, first: { width: viewport.width, height: viewport.height } });
      })
      .catch((error: unknown) => {
        if (live) setState({ error: pdfError(error) });
      });
    return () => {
      live = false;
      destroy?.();
    };
  }, [bytes]);
  return state;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    setWidth(node.clientWidth);
    const observer = new ResizeObserver(() => setWidth(node.clientWidth));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** One page drawn on a canvas when it comes near the visible area, and released when it leaves. */
function PdfPage({ doc, number, scale, size, root, onSize }: { doc: PDFDocumentProxy; number: number; scale: number; size: Size; root: HTMLElement | null; onSize?: (number: number, size: Size) => void }) {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const node = holder.current;
    if (!node) return;
    const observer = new IntersectionObserver((entries) => setNear(entries.some((entry) => entry.isIntersecting)), { root, rootMargin: "1200px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [root]);
  useEffect(() => {
    const target = canvas.current;
    if (!near || !target) {
      if (target) {
        target.width = 0;
        target.height = 0;
      }
      setDrawn(false);
      return;
    }
    let live = true;
    let cancel: (() => void) | null = null;
    void doc
      .getPage(number)
      .then((page) => {
        if (!live) return;
        const base = page.getViewport({ scale: 1 });
        if (Math.abs(base.width - size.width) > 0.5 || Math.abs(base.height - size.height) > 0.5) onSize?.(number, { width: base.width, height: base.height });
        let density = Math.min(2, window.devicePixelRatio || 1);
        const cssScale = scale;
        while (base.width * base.height * (cssScale * density) ** 2 > MAX_PIXELS && density > 0.5) density /= 1.5;
        const viewport = page.getViewport({ scale: cssScale * density });
        target.width = Math.floor(viewport.width);
        target.height = Math.floor(viewport.height);
        const task = page.render({ canvas: target, viewport });
        cancel = () => task.cancel();
        return task.promise.then(() => {
          if (live) setDrawn(true);
        });
      })
      .catch(() => undefined);
    return () => {
      live = false;
      cancel?.();
    };
  }, [near, doc, number, scale, size.width, size.height, onSize]);
  return (
    <div ref={holder} className="relative mx-auto bg-white shadow-sm" style={{ width: size.width * scale, height: size.height * scale }} data-pdf-page={number}>
      <canvas ref={canvas} className="block h-full w-full" aria-label={`Page ${number}`} role="img" />
      {near && !drawn ? (
        <span className="absolute inset-0 flex items-center justify-center">
          <Spinner size={14} />
        </span>
      ) : null}
    </div>
  );
}

/**
 * The PDF on a page or task: every page, fitted to the card's width, in its own scroll box. Pages
 * draw as they come near. The page count follows the scroll.
 */
function CompactPdf({ file, doc, first, pages }: { file: ViewerProps["file"]; doc: PDFDocumentProxy; first: Size; pages: number }) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [sizes, setSizes] = useState<Record<number, Size>>({});
  const [current, setCurrent] = useState(1);
  const onSize = useCallback((number: number, size: Size) => setSizes((all) => (all[number] ? all : { ...all, [number]: size })), []);
  useLayoutEffect(() => {
    if (!scroller) return;
    setWidth(scroller.clientWidth);
    const observer = new ResizeObserver(() => setWidth(scroller.clientWidth));
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [scroller]);
  const gap = 8;
  const scale = width ? Math.max(0.1, (width - 2 * gap) / first.width) : 0;
  const sizeOf = (number: number) => sizes[number] ?? first;
  const onScroll = () => {
    if (!scroller || !scale) return;
    const middle = scroller.scrollTop + scroller.clientHeight / 3;
    let top = gap;
    for (let number = 1; number <= pages; number += 1) {
      top += sizeOf(number).height * scale + gap;
      if (middle < top) {
        if (number !== current) setCurrent(number);
        return;
      }
    }
  };
  return (
    <div className="relative h-full bg-raised" data-pdf-compact>
      <div
        ref={setScroller}
        onScroll={onScroll}
        className="embed-scroll h-full overflow-y-auto overflow-x-hidden"
        tabIndex={0}
        aria-label={`${file.filename}, ${pages} ${pages === 1 ? "page" : "pages"}`}
      >
        {scale ? (
          <div className="flex flex-col items-center" style={{ gap, padding: gap }}>
            {Array.from({ length: pages }, (_, index) => (
              <PdfPage key={index + 1} doc={doc} number={index + 1} scale={scale} size={sizeOf(index + 1)} root={scroller} onSize={onSize} />
            ))}
          </div>
        ) : null}
      </div>
      {pages ? (
        <span className="pointer-events-none absolute bottom-2 right-3 rounded-md bg-black/60 px-1.5 py-0.5 text-[11.5px] tabular-nums text-white" aria-hidden>
          {pages > 1 ? `${current} of ${pages}` : "1 page"}
        </span>
      ) : null}
    </div>
  );
}

/** PDF pages drawn with pdf.js: pages render as they scroll into view; zoom and page count in the toolbar. */
export default function PdfViewer({ file, bytes, compact }: ViewerProps) {
  const state = usePdf(bytes);
  const [frame, width] = useWidth<HTMLDivElement>();
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [sizes, setSizes] = useState<Record<number, Size>>({});
  const [current, setCurrent] = useState(1);
  const [draft, setDraft] = useState<string | null>(null);
  const onSize = useCallback((number: number, size: Size) => setSizes((all) => (all[number] ? all : { ...all, [number]: size })), []);

  if (state && "error" in state) return <ViewerNote title={state.error} file={file} bytes={bytes} compact={compact} />;
  const doc = state?.doc;
  const first = state && "first" in state ? state.first : null;
  const pages = doc?.numPages ?? 0;
  // A phone-width viewer gives the page its width: an 8 px margin instead of 16. Touch screens draw
  // their scrollbar over the page, so only a mouse needs room left for one.
  const gap = width && width < 640 ? 8 : 16;
  const bar = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches ? 0 : 16;
  const fit = first && width ? Math.max(0.1, (width - (compact ? 0 : gap * 2 + bar)) / first.width) : CSS_PER_PT;
  const scale = zoom === "fit" ? fit : zoom * CSS_PER_PT;
  const sizeOf = (number: number) => sizes[number] ?? first!;

  if (compact) {
    return doc && first ? (
      <CompactPdf file={file} doc={doc} first={first} pages={pages} />
    ) : (
      <div className="flex h-full items-center justify-center bg-raised" data-pdf-compact>
        <Spinner />
      </div>
    );
  }

  const step = (direction: 1 | -1) => {
    const now = scale / CSS_PER_PT;
    const next = direction > 0 ? ZOOMS.find((value) => value > now + 0.01) : [...ZOOMS].reverse().find((value) => value < now - 0.01);
    setZoom(next ?? (direction > 0 ? ZOOMS.at(-1)! : ZOOMS[0]!));
  };
  const goTo = (number: number) => {
    const target = scroller?.querySelector<HTMLElement>(`[data-pdf-page="${number}"]`);
    if (target && scroller) scroller.scrollTo({ top: target.offsetTop - gap });
  };
  const onScroll = () => {
    if (!scroller) return;
    const middle = scroller.scrollTop + scroller.clientHeight / 3;
    let top = gap;
    for (let number = 1; number <= pages; number += 1) {
      const height = sizeOf(number).height * scale + gap;
      if (middle < top + height) {
        if (number !== current) setCurrent(number);
        return;
      }
      top += height;
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-pdf-viewer>
      <Toolbar>
        <label className="flex items-center gap-1.5 px-1">
          Page
          <input
            className="field w-12 px-1.5 py-0.5 text-center tabular-nums"
            inputMode="numeric"
            aria-label="Page number"
            value={draft ?? (pages ? String(current) : "")}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => setDraft(null)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              const value = Number(draft);
              if (Number.isInteger(value) && value >= 1 && value <= pages) {
                setCurrent(value);
                goTo(value);
              }
              setDraft(null);
            }}
          />
          of {pages || "…"}
        </label>
        <span className="ml-auto flex items-center gap-1">
          <button type="button" className="icon-btn" aria-label="Zoom out" title="Zoom out" onClick={() => step(-1)} disabled={!first}>
            <Minus size={14} />
          </button>
          <span className="w-11 text-center tabular-nums">{Math.round((scale / CSS_PER_PT) * 100)}%</span>
          <button type="button" className="icon-btn" aria-label="Zoom in" title="Zoom in" onClick={() => step(1)} disabled={!first}>
            <Plus size={14} />
          </button>
          <button type="button" className="btn-ghost" aria-pressed={zoom === "fit"} onClick={() => setZoom("fit")}>
            <MoveHorizontal size={13} aria-hidden /> Fit<span className="max-sm:hidden"> width</span>
          </button>
        </span>
      </Toolbar>
      <div ref={frame} className="min-h-0 flex-1">
        <div ref={setScroller} onScroll={onScroll} className="h-full overflow-auto bg-raised" tabIndex={0} aria-label={`${file.filename}, ${pages} pages`}>
          {doc && first && width ? (
            <div className="flex min-w-max flex-col items-center sm:min-w-0" style={{ gap, padding: gap }}>
              {Array.from({ length: pages }, (_, index) => (
                <PdfPage key={index + 1} doc={doc} number={index + 1} scale={scale} size={sizeOf(index + 1)} root={scroller} onSize={onSize} />
              ))}
            </div>
          ) : (
            <div className="flex h-full items-center justify-center">
              <Spinner />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
