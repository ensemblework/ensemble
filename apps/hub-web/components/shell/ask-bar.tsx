"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, FileText, Search, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { SearchQuery } from "@/components/motion/search-query";
import { HighlightMatch, searchHitHref } from "./search-match";

export function AskBar() {
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 180);
    setIndex(0);
    return () => window.clearTimeout(timer);
  }, [query]);
  const found = useQuery({ queryKey: ["workspace-search", debounced], queryFn: ({ signal }) => api.searchWorkspace(debounced, signal), enabled: open && Boolean(debounced), staleTime: 15_000, retry: false });
  const current = debounced === query.trim();
  const hits = current ? found.data?.results ?? [] : [];
  const pending = open && Boolean(query.trim()) && (!current || found.isPending);
  const selected = Math.min(index, Math.max(0, hits.length - 1));
  useEffect(() => {
    const focus = () => { setOpen(true); input.current?.focus(); };
    const outside = (event: PointerEvent) => {
      const target = event.target as Element;
      if (!root.current?.contains(target) && !target.closest("[data-workspace-search-results]")) setOpen(false);
    };
    window.addEventListener("ensemble:ask", focus);
    document.addEventListener("pointerdown", outside);
    return () => { window.removeEventListener("ensemble:ask", focus); document.removeEventListener("pointerdown", outside); };
  }, []);
  useEffect(() => {
    document.getElementById(`workspace-hit-${selected}`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  return <div ref={root} className="relative w-full min-w-0 max-w-[560px]">
    <SearchQuery pill overlay inputRef={input} value={query} onValue={(text) => { setQuery(text); setOpen(true); }} onFocus={() => setOpen(true)}
      placeholder="Ask Ensemble · search your work" label="Ask Ensemble · search your work"
      pending={pending} count={open && current && Boolean(debounced) && !found.isPending ? hits.length : null} list={open && hits.length > 0}
      controls="workspace-search-results" activeDescendant={hits[selected] ? `workspace-hit-${selected}` : undefined}
      status={pending ? "Searching your workspace…" : `${hits.length} matches · Enter to open`}
      emptyTitle={found.isError ? "Search couldn’t load." : `No matches for “${query.trim()}”.`}
      emptyHint={found.isError ? "Try again in a moment." : "Search a title or a phrase inside a page, task, or meeting note."}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); setOpen(false); input.current?.blur(); }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setIndex((n) => Math.max(0, Math.min(hits.length - 1, n + (event.key === "ArrowDown" ? 1 : -1)))); }
      }}
      onSubmit={() => { if (hits[selected]) { document.getElementById(`workspace-link-${selected}`)?.click(); setOpen(false); } }}
      panelExtra={<div className="workspace-search-heading" data-workspace-search-results><span><Search size={12} />Your workspace</span><button type="button" aria-label="Close search results" onClick={() => setOpen(false)}><X size={14} /></button></div>}
      resultsId="workspace-search-results" resultsClassName="workspace-search-results" results={hits.map((hit, i) => <li key={hit.path} id={`workspace-hit-${i}`} role="option" aria-selected={i === selected} className="sq-item" data-workspace-search-results>
        <Link id={`workspace-link-${i}`} href={searchHitHref(hit.path, query.trim())} className="workspace-search-hit" onMouseEnter={() => setIndex(i)} onClick={() => setOpen(false)}>
          <FileText size={16} className="text-muted" /><span><strong><HighlightMatch text={hit.label} query={query.trim()} /></strong><small><HighlightMatch text={hit.excerpt || hit.label} query={query.trim()} /></small></span><em>{hit.kind.replace(/_/g, " ")}</em><ArrowUpRight size={13} />
        </Link>
      </li>)} />
  </div>;
}
