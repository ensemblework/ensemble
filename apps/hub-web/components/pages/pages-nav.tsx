"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";
import { useSpaceAccess } from "@/lib/access";
import { useToast } from "../toast";
import { standalonePageHref } from "./page-href";
import { PagesSection, type PageLinkProps } from "./pages-section";

const ImportDialog = dynamic(() => import("../imports/import-dialog").then((mod) => mod.ImportDialog), { ssr: false });

function PageLink({ href, className, title, children }: PageLinkProps) {
  return (
    <Link href={href} className={className} title={title}>
      {children}
    </Link>
  );
}

/** Loads standalone notes into the sidebar and opens a new one in the page editor. */
export function PagesNav() {
  const router = useRouter();
  const pathname = usePathname();
  const client = useQueryClient();
  const toast = useToast();
  const pages = useQuery({ queryKey: ["pages"], queryFn: api.pages });
  const access = useSpaceAccess();
  const [importing, setImporting] = useState(false);

  return (
    <>
      <PagesSection
        pages={pages.data?.pages ?? []}
        pathname={pathname}
        renderLink={(props) => <PageLink {...props} />}
        onImport={access.guest ? undefined : () => setImporting(true)}
        onCreate={() => {
          void api
            .createPage()
            .then(({ page }) => {
              void client.invalidateQueries({ queryKey: ["pages"] });
              router.push(standalonePageHref(page.id, true));
            })
            .catch((error: Error) => toast(error.message, { tone: "error" }));
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
          void api.deletePages(ids).then(() => {
            void client.invalidateQueries();
            toast("Pages moved to Trash. One Undo restores them all.", { action: { label: "Undo", run: () => { void api.undo().then(() => client.invalidateQueries()).catch((error: Error) => toast(error.message, { tone: "error" })); } } });
            if ([...selected].some((id) => pathname === `/pages/${id}`)) router.push("/today");
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
              void client.invalidateQueries();
              toast("Note moved to Trash.", { action: { label: "Undo", run: () => { void api.undo().then(() => { void client.invalidateQueries(); }).catch((error: Error) => toast(error.message, { tone: "error" })); } } });
              if (pathname === `/pages/${id}` || pathname.startsWith(`/pages/${id}/`)) router.push("/today");
            })
            .catch((error: Error) => toast(error.message, { tone: "error" }));
        }}
      />
      {importing ? <ImportDialog open onClose={() => setImporting(false)} initialSource="notion" /> : null}
    </>
  );
}
