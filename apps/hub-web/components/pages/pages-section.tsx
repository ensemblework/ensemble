"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { ChevronRight, FileText, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { setSidebarRail } from "@/lib/sidebar-rail";
import { Dialog, cx } from "../ui";

export type PageLinkProps = {
  href: string;
  className?: string;
  title?: string;
  children: React.ReactNode;
};

export type PageListItem = { id: string; title: string };

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
  renderLink,
}: {
  pages: PageListItem[];
  pathname: string;
  onCreate: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  renderLink: (props: PageLinkProps) => React.ReactNode;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingDelete, setPendingDelete] = useState<PageListItem | null>(null);
  // Collapsed on every load so a long list never pushes the app's nav down. Opening a note shows its row.
  const [expanded, setExpanded] = useState(() => pathname.startsWith("/pages/"));

  const commitRename = (page: PageListItem, value: string) => {
    const title = value.trim();
    setEditingId(null);
    if (title && title !== page.title) onRename(page.id, title);
  };

  // The rail has no room for a list. Its Pages icon opens the sidebar with the list showing.
  useEffect(() => {
    const show = () => setExpanded(true);
    window.addEventListener("ensemble:pages-open", show);
    return () => window.removeEventListener("ensemble:pages-open", show);
  }, []);

  return (
    <nav className="pages-nav mt-2 flex min-h-0 flex-col px-2" aria-label="Pages">
      <button
        type="button"
        className="pages-rail nav-link row-tile items-center rounded-lg py-[6px]"
        title="Pages"
        aria-label="Show pages"
        onClick={() => {
          setSidebarRail(false);
          window.dispatchEvent(new CustomEvent("ensemble:pages-open"));
        }}
      >
        <FileText size={16} strokeWidth={1.8} className="text-muted" />
      </button>
      <div className="sidebar-kicker page-kicker mx-2 mb-1 flex items-center justify-between">
        <button type="button" className="flex items-center gap-1 py-1 hover:text-ink" aria-label="Toggle pages" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          <ChevronRight size={12} className={expanded ? "rotate-90" : undefined} />
          <span>Pages</span>
        </button>
        <button type="button" className="icon-btn" aria-label="New page" title="New page" onClick={() => { setExpanded(true); onCreate(); }}>
          <Plus size={14} />
        </button>
      </div>
      <div hidden={!expanded} className={expanded ? "flex max-h-48 flex-col gap-0.5 overflow-y-auto" : "hidden"}>
        {pages.length === 0 ? <p className="sidebar-label px-2 py-1 text-[12.5px] text-faint">No pages yet</p> : null}
        {pages.map((page) => {
          const href = `/pages/${page.id}`;
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <div key={page.id} className={cx("group flex items-center gap-1 rounded-lg pr-1", active && "bg-hover")}>
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
                      <span className="sidebar-label min-w-0 flex-1 truncate">{page.title || "Untitled"}</span>
                    </>
                  ),
                })
              )}
              {editingId === page.id ? null : (
                <span className="sidebar-label flex shrink-0 items-center opacity-0 group-hover:opacity-100 focus-within:opacity-100">
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
                    onClick={() => setPendingDelete(page)}
                  >
                    <Trash2 size={13} />
                  </button>
                </span>
              )}
            </div>
          );
        })}
      </div>
      <Dialog open={Boolean(pendingDelete)} onClose={() => setPendingDelete(null)} title="Delete this page?" width={420}>
        <p className="text-[13.5px] leading-5 text-muted">
          Delete “{pendingDelete?.title || "Untitled"}”? This moves the note to Trash. You can restore it there until the configured retention period expires.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={() => setPendingDelete(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              if (!pendingDelete) return;
              const id = pendingDelete.id;
              setPendingDelete(null);
              onDelete(id);
            }}
          >
            Delete page
          </button>
        </div>
      </Dialog>
    </nav>
  );
}
