"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, FileText, Search, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { SearchQuery } from "@/components/motion/search-query";
import { cx } from "@/components/ui";
import { HighlightMatch, searchHitHref } from "./search-match";

export function AskBar() {
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [submitted, setSubmitted] = useState<string|null>(null);
  // Below 640 px the field is a button; pressing it lays the field over the whole top bar.
  const [expanded, setExpanded] = useState(false);
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
    const focus = () => { setOpen(true); setExpanded(true); input.current?.focus(); };
    const outside = (event: PointerEvent) => {
      const target = event.target as Element;
      if (!root.current?.contains(target) && !target.closest("[data-workspace-search-results]")) { setSubmitted(null); setOpen(false); setExpanded(false); }
    };
    window.addEventListener("ensemble:ask", focus);
    document.addEventListener("pointerdown", outside);
    return () => { window.removeEventListener("ensemble:ask", focus); document.removeEventListener("pointerdown", outside); };
  }, []);
  useEffect(() => {
    if (!open || !submitted || submitted !== debounced || !current || found.isPending) return;
    setSubmitted(null);
    if (hits.length === 1) { document.getElementById("workspace-link-0")?.click(); setOpen(false); }
  }, [open, submitted, debounced, current, found.isPending, hits.length]);
  useEffect(() => {
    document.getElementById(`workspace-hit-${selected}`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  useEffect(() => { if (expanded) input.current?.focus(); }, [expanded]);
  const collapse = () => { setSubmitted(null); setOpen(false); setExpanded(false); };
  return <div ref={root} className="relative flex w-full min-w-0 max-w-[560px] justify-end max-sm:static"
    onBlur={(event) => {
      const next = event.relatedTarget as Element | null;
      if (next && !event.currentTarget.contains(next) && !next.closest("[data-workspace-search-results]")) setExpanded(false);
    }}>
    {expanded ? null : <button type="button" className="icon-btn sm:hidden" aria-label="Ask Ensemble · search your work" title="Ask Ensemble · search your work" onClick={() => { setOpen(true); setExpanded(true); }}><Search size={16} /></button>}
    <div className={cx("flex w-full min-w-0 items-center", expanded ? "max-sm:absolute max-sm:inset-0 max-sm:z-50 max-sm:gap-1 max-sm:bg-bg max-sm:px-2" : "max-sm:hidden")}>
    <SearchQuery pill overlay className="min-w-0 flex-1" inputRef={input} value={query} onValue={(text) => { setSubmitted(null); setQuery(text); setOpen(true); }} onFocus={() => setOpen(true)}
      placeholder="Ask Ensemble · search your work" label="Ask Ensemble · search your work"
      pending={pending} count={open && current && Boolean(debounced) && !found.isPending ? hits.length : null} list={open && hits.length > 0}
      controls="workspace-search-results" activeDescendant={hits[selected] ? `workspace-hit-${selected}` : undefined}
      status={pending ? "Searching your workspace…" : `${hits.length} matches · Enter to open`}
      emptyTitle={found.isError ? "Search couldn’t load." : `No matches for “${query.trim()}”.`}
      emptyHint={found.isError ? "Try again in a moment." : "Search a title or a phrase inside pages, tasks, diagrams, or meeting notes."}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); collapse(); input.current?.blur(); }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setIndex((n) => Math.max(0, Math.min(hits.length - 1, n + (event.key === "ArrowDown" ? 1 : -1)))); }
      }}
      onSubmit={() => { if (current && found.isSuccess && hits[selected]) { document.getElementById(`workspace-link-${selected}`)?.click(); setOpen(false); } else if (query.trim()) { setOpen(true); setDebounced(query.trim()); setSubmitted(query.trim()); } }}
      panelExtra={<div className="workspace-search-heading" data-workspace-search-results><span><Search size={12} />Your workspace</span><button type="button" aria-label="Close search results" onClick={() => { setSubmitted(null); setOpen(false); }}><X size={14} /></button></div>}
      resultsId="workspace-search-results" resultsClassName="workspace-search-results" results={hits.map((hit, i) => <li key={hit.path} id={`workspace-hit-${i}`} role="option" aria-selected={i === selected} className="sq-item" data-workspace-search-results>
        <Link id={`workspace-link-${i}`} href={searchHitHref(hit.path, query.trim())} className="workspace-search-hit" onMouseEnter={() => setIndex(i)} onClick={collapse}>
          <FileText size={16} className="text-muted" /><span><strong><HighlightMatch text={hit.label} query={query.trim()} /></strong><small><HighlightMatch text={hit.excerpt || hit.label} query={query.trim()} /></small></span><em>{hit.kind.replace(/_/g, " ")}</em><ArrowUpRight size={13} />
        </Link>
      </li>)} />
    {expanded ? <button type="button" className="icon-btn shrink-0 sm:hidden" aria-label="Close search" onClick={collapse}><X size={16} /></button> : null}
    </div>
  </div>;
}
