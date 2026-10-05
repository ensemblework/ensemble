"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useToast } from "../toast";
import { standalonePageHref } from "./page-href";
import { PagesSection, type PageLinkProps } from "./pages-section";

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

  return (
    <PagesSection
      pages={pages.data?.pages ?? []}
      pathname={pathname}
      renderLink={(props) => <PageLink {...props} />}
      onCreate={() => {
        void api
          .createPage()
          .then(({ page }) => {
            void client.invalidateQueries({ queryKey: ["pages"] });
            router.push(standalonePageHref(page.id, true));
          })
          .catch((error: Error) => toast(error.message, { tone: "error" }));
      }}
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
        void api
          .deletePage(id)
          .then(() => {
            void client.invalidateQueries({ queryKey: ["pages"] });
            if (pathname === `/pages/${id}` || pathname.startsWith(`/pages/${id}/`)) router.push("/today");
          })
          .catch((error: Error) => toast(error.message, { tone: "error" }));
      }}
    />
  );
}
