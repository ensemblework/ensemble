"use client";

import { useQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import Link from "next/link";
import { useCallback, useState } from "react";
import type { PageDocument } from "@ensemble/shared-types";
import { api } from "@/lib/api";

type DocNode = { type?: string; attrs?: Record<string, unknown> | null; content?: DocNode[] };

/** The pages a document links to with page blocks. */
export function linkedPageIds(doc: PageDocument | null | undefined): string[] {
  const ids: string[] = [];
  const walk = (node: DocNode) => {
    if (node.type === "pageLink" && typeof node.attrs?.pageId === "string") ids.push(node.attrs.pageId);
    node.content?.forEach(walk);
  };
  if (doc) walk(doc as DocNode);
  return ids;
}

/** Page links in the document as it is edited, so the list below leaves out pages already linked in it. */
export function useLinkedPages(initial: PageDocument | null | undefined) {
  const [ids, setIds] = useState<string[] | null>(null);
  const shown = ids ?? linkedPageIds(initial);
  const track = useCallback((doc: PageDocument) => {
    const next = linkedPageIds(doc);
    setIds((current) => (current && current.join() === next.join() ? current : next));
  }, []);
  return { linked: shown, track };
}

/** The pages inside a page or a task (`/page`, or the assistant and nodes nesting one there). */
export function NestedPages({ parentPageId, parentTaskId, linked = [] }: { parentPageId?: string; parentTaskId?: string; linked?: string[] }) {
  const family = useQuery({ queryKey: ["pages"], queryFn: api.pages });
  const children = (family.data?.pages ?? []).filter((page) => (parentTaskId ? page.parentTaskId === parentTaskId : page.parentId === parentPageId) && !linked.includes(page.id));
  if (!children.length) return null;
  return (
    <nav aria-label="Nested pages" className="mt-6 space-y-1 border-t border-line pt-4" data-nested-pages>
      <p className="mb-2 text-[12px] font-medium text-muted">Pages inside</p>
      {children.map((child) => (
        <Link key={child.id} className="page-link-block" href={`/pages/${child.id}`}>
          <FileText size={15} aria-hidden /> {child.title || "Untitled"}
        </Link>
      ))}
    </nav>
  );
}
