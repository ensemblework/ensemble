/** @jsxRuntime automatic */
/** @jsxImportSource react */
"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, ChevronRight, Columns3, FileText } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { plural, relative, shortDate } from "@/lib/format";
import { usePersistentState } from "@/lib/prefs";
import { PageHeader, SkeletonRows } from "@/components/ui";
import { LoadError } from "@/components/load-error";
import { PAGE_SORTS, PAGE_STEP, isPageSort, parentTrail, searchPages, type PageSort } from "@/components/pages/pages-list";
import { boardHref, boardPageHref, groupBoardPages } from "@/lib/page-boards";
import type { DirectoryPage } from "@ensemble/shared-types";

export default function PagesPage() {
  const pages = useQuery({ queryKey: ["pages", "directory"], queryFn: api.pageDirectory });
  const [stored, setStored] = usePersistentState<string>("ensemble.pages.sort", "edited");
  const sort: PageSort = isPageSort(stored) ? stored : "edited";
  const [query, setQuery] = useState("");
  const [typed, setTyped] = useState("");
  const [shown, setShown] = useState(PAGE_STEP);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(typed.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [typed]);
  useEffect(() => setShown(PAGE_STEP), [query, sort]);
  // Titles match on this computer at once; the server adds pages whose text matches.
  const text = useQuery({ queryKey: ["pages", "directory", "search", query], queryFn: () => api.searchPageDirectory(query), enabled: query.length >= 2, staleTime: 30_000 });
  const all = useMemo(() => pages.data?.pages ?? [], [pages.data]);
  const byId = useMemo(() => new Map(all.map((page) => [page.id, page])), [all]);
  const current = query === typed.trim();
  const hits = useMemo(() => new Map(current ? (text.data?.pages ?? []).map((page) => [page.id, page.snippet ?? ""]) : []), [text.data, current]);
  const found = useMemo(() => searchPages(all, typed, sort, hits), [all, typed, sort, hits]);
  const grouped = groupBoardPages(found);
  const visible = grouped.independent.slice(0, shown);
  const left = grouped.independent.length - visible.length;
  const searching = Boolean(typed.trim());

  const showMore = () => {
    const first = visible.length;
    setShown((count) => count + PAGE_STEP);
    // Keyboard users land on the first new row, not back at the top.
    window.requestAnimationFrame(() => list.current?.querySelectorAll<HTMLAnchorElement>("a")[first]?.focus());
  };

  const row = (page: DirectoryPage) => {
    const trail = parentTrail(page, byId);
    const when = sort === "created" && page.createdAt ? `Created ${shortDate(page.createdAt)}` : `Edited ${relative(page.updatedAt)}`;
    return <li key={page.id}>
      <Link href={boardPageHref(page)} className="tile group flex items-start gap-3 rounded-xl bg-panel px-4 py-3">
        <FileText size={18} className="mt-0.5 shrink-0 text-muted" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{page.title || "Untitled"}</span>
          {page.snippet ? <span className="mt-0.5 block line-clamp-2 text-[12.5px] text-muted">{page.snippet}</span> : null}
          <span className="mt-0.5 block truncate text-[12px] text-faint">{trail ? `In ${trail} · ` : ""}{when}</span>
        </span>
        <ArrowUpRight size={15} className="mt-0.5 shrink-0 text-faint group-hover:text-ink" aria-hidden />
      </Link>
    </li>;
  };

  return <div className="mx-auto max-w-4xl px-6 pb-20 pt-10 sm:px-10">
    <PageHeader title="Pages" description="Independent writing up front. Board pages, neatly tucked away below." />
    {pages.error ? <LoadError error={pages.error} what="your pages" retrying={pages.isFetching} onRetry={() => { void pages.refetch(); }} /> : pages.isLoading ? <SkeletonRows count={3} /> : <>
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <input
          type="search"
          aria-label="Search pages"
          placeholder="Search titles and text…"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Escape" && typed) { event.preventDefault(); event.stopPropagation(); setTyped(""); } }}
          className="field min-w-0 flex-1 basis-[14rem] text-[13.5px]"
        />
        <label className="flex items-center gap-2 text-[12.5px] text-muted">
          Sort
          <select className="field py-1 text-[13px]" value={sort} onChange={(event) => setStored(event.target.value)}>
            {PAGE_SORTS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </label>
      </div>
      <p className="mt-3 text-[12.5px] text-muted" role="status" aria-live="polite">
        {searching
          ? `${plural(found.length, "page")} match${found.length === 1 ? "es" : ""}${text.isFetching ? " · searching page text…" : ""}`
          : plural(all.length, "page")}
      </p>
      {visible.length ? <ul ref={list} className="mt-2 flex flex-col gap-2">{visible.map(row)}</ul> : <p className="mt-4 text-[14px] text-muted">{searching ? (text.isFetching ? "Searching page text…" : found.length ? "Matching pages are grouped by board below." : "No page title or text matches that search.") : grouped.boards.length ? "Your board pages are below. Create a page for independent notes." : "Create a page or import from Notion using the pages panel."}</p>}
      {left > 0 ? <button type="button" className="btn mt-4" onClick={showMore}>Show {Math.min(PAGE_STEP, left)} more <span className="text-muted">({left} left)</span></button> : null}
      {grouped.boards.length > 0 && <div className="mt-8 space-y-3">
        <h2 className="mb-3 text-[11px] font-medium uppercase tracking-widest text-muted">Pages in boards</h2>
        {grouped.boards.map((group) => <details key={group.id} className="group/board rounded-xl border border-line bg-panel/30" open={searching || undefined}>
          <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-4 text-[14px]"><ChevronRight size={15} className="text-muted group-open/board:rotate-90" /><Columns3 size={17} className="text-muted" /><span className="min-w-0 flex-1 truncate font-medium">{group.title}</span><span className="text-[12px] text-muted">{plural(group.pages.length, "page")}</span></summary>
          <div className="px-3 pb-3"><Link href={group.id === "ensemble" ? "/board" : boardHref(group.id)} className="mb-3 ml-1 inline-flex items-center gap-1 text-[12px] text-muted hover:text-ink">Open board<ArrowUpRight size={12} /></Link>
            <ul className="flex flex-col gap-2">{group.pages.slice(0, shown).map(row)}</ul>
            {group.pages.length > shown && <button type="button" className="btn mt-3" onClick={() => setShown((count) => count + PAGE_STEP)}>Show more pages in {group.title}</button>}
          </div>
        </details>)}
      </div>}
    </>}
  </div>;
}
