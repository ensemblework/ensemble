"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { BarChart3, ChevronLeft, ChevronRight, EyeOff } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { parsePptx, type PptxDeck, type PptxFill, type PptxParagraph, type PptxShape, type PptxSlide, type PptxText } from "@/lib/files/pptx";
import { Spinner, cx } from "../../ui";
import { Toolbar, ViewerNote, type ViewerProps } from "./shared";

type Urls = Record<string, string>;

const SERIF = /times|georgia|cambria|garamond|palatino|book|baskerville|serif/i;

function fontStack(font: string | undefined): string {
  if (!font) return '"Helvetica Neue", Arial, sans-serif';
  return `"${font.replace(/"/g, "")}", ${SERIF.test(font) ? 'Georgia, "Times New Roman", serif' : '"Carlito", "Helvetica Neue", Arial, sans-serif'}`;
}

function fillStyle(fill: PptxFill | undefined, urls: Urls): React.CSSProperties {
  if (!fill) return {};
  if (fill.image && urls[fill.image]) return { backgroundImage: `url("${urls[fill.image]}")`, backgroundSize: "cover", backgroundPosition: "center" };
  if (fill.gradient) return { backgroundImage: fill.gradient };
  if (fill.color) return { backgroundColor: fill.color };
  return {};
}

function Paragraph({ paragraph }: { paragraph: PptxParagraph }) {
  const visible = paragraph.runs.some((run) => run.text);
  const size = paragraph.runs.find((run) => run.text)?.size ?? paragraph.emptySize;
  const style: React.CSSProperties = {
    margin: 0,
    marginTop: paragraph.spaceBefore,
    marginBottom: paragraph.spaceAfter,
    paddingLeft: paragraph.marginLeft,
    textIndent: paragraph.indent,
    textAlign: paragraph.align,
    lineHeight: paragraph.lineHeightPx ? `${paragraph.lineHeightPx}px` : (paragraph.lineHeight ?? 1.2),
    fontSize: size,
  };
  return (
    <p style={style}>
      {paragraph.bullet ? (
        <span
          style={{
            display: "inline-block",
            textIndent: 0,
            minWidth: paragraph.indent < 0 ? -paragraph.indent : undefined,
            marginRight: paragraph.indent < 0 ? 0 : "0.4em",
            color: paragraph.bullet.color,
            fontSize: paragraph.bullet.size,
            fontFamily: paragraph.bullet.font ? fontStack(paragraph.bullet.font) : undefined,
          }}
        >
          {paragraph.bullet.text}
        </span>
      ) : null}
      {visible
        ? paragraph.runs.map((run, index) =>
            run.lineBreak ? (
              <br key={index} />
            ) : (
              <span
                key={index}
                style={{
                  fontSize: run.size,
                  fontWeight: run.bold ? 700 : undefined,
                  fontStyle: run.italic ? "italic" : undefined,
                  textDecoration: [run.underline ? "underline" : "", run.strike ? "line-through" : ""].filter(Boolean).join(" ") || undefined,
                  color: run.color,
                  fontFamily: fontStack(run.font),
                }}
              >
                {run.text}
              </span>
            ),
          )
        : " "}
    </p>
  );
}

function TextBody({ text, fill }: { text: PptxText; fill?: boolean }) {
  return (
    <div
      style={{
        position: fill ? "absolute" : "relative",
        inset: fill ? 0 : undefined,
        height: fill ? undefined : "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: text.anchor === "middle" ? "center" : text.anchor === "bottom" ? "flex-end" : "flex-start",
        padding: `${text.insets.top}px ${text.insets.right}px ${text.insets.bottom}px ${text.insets.left}px`,
        whiteSpace: text.wrap ? "pre-wrap" : "pre",
        overflowWrap: "break-word",
        writingMode: text.vertical ? "vertical-rl" : undefined,
        transform: text.vertical === "vertical270" ? "rotate(180deg)" : undefined,
      }}
    >
      {text.paragraphs.map((paragraph, index) => (
        <Paragraph key={index} paragraph={paragraph} />
      ))}
    </div>
  );
}

function boxStyle(shape: PptxShape): React.CSSProperties {
  const { box } = shape;
  const transforms = [box.rotate ? `rotate(${box.rotate}deg)` : "", box.flipH ? "scaleX(-1)" : "", box.flipV ? "scaleY(-1)" : ""].filter(Boolean).join(" ");
  return { position: "absolute", left: box.x, top: box.y, width: box.w, height: box.h, ...(transforms ? { transform: transforms } : {}) };
}

function Shape({ shape, urls }: { shape: PptxShape; urls: Urls }) {
  switch (shape.kind) {
    case "shape": {
      const radius = shape.geometry === "ellipse" ? "50%" : shape.geometry === "roundRect" ? Math.min(shape.box.w, shape.box.h) * 0.1667 : undefined;
      // Flipped text would read backwards; only the shape itself flips.
      const style = { ...boxStyle(shape), transform: shape.box.rotate ? `rotate(${shape.box.rotate}deg)` : undefined };
      return (
        <div style={style}>
          <div style={{ position: "absolute", inset: 0, borderRadius: radius, ...fillStyle(shape.fill, urls), ...(shape.line ? { border: `${shape.line.width}px solid ${shape.line.color}` } : {}) }} />
          {shape.text ? <TextBody text={shape.text} fill /> : null}
        </div>
      );
    }
    case "image":
      return urls[shape.media] ? <img src={urls[shape.media]} alt="" draggable={false} style={{ ...boxStyle(shape), objectFit: "fill" }} /> : null;
    case "line": {
      const { w, h, flipH, flipV } = shape.box;
      return (
        <svg style={{ position: "absolute", left: shape.box.x, top: shape.box.y, width: Math.max(w, 1), height: Math.max(h, 1), overflow: "visible" }} aria-hidden>
          <line x1={flipH ? w : 0} y1={flipV ? h : 0} x2={flipH ? 0 : w} y2={flipV ? 0 : h} stroke={shape.color} strokeWidth={shape.width} />
        </svg>
      );
    }
    case "table":
      return (
        <div style={boxStyle(shape)}>
          <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
            <colgroup>
              {shape.columns.map((width, index) => (
                <col key={index} style={{ width }} />
              ))}
            </colgroup>
            <tbody>
              {shape.rows.map((row, rowIndex) => (
                <tr key={rowIndex} style={{ height: row.height }}>
                  {row.cells.map((cell, cellIndex) =>
                    cell.hidden ? null : (
                      <td
                        key={cellIndex}
                        colSpan={cell.colSpan}
                        rowSpan={cell.rowSpan}
                        style={{ padding: 0, border: "1px solid #c9c9c9", verticalAlign: "top", backgroundColor: cell.fill, fontWeight: shape.headerRow && rowIndex === 0 ? 700 : undefined }}
                      >
                        <TextBody text={cell.text} />
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "placeholder":
      return (
        <div
          style={{ ...boxStyle(shape), border: "2px dashed #b9b4ab", borderRadius: 8, background: "rgba(127,127,127,0.06)", color: "#6b655c", fontSize: 18, fontFamily: fontStack(undefined) }}
          className="flex flex-col items-center justify-center gap-2 p-2 text-center"
        >
          <BarChart3 size={28} aria-hidden />
          <span>{shape.label}</span>
        </div>
      );
  }
}

/** One slide at its own size, scaled into `width` pixels. */
export const SlideView = memo(function SlideView({ deck, slide, urls, width }: { deck: PptxDeck; slide: PptxSlide; urls: Urls; width: number }) {
  const scale = width / deck.width;
  return (
    <div className="relative overflow-hidden bg-white shadow-sm" style={{ width, height: deck.height * scale }} data-slide={slide.number}>
      <div style={{ position: "absolute", left: 0, top: 0, width: deck.width, height: deck.height, transform: `scale(${scale})`, transformOrigin: "0 0", ...fillStyle(slide.background, urls) }}>
        {slide.shapes.map((shape, index) => (
          <Shape key={index} shape={shape} urls={urls} />
        ))}
      </div>
    </div>
  );
});

function useDeck(bytes: ArrayBuffer): { deck: PptxDeck | null; error: string | null } {
  const [state, setState] = useState<{ deck: PptxDeck | null; error: string | null }>({ deck: null, error: null });
  useEffect(() => {
    let live = true;
    setState({ deck: null, error: null });
    // Let the spinner paint before parsing a large deck.
    const timer = window.setTimeout(() => {
      try {
        const deck = parsePptx(new Uint8Array(bytes));
        if (live) setState({ deck, error: deck.slides.length ? null : "This presentation has no slides." });
      } catch (error) {
        if (live) setState({ deck: null, error: error instanceof Error ? error.message : "This presentation could not be read." });
      }
    }, 0);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [bytes]);
  return state;
}

function useMediaUrls(deck: PptxDeck | null): Urls {
  const [urls, setUrls] = useState<Urls>({});
  useEffect(() => {
    if (!deck) return;
    const next: Urls = {};
    for (const [path, media] of Object.entries(deck.media)) next[path] = URL.createObjectURL(new Blob([media.bytes as BlobPart], { type: media.mime }));
    setUrls(next);
    return () => {
      for (const url of Object.values(next)) URL.revokeObjectURL(url);
    };
  }, [deck]);
  return urls;
}

function useSize<T extends HTMLElement>(): [React.RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setSize({ width: node.clientWidth, height: node.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, size];
}

/** PowerPoint slides rendered from the file's XML, with a filmstrip and arrow keys. */
export default function PptxViewer({ file, bytes, compact }: ViewerProps) {
  const { deck, error } = useDeck(bytes);
  const urls = useMediaUrls(deck);
  const [index, setIndex] = useState(0);
  const [stage, size] = useSize<HTMLDivElement>();
  const strip = useRef<HTMLDivElement>(null);
  const count = deck?.slides.length ?? 0;
  const go = (next: number) => setIndex(Math.max(0, Math.min(count - 1, next)));
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>(`[data-thumb="${index}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [index]);
  const slideWidth = useMemo(() => {
    if (!deck || !size.width) return 0;
    const pad = compact ? 0 : 32;
    return Math.max(80, Math.min(size.width - pad, ((size.height - pad) * deck.width) / deck.height));
  }, [deck, size, compact]);

  if (error) return <ViewerNote title={error} file={file} bytes={bytes} compact={compact} />;
  const slide = deck?.slides[Math.min(index, count - 1)];
  const onKeyDown = (event: React.KeyboardEvent) => {
    const keys: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, PageDown: 1, " ": 1, ArrowLeft: -1, ArrowUp: -1, PageUp: -1 };
    if (event.key === "Home") go(0);
    else if (event.key === "End") go(count - 1);
    else if (keys[event.key]) go(index + keys[event.key]!);
    else return;
    event.preventDefault();
  };
  const main = (
    <div ref={stage} className={cx("relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden", compact ? "bg-raised" : "bg-raised p-4")}>
      {deck && slide && slideWidth ? <SlideView deck={deck} slide={slide} urls={urls} width={slideWidth} /> : <Spinner />}
    </div>
  );
  const arrows = (
    <>
      <button type="button" className="icon-btn" aria-label="Previous slide" title="Previous slide" disabled={index === 0} onClick={() => go(index - 1)}>
        <ChevronLeft size={15} />
      </button>
      <span className="tabular-nums" aria-live="polite">
        {count ? `${index + 1} / ${count}` : "…"}
      </span>
      <button type="button" className="icon-btn" aria-label="Next slide" title="Next slide" disabled={index >= count - 1} onClick={() => go(index + 1)}>
        <ChevronRight size={15} />
      </button>
    </>
  );

  if (compact) {
    return (
      <div className="relative flex h-full flex-col outline-none" tabIndex={0} onKeyDown={onKeyDown} aria-label={`${file.filename}, slide ${index + 1} of ${count}`} data-pptx-compact>
        {main}
        {count > 1 ? <div className="absolute bottom-2 right-2 flex items-center gap-1 rounded-md bg-panel/90 px-1 text-[12px] text-muted shadow-sm">{arrows}</div> : null}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col outline-none" tabIndex={0} onKeyDown={onKeyDown} aria-label={`${file.filename} slides`} data-pptx-viewer>
      <Toolbar>
        {arrows}
        {slide?.hidden ? (
          <span className="ml-2 inline-flex items-center gap-1 text-faint">
            <EyeOff size={13} aria-hidden /> Hidden in the slideshow
          </span>
        ) : null}
        <span className="ml-auto pr-1 text-faint">← → to move between slides</span>
      </Toolbar>
      <div className="flex min-h-0 flex-1">
        <div ref={strip} className="hidden w-[176px] shrink-0 space-y-3 overflow-y-auto border-r border-line p-3 sm:block" aria-label="Slides">
          {deck?.slides.map((entry, number) => (
            <button
              key={entry.number}
              type="button"
              data-thumb={number}
              onClick={() => go(number)}
              aria-current={number === index ? "true" : undefined}
              aria-label={`Slide ${entry.number}`}
              className={cx("flex w-full items-start gap-1.5 rounded-md p-1 text-left", number === index ? "bg-accent-soft ring-1 ring-accent" : "hover:bg-hover")}
              style={{ contentVisibility: "auto", containIntrinsicSize: `auto ${Math.round((136 * deck.height) / deck.width) + 8}px` }}
            >
              <span className="w-4 shrink-0 pt-0.5 text-right text-[11px] text-faint">{entry.number}</span>
              <span className={cx("pointer-events-none", entry.hidden && "opacity-50")}>
                <SlideView deck={deck} slide={entry} urls={urls} width={128} />
              </span>
            </button>
          ))}
        </div>
        {main}
      </div>
    </div>
  );
}
