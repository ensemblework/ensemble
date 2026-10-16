"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { FileText } from "lucide-react";
import { api } from "@/lib/api";
import { useSpaceAccess } from "@/lib/access";
import { useToast } from "../toast";
import { standalonePageHref } from "./page-href";
import { PAGE_DRAG_TYPE, pageIdFromHref } from "@/lib/page-drag";
import { PagesSection, type PageLinkProps } from "./pages-section";

const ImportDialog = dynamic(() => import("../imports/import-dialog").then((mod) => mod.ImportDialog), { ssr: false });

/** A row dropped on a page body becomes a link to this page (components/editor/clipboard.ts). */
function dragPage(data: DataTransfer, href: string, title?: string) {
  const id = pageIdFromHref(href, window.location.origin);
  if (id) data.setData(PAGE_DRAG_TYPE, JSON.stringify({ id, title: title ?? "" }));
}

function PageLink({ href, className, title, current, children }: PageLinkProps) {
  return (
    <Link href={href} className={className} title={title} aria-current={current ? "page" : undefined} onDragStart={(event) => dragPage(event.dataTransfer, href, title)}>
      {children}
    </Link>
  );
}

/** Pages is one navigation destination; its tree lives in the separate browser. */
export function PagesNav() {
  const pathname = usePathname();
  return <nav className="mt-1 px-2" aria-label="Pages"><Link href="/pages" title="Pages" aria-current={pathname.startsWith("/pages") ? "page" : undefined} data-active={pathname.startsWith("/pages") || undefined} onClick={() => window.dispatchEvent(new CustomEvent("ensemble:pages-open"))} className="nav-link row-tile flex items-center gap-2.5 rounded-lg px-2 py-[6px] text-[13.5px] text-ink/80"><FileText size={16} strokeWidth={1.8} className="text-muted" /><span className="sidebar-label flex-1">Pages</span></Link></nav>;
}

export function PagesBrowser() {
  const router = useRouter();
  const pathname = usePathname();
  const client = useQueryClient();
  const toast = useToast();
  const pages = useQuery({ queryKey: ["pages"], queryFn: api.pages });
  const access = useSpaceAccess();
  const [importing, setImporting] = useState(false);
  const [creating, setCreating] = useState(false);
  const createPending = useRef(false);

  return (
    <>
      <PagesSection
        pages={pages.data?.pages ?? []}
        pathname={pathname}
        renderLink={(props) => <PageLink {...props} />}
        onImport={access.guest ? undefined : () => setImporting(true)}
        creating={creating}
        onCreate={() => {
          if (createPending.current) return;
          createPending.current = true;
          setCreating(true);
          void api
            .createPage()
            .then(({ page }) => {
              void client.invalidateQueries({ queryKey: ["pages"] });
              router.push(standalonePageHref(page.id, true));
            })
            .catch((error: Error) => toast(error.message, { tone: "error" }))
            .finally(() => {
              createPending.current = false;
              setCreating(false);
            });
        }}
        onDeleteMany={access.ready && access.canEdit ? (ids) => {
          const selected = new Set(ids);
          let changed = true;
          while (changed) {
            changed = false;
            for (const page of pages.data?.pages ?? []) if (page.parentId && selected.has(page.parentId) && !selected.has(page.id)) { selected.add(page.id); changed = true; }
          }
          const detail = { ids, affected: [...selected] };
          if (!window.dispatchEvent(new CustomEvent("ensemble:delete-pages", { detail, cancelable: true }))) return;
          void api.deletePages(ids).then((result) => {
            void client.invalidateQueries({ predicate: (query) => !query.queryKey.some((part) => typeof part === "string" && selected.has(part)) });
            toast("Pages moved to Trash. One Undo restores them all.", { action: { label: "Undo", run: () => { void api.undo(result.undoEntryId ?? undefined).then(() => client.invalidateQueries()).catch((error: Error) => toast(error.message, { tone: "error" })); } } });
            if ([...selected].some((id) => pathname === `/pages/${id}`)) router.push("/pages");
          }).catch((error: Error) => toast(error.message, { tone: "error" }));
        } : undefined}
        onRename={(id, title) => {
          void api
            .renamePage(id, title)
            .then(() => {
              void client.invalidateQueries({ queryKey: ["pages"] });
              void client.invalidateQueries({ queryKey: ["standalone-page", id] });
            })
            .catch((error: Error) => toast(error.message, { tone: "error" }));
        }}
        onDelete={(id) => {
          // The open editor owns its pending saves before the page moves to Trash.
          if (!window.dispatchEvent(new CustomEvent("ensemble:delete-page", { detail: { id }, cancelable: true }))) return;
          void api
            .deletePage(id)
            .then(() => {
              const removed = new Set([id]);
              let changed = true;
              while (changed) { changed = false; for (const page of pages.data?.pages ?? []) if (page.parentId && removed.has(page.parentId) && !removed.has(page.id)) { removed.add(page.id); changed = true; } }
              // An open child of the deleted page must not refetch itself into a 404 before Pages opens.
              void client.invalidateQueries({ predicate: (query) => !query.queryKey.some((part) => typeof part === "string" && removed.has(part)) });
              toast("Page moved to Trash.", { action: { label: "Undo", run: () => { void api.undo().then(() => { void client.invalidateQueries(); }).catch((error: Error) => toast(error.message, { tone: "error" })); } } });
              if ([...removed].some((pageId) => pathname === `/pages/${pageId}`)) router.push("/pages");
            })
            .catch((error: Error) => toast(error.message, { tone: "error" }));
        }}
      />
      {importing ? <ImportDialog open onClose={() => setImporting(false)} initialSource="notion" /> : null}
    </>
  );
}
