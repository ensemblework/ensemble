"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { FileText, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
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

  const commitRename = (page: PageListItem, value: string) => {
    const title = value.trim();
    setEditingId(null);
    if (title && title !== page.title) onRename(page.id, title);
  };

  return (
    <nav className="mt-3 flex min-h-0 flex-col px-2" aria-label="Pages">
      <div className="sidebar-kicker page-kicker mx-2 mb-1 flex items-center justify-between">
        <span>Pages</span>
        <button type="button" className="icon-btn" aria-label="New page" title="New page" onClick={onCreate}>
          <Plus size={14} />
        </button>
      </div>
      <div className="flex max-h-48 flex-col gap-0.5 overflow-y-auto">
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
                      <FileText size={16} strokeWidth={1.8} className={active ? "text-accent" : "text-muted"} />
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
          Delete “{pendingDelete?.title || "Untitled"}”? This removes the note. It does not change tasks or the board.
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
