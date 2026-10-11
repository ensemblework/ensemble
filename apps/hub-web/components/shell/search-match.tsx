"use client";

import { usePathname } from "next/navigation";
import { Fragment, useEffect } from "react";

export function searchHitHref(path: string, query: string): string {
  const url = new URL(path, "https://ensemble.invalid");
  url.searchParams.set("match", query);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function matchParts(text: string, query: string): { text: string; matched: boolean }[] {
  if (!query) return [{ text, matched: false }];
  const parts: { text: string; matched: boolean }[] = [];
  let from = 0, index = 0;
  while ((index = text.toLowerCase().indexOf(query.toLowerCase(), from)) !== -1) {
    if (index > from) parts.push({ text: text.slice(from, index), matched: false });
    parts.push({ text: text.slice(index, index + query.length), matched: true });
    from = index + query.length;
  }
  if (from < text.length) parts.push({ text: text.slice(from), matched: false });
  return parts;
}

export function HighlightMatch({ text, query }: { text: string; query: string }) {
  return <>{matchParts(text, query).map((part, i) => <Fragment key={i}>{part.matched ? <mark className="search-match">{part.text}</mark> : part.text}</Fragment>)}</>;
}

/** Paint ranges without altering the editor's document or its saved content. */
export function SearchLanding() {
  const pathname = usePathname();
  useEffect(() => {
    let teardown = () => {};
    let last = "";
    const sync = () => {
      const key = `${window.location.pathname}${window.location.search}`;
      if (key === last) return;
      last = key;
      teardown();
      const query = new URLSearchParams(window.location.search).get("match")?.trim();
      if (!query) return;
      const root = document.querySelector("main");
      if (!root) return;
      let finished = false;
      let clear: ReturnType<typeof setTimeout> | undefined;
      const overlays: HTMLElement[] = [];
      let removeScrollListener = () => {};
      const paint = () => {
        if (finished) return;
        const nodes: Text[] = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode(node) {
          const el = node.parentElement;
          return el && el.getClientRects().length && !el.closest("button, script, style, [aria-hidden=true], .skeleton") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        } });
        while (walker.nextNode()) nodes.push(walker.currentNode as Text);
        const hay = nodes.map((n) => n.textContent ?? "").join("");
        const parts = matchParts(hay, query);
        let offset = 0;
        const ranges: Range[] = [];
        for (const part of parts) {
          if (part.matched && ranges.length < 40) {
            const range = document.createRange();
            let at = 0;
            for (const node of nodes) {
              const end = at + node.length;
              if (offset >= at && offset < end) range.setStart(node, offset - at);
              if (offset + part.text.length > at && offset + part.text.length <= end) { range.setEnd(node, offset + part.text.length - at); break; }
              at = end;
            }
            ranges.push(range);
          }
          offset += part.text.length;
        }
        const field = [...root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input:not([type=search]), textarea")].find((el) => el.getClientRects().length && !el.closest("[hidden], [aria-hidden=true]") && el.value.toLowerCase().includes(query.toLowerCase()));
        if (!ranges.length && !field) return;
        finished = true;
        observer.disconnect();
        (ranges[0]?.startContainer.parentElement ?? field)?.scrollIntoView({ block: "center", behavior: "instant" });
        if (ranges.length && typeof Highlight !== "undefined" && CSS.highlights) CSS.highlights.set("ensemble-search", new Highlight(...ranges));
        else for (const range of ranges) for (const rect of range.getClientRects()) {
          const el = document.createElement("span");
          el.className = "search-match-overlay";
          Object.assign(el.style, { top: `${rect.top}px`, left: `${rect.left}px`, width: `${rect.width}px`, height: `${rect.height}px` });
          document.body.appendChild(el); overlays.push(el);
        }
        if (field && !ranges.length) {
          const rect = field.getBoundingClientRect(), style = getComputedStyle(field);
          const mirror = document.createElement("div");
          Object.assign(mirror.style, { position:"fixed", top:`${rect.top}px`, left:`${rect.left}px`, width:`${rect.width}px`, padding:style.padding, border:style.border, boxSizing:style.boxSizing, font:style.font, letterSpacing:style.letterSpacing, lineHeight:style.lineHeight, whiteSpace: field.tagName === "TEXTAREA" ? "pre-wrap" : "pre", overflowWrap:"break-word", opacity:"0", pointerEvents:"none" });
          mirror.textContent = field.value;
          document.body.appendChild(mirror);
          const node = mirror.firstChild!;
          for (let at = field.value.toLowerCase().indexOf(query.toLowerCase()); at !== -1; at = field.value.toLowerCase().indexOf(query.toLowerCase(), at + query.length)) {
            const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + query.length);
            for (const box of range.getClientRects()) {
              const el = document.createElement("span"); el.className = "search-match-overlay";
              Object.assign(el.style, { top:`${box.top}px`, left:`${box.left}px`, width:`${box.width}px`, height:`${box.height}px` });
              document.body.appendChild(el); overlays.push(el);
            }
          }
          mirror.remove();
        }
        root.setAttribute("data-search-match-active", query);
        const removeOverlays = () => overlays.forEach((el) => el.remove());
        window.addEventListener("wheel", removeOverlays, { once:true, capture:true });
        window.addEventListener("touchstart", removeOverlays, { once:true, capture:true });
        removeScrollListener = () => { window.removeEventListener("wheel", removeOverlays, true); window.removeEventListener("touchstart", removeOverlays, true); };
        clear = setTimeout(() => { root.removeAttribute("data-search-match-active"); CSS.highlights?.delete("ensemble-search"); overlays.forEach((el) => el.remove()); removeScrollListener(); }, 1800);
      };
      const observer = new MutationObserver(paint);
      observer.observe(root, { childList: true, subtree: true, characterData: true });
      const start = setTimeout(paint, 100);
      const timeout = setTimeout(() => observer.disconnect(), 10_000);
      teardown = () => { root.removeAttribute("data-search-match-active"); clearTimeout(start); clearTimeout(timeout); clearTimeout(clear); removeScrollListener(); observer.disconnect(); CSS.highlights?.delete("ensemble-search"); overlays.forEach((el) => el.remove()); };
    };
    sync();
    const timer = window.setInterval(sync, 200);
    return () => { window.clearInterval(timer); teardown(); };
  }, [pathname]);
  return null;
}
