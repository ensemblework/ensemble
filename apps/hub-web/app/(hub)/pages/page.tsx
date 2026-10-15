/** @jsxRuntime automatic */
/** @jsxImportSource react */
"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, FileText } from "lucide-react";
import Link from "next/link";
import { api } from "@/lib/api";
import { PageHeader, QueryError, SkeletonRows } from "@/components/ui";

export default function PagesPage() {
  const pages = useQuery({ queryKey: ["pages"], queryFn: api.pages });
  const roots = pages.data?.pages.filter((page) => !page.parentId || !pages.data.pages.some((parent) => parent.id === page.parentId)) ?? [];
  return <div className="mx-auto max-w-4xl px-6 pb-20 pt-10 sm:px-10">
    <PageHeader title="Pages" description="A place for your notes, ideas and connected work. Browse nested pages in the pages panel." />
    {pages.error ? <QueryError error={pages.error} retry={() => { void pages.refetch(); }} /> : pages.isLoading ? <SkeletonRows count={3} /> : <div className="mt-6 grid gap-3 sm:grid-cols-2">
      {roots.map((page) => <Link key={page.id} href={`/pages/${page.id}`} className="tile group flex items-center gap-3 rounded-xl bg-panel p-4"><FileText size={20} className="text-muted" /><span className="min-w-0 flex-1 truncate font-medium">{page.title || "Untitled"}</span><ArrowUpRight size={15} className="text-faint group-hover:text-ink" /></Link>)}
      {!roots.length ? <p className="text-[14px] text-muted">Create a page or import from Notion using the pages panel.</p> : null}
    </div>}
  </div>;
}
