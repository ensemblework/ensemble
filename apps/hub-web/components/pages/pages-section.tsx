"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { CheckSquare, ChevronRight, Import, FileText, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { cx } from "../ui";

export type PageLinkProps = {
  href: string;
  className?: string;
  title?: string;
  children: React.ReactNode;
};

export type PageListItem = { id: string; title: string; parentId?: string | null };

export function pageTreeOrder(pages: PageListItem[]): Array<PageListItem & { depth: number }> {
  const byId = new Map(pages.map((page) => [page.id, page]));
  const visited = new Set<string>();
  const ordered: Array<PageListItem & { depth: number }> = [];
  const children = new Map<string, PageListItem[]>();
  for (const page of pages) if (page.parentId && byId.has(page.parentId)) children.set(page.parentId, [...(children.get(page.parentId) ?? []), page]);
  const walk = (page: PageListItem, depth: number) => {
    if (visited.has(page.id)) return;
    visited.add(page.id);
    ordered.push({ ...page, depth });
    for (const child of children.get(page.id) ?? []) walk(child, depth + 1);
  };
  for (const page of pages) if (!page.parentId || !byId.has(page.parentId)) walk(page, 0);
  for (const page of pages) if (!visited.has(page.id)) walk(page, 0);
  return ordered;
}

/**
 * The Pages section in the left nav. The shell passes next/link so each row
 * navigates with Link, and the + button opens the new note with router.push.
 */
export function PagesSection({
  pages,
  pathname,
  onCreate,
  onRename,
  onDelete,
  onImport,
  onDeleteMany,
  renderLink,
}: {
  pages: PageListItem[];
  pathname: string;
  onCreate: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  /** Opens the Notion import. Left out where imports are not available. */
  onImport?: () => void;
  onDeleteMany?: (ids: string[]) => void;
  renderLink: (props: PageLinkProps) => React.ReactNode;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useState("");
  const byId = new Map(pages.map((page) => [page.id, page]));
  const parents = new Set(pages.map((page) => page.parentId).filter(Boolean));
  const visible = pageTreeOrder(pages).filter((page) => {
    if (search.trim()) return page.title.toLowerCase().includes(search.trim().toLowerCase());
    const seen = new Set([page.id]);
    let parent = page.parentId;
    while (parent && byId.has(parent) && !seen.has(parent)) {
      if (!expanded.has(parent)) return false;
      seen.add(parent);
      parent = byId.get(parent)?.parentId;
    }
    return true;
  });

  const commitRename = (page: PageListItem, value: string) => {
    const title = value.trim();
    setEditingId(null);
    if (title && title !== page.title) onRename(page.id, title);
  };

  return (
    <nav className="pages-browser flex min-h-0 flex-1 flex-col px-3 pb-3" aria-label="Page tree">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[12px] font-medium text-muted">{pages.length} pages</span>
        <span className="flex items-center">
          {onDeleteMany ? <button type="button" className="icon-btn" aria-label="Select pages" title="Select pages for bulk deletion" aria-pressed={selecting} onClick={() => { setSelecting(!selecting); setSelected([]); }}><CheckSquare size={13} /></button> : null}
          {onImport ? (
            <button type="button" className="icon-btn" aria-label="Import from Notion" title="Import from Notion…" onClick={onImport}>
              <Import size={14} />
            </button>
          ) : null}
          <button type="button" className="icon-btn" aria-label="New page" title="New page" onClick={() => { onCreate(); }}>
            <Plus size={14} />
          </button>
        </span>
      </div>
      <input aria-label="Find a page" placeholder="Find a page…" type="search" value={search} onChange={(event) => setSearch(event.target.value)} className="field mb-3 w-full text-[13px]" />
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
        {pages.length > 0 && visible.length === 0 ? <p className="py-4 text-[13px] text-muted">No matching pages</p> : null}
        {pages.length === 0 ? <p className="px-2 py-1 text-[12.5px] text-faint">No pages yet</p> : null}
        {selecting && selected.length ? <button type="button" className="btn-ghost text-danger" onClick={() => { onDeleteMany?.(selected); setSelected([]); setSelecting(false); }}><Trash2 size={13} /> Delete {selected.length} pages</button> : null}
        {visible.map((page) => {
          const href = `/pages/${page.id}`;
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <div key={page.id} style={{ marginLeft: Math.min(page.depth, 8) * 12 }} className={cx("group flex items-center gap-1 rounded-lg pr-1", active && "bg-hover")}>
              {parents.has(page.id) ? <button type="button" className="icon-btn size-6 shrink-0" aria-label={`${expanded.has(page.id) ? "Collapse" : "Expand"} ${page.title}`} aria-expanded={expanded.has(page.id)} onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(page.id)) next.delete(page.id); else next.add(page.id); return next; })}><ChevronRight size={13} className={expanded.has(page.id) ? "rotate-90" : undefined} /></button> : <span className="w-6 shrink-0" />}
              {selecting ? <input type="checkbox" aria-label={`Select ${page.title}`} checked={selected.includes(page.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, page.id] : current.filter((id) => id !== page.id))} /> : null}
              {editingId === page.id ? (
                <input
                  autoFocus
                  aria-label={`Rename ${page.title}`}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onBlur={(event) => commitRename(page, event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitRename(page, event.currentTarget.value);
                    }
                    if (event.key === "Escape") setEditingId(null);
                  }}
                  className="field mx-1 my-0.5 min-w-0 flex-1 px-1.5 py-1 text-[13px]"
                />
              ) : (
                renderLink({
                  href,
                  title: page.title,
                  className: cx(
                    "nav-link row-tile flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-[6px] text-[13.5px]",
                    active ? "font-medium text-ink" : "text-ink/80",
                  ),
                  children: (
                    <>
                      <FileText size={16} strokeWidth={1.8} className="text-muted" />
                      <span className="min-w-0 flex-1 truncate">{page.title || "Untitled"}</span>
                    </>
                  ),
                })
              )}
              {editingId === page.id ? null : (
                <span className="flex shrink-0 items-center opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Rename ${page.title}`}
                    title="Rename"
                    onClick={() => {
                      setDraft(page.title);
                      setEditingId(page.id);
                    }}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Delete ${page.title}`}
                    title="Delete"
                    onClick={() => onDelete(page.id)}
                  >
                    <Trash2 size={13} />
                  </button>
                </span>
              )}
            </div>
          );
        })}
      </div>

    </nav>
  );
}
