"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { Minus, MoveHorizontal, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Spinner } from "../../ui";
import { Toolbar, ViewerNote, type ViewerProps } from "./shared";

const SAFE_LINK = /^(https?:|mailto:)/i;
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2];

function viewerStyles(background: string, compact: boolean): string {
  return `
html,body{margin:0;background:${background};-webkit-text-size-adjust:none;text-size-adjust:none;}
body{overflow:${compact ? "hidden" : "auto"};}
.docx-wrapper{background:transparent!important;padding:${compact ? "0" : "16px"}!important;}
.docx-wrapper>section.docx{box-shadow:0 1px 4px rgba(0,0,0,.18);margin:0 auto ${compact ? "0" : "16px"}!important;}
a{color:#0563c1;}
body[data-reading=true] .docx-wrapper{padding:0!important;width:100%!important;transform:none!important;}
body[data-reading=true] section.docx{width:100%!important;min-height:0!important;height:auto!important;padding:24px 20px!important;box-sizing:border-box;box-shadow:none;}
body[data-reading=true] article{column-count:1!important;column-width:auto!important;}
body[data-reading=true] p{height:auto!important;min-height:0!important;line-height:1.6!important;margin-top:0!important;margin-bottom:.8em!important;text-indent:0!important;}
body[data-reading=true] p,body[data-reading=true] span{font-size:16px!important;line-height:1.6!important;}
body[data-reading=true] table{max-width:100%!important;table-layout:fixed;}
body[data-reading=true] td{height:auto!important;overflow-wrap:anywhere;}
body[data-reading=true] img{max-width:100%!important;height:auto!important;}

`;
}

function frameDocument(background: string, compact: boolean): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${viewerStyles(background, compact)}</style></head><body></body></html>`;
}

/** Keeps links to web pages and email (opened in a new tab) and in-document jumps; any other link loses its target. */
function tidyLinks(doc: Document): void {
  doc.querySelectorAll("a[href]").forEach((link) => {
    const href = link.getAttribute("href") ?? "";
    if (href.startsWith("#")) return;
    if (SAFE_LINK.test(href)) {
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
    } else link.removeAttribute("href");
  });
  doc.querySelectorAll("script, iframe, object, embed, form").forEach((node) => node.remove());
}

/**
 * Word documents drawn by docx-preview inside a sandboxed frame: the frame cannot run
 * scripts, so nothing in the file can, and its styles stay out of the app.
 */
export default function DocxViewer({ file, bytes, compact }: ViewerProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [rendered, setRendered] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [phone, setPhone] = useState(false);
  const [mode, setMode] = useState<"auto" | "reading" | "page">("auto");
  const reading = !compact && (mode === "reading" || (mode === "auto" && phone));
  const [pageWidth, setPageWidth] = useState(816);
  const [background] = useState(() =>
    typeof window === "undefined" ? "#efebe4" : getComputedStyle(document.documentElement).getPropertyValue("--raised").trim() || "#efebe4",
  );

  useEffect(() => {
    const doc = frame.current?.contentDocument;
    if (!loaded || !doc) return;
    let live = true;
    setRendered(false);
    setError(null);
    doc.body.replaceChildren();
    delete doc.body.dataset.reading;
    doc.body.style.removeProperty("zoom");
    void import("docx-preview")
      .then(({ renderAsync }) =>
        renderAsync(bytes, doc.body, doc.head, {
          inWrapper: true,
          breakPages: true,
          ignoreWidth: false,
          ignoreHeight: false,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: !compact,
          renderEndnotes: !compact,
          renderComments: false,
          renderChanges: false,
          renderAltChunks: false,
          useBase64URL: true,
          experimental: false,
        }),
      )
      .then(() => {
        if (!live) return;
        tidyLinks(doc);
        // docx-preview replaces its style container, including the frame's initial styles.
        const style = doc.createElement("style");
        style.textContent = viewerStyles(background, Boolean(compact));
        doc.head.append(style);
        const wrapper = doc.querySelector<HTMLElement>(".docx-wrapper");
        if (wrapper) {
          const viewport = doc.createElement("div");
          viewport.dataset.docxViewport = "";
          wrapper.replaceWith(viewport);
          viewport.append(wrapper);
        }
        // Measured before any zoom is applied, so fitting never feeds back on itself.
        setPageWidth(doc.querySelector<HTMLElement>("section.docx")?.offsetWidth || 816);
        setRendered(true);
      })
      .catch(() => {
        if (live) setError("This Word file could not be shown. It may be damaged, password-protected, or an older .doc saved with a .docx name.");
      });
    return () => {
      live = false;
    };
  }, [loaded, bytes, compact]);

  const [fitScale, setFitScale] = useState(1);
  useEffect(() => {
    const node = frame.current;
    if (!node || !rendered) return;
    const measure = () => { setPhone(node.clientWidth < 600); setFitScale(Math.max(0.2, Math.min(compact ? 1 : 1.5, (node.clientWidth - (compact ? 0 : 40)) / pageWidth))); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [rendered, compact, pageWidth]);

  const scale = zoom === "fit" ? Math.min(1, fitScale) : zoom;
  useEffect(() => {
    const node = frame.current;
    const body = node?.contentDocument?.body;
    const wrapper = body?.querySelector<HTMLElement>(".docx-wrapper");
    const viewport = body?.querySelector<HTMLElement>("[data-docx-viewport]");
    if (!body || !wrapper || !viewport || !rendered || !node) return;
    body.dataset.reading = String(reading);
    body.style.removeProperty("zoom");
    wrapper.style.transformOrigin = "top left";
    wrapper.style.transform = reading ? "none" : `scale(${scale})`;
    wrapper.style.width = reading ? "100%" : `${Math.max(pageWidth + (compact ? 0 : 32), node.clientWidth / scale)}px`;
    wrapper.style.boxSizing = "border-box";
    const size = () => {
      viewport.style.overflow = reading ? "visible" : "hidden";
      viewport.style.width = reading ? "100%" : `${wrapper.offsetWidth * scale}px`;
      viewport.style.height = reading ? "auto" : `${wrapper.scrollHeight * scale}px`;
    };
    size();
    const observer = new ResizeObserver(size);
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, [scale, rendered, reading, pageWidth, compact, phone]);

  if (error) return <ViewerNote title={error} file={file} bytes={bytes} compact={compact} />;

  const view = (
    <div className="relative min-h-0 flex-1">
      <iframe
        ref={frame}
        title={`${file.filename} preview`}
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        srcDoc={frameDocument(background, compact)}
        onLoad={() => setLoaded(true)}
        className="block h-full w-full border-0"
        tabIndex={compact ? -1 : 0}
      />
      {rendered ? null : (
        <span className="absolute inset-0 flex items-center justify-center">
          <Spinner />
        </span>
      )}
    </div>
  );
  if (compact) return <div className="flex h-full flex-col">{view}</div>;

  const step = (direction: 1 | -1) => {
    const next = direction > 0 ? ZOOMS.find((value) => value > scale + 0.01) : [...ZOOMS].reverse().find((value) => value < scale - 0.01);
    setZoom(next ?? scale);
  };
  return (
    <div className="flex h-full min-h-0 flex-col" data-docx-viewer>
      <Toolbar>
        <span className="px-1 max-sm:hidden">Word document</span>
        <button type="button" className="btn-ghost" aria-pressed={reading} onClick={() => setMode(reading ? "page" : "reading")}>{reading ? "Page view" : "Reading view"}</button>
        <span className="ml-auto flex items-center gap-1" style={{ display: reading ? "none" : undefined }}>
          <button type="button" className="icon-btn" aria-label="Zoom out" title="Zoom out" onClick={() => step(-1)}>
            <Minus size={14} />
          </button>
          <span className="w-11 text-center tabular-nums">{Math.round(scale * 100)}%</span>
          <button type="button" className="icon-btn" aria-label="Zoom in" title="Zoom in" onClick={() => step(1)}>
            <Plus size={14} />
          </button>
          <button type="button" className="btn-ghost" aria-pressed={zoom === "fit"} onClick={() => setZoom("fit")}>
            <MoveHorizontal size={13} aria-hidden /> Fit width
          </button>
        </span>
      </Toolbar>
      {view}
    </div>
  );
}
