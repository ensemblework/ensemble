/** @jsxRuntime automatic */
/** @jsxImportSource react */
"use client";

import { PanelLeft, PanelRight, X } from "lucide-react";
import { createPortal } from "react-dom";
import { ModalScope } from "../ui";
import { useModalFocus } from "@/lib/modal-focus";
import { useEffect, useRef, useState } from "react";
import { PagesBrowser } from "./pages-nav";

/** A flex sibling of the content area, so page peeks never cover this tree. */
export function PagesPanel({ side, onClose, onSide }: { side: "left" | "right"; onClose: () => void; onSide: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const read = () => setMobile(media.matches);
    read(); media.addEventListener("change", read);
    return () => media.removeEventListener("change", read);
  }, []);
  useModalFocus(ref, mobile, onClose);
  const panel = <aside className="pages-panel flex h-full shrink-0 flex-col border-line bg-sidebar" data-side={side} aria-label="Pages browser" onKeyDown={(event) => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); onClose(); } }}>
    <div className="flex items-center gap-2 px-4 pb-4 pt-5">
      <h2 className="flex-1 text-[16px] font-semibold tracking-tight">Pages</h2>
      <button type="button" className="icon-btn" aria-label={`Move pages panel ${side === "left" ? "right" : "left"}`} title={`Move to the ${side === "left" ? "right" : "left"}`} onClick={onSide}>{side === "left" ? <PanelRight size={15} /> : <PanelLeft size={15} />}</button>
      <button type="button" className="icon-btn" aria-label="Close pages browser" onClick={onClose}><X size={16} /></button>
    </div>
    <PagesBrowser />
  </aside>;
  if (!mobile) return panel;
  return createPortal(<ModalScope.Provider value="pages-browser"><div ref={ref} role="dialog" aria-modal="true" aria-label="Pages browser" tabIndex={-1} data-modal-layer="pages-browser" className="fixed inset-0 z-[65] bg-black/35" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>{panel}</div></ModalScope.Provider>, document.body);
}
