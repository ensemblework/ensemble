"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { DIAGRAM_TEMPLATES } from "@ensemble/block-diagrams/templates";
import { PageHeader } from "@/components/ui";
import { useToast } from "@/components/toast";
import { api } from "@/lib/api";
import { relative } from "@/lib/format";

export default function DiagramsPage() {
  const router = useRouter();
  const client = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ["diagrams"], queryFn: api.diagrams });
  const [pending, setPending] = useState<string | null>(null);
  const [gallery, setGallery] = useState(false);
  const [filter, setFilter] = useState("");
  const create = useMutation({
    mutationFn: (source?: string) => api.createDiagram(source),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: ["diagrams"] });
      router.push(`/diagrams/${result.diagram.id}`);
    },
    onError: (error) => toast(error instanceof Error ? error.message : "Couldn't create a diagram.", { tone: "error" }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteDiagram(id),
    onSuccess: () => {
      setPending(null);
      void client.invalidateQueries({ queryKey: ["diagrams"] });
    },
    onError: (error) => toast(error instanceof Error ? error.message : "Couldn't delete that diagram.", { tone: "error" }),
  });
  const diagrams = list.data?.diagrams ?? [];
  const prefetchIds = diagrams.slice(0, 8).map((diagram) => diagram.id).join(" ");
  useEffect(() => {
    for (const id of prefetchIds.split(" ").filter(Boolean)) router.prefetch(`/diagrams/${id}`);
  }, [prefetchIds, router]);
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return diagrams;
    return diagrams.filter((diagram) => (diagram.title || "Untitled diagram").toLowerCase().includes(needle));
  }, [diagrams, filter]);
  return (
    <div className="mx-auto max-w-[880px] px-4 pb-24 pt-8 sm:px-10">
      <PageHeader
        title="Block diagrams"
        description="Describe a system in plain text, or start from a few blocks and rearrange them."
        actions={
          <button type="button" className="btn-primary" disabled={create.isPending} onClick={() => setGallery((open) => !open)}>
            {create.isPending ? "Creating…" : "New diagram"}
          </button>
        }
      />
      {gallery ? (
        <div className="mb-4 rounded-xl border border-line bg-panel p-3" role="dialog" aria-label="New diagram">
          <div className="mb-2 text-[13px] font-medium">Start from</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <button type="button" className="tile rounded-lg px-3 py-2 text-left" disabled={create.isPending} onClick={() => create.mutate(undefined)}>
              <div className="text-[13.5px] font-medium">Blank</div>
              <div className="mt-0.5 text-[12px] text-muted">An empty canvas</div>
            </button>
            {DIAGRAM_TEMPLATES.map((template) => (
              <button
                key={template.id}
                type="button"
                className="tile rounded-lg px-3 py-2 text-left"
                disabled={create.isPending}
                onClick={() => create.mutate(template.source)}
              >
                <div className="text-[13.5px] font-medium">{template.name}</div>
                <div className="mt-0.5 text-[12px] text-muted">{template.blurb}</div>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <input
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        aria-label="Search diagrams"
        placeholder="Search diagrams"
        className="field mb-3 w-full px-3 py-2 text-[13.5px]"
      />
      {list.isError ? <p className="text-[14px] text-danger">{list.error instanceof Error ? list.error.message : "Couldn't load diagrams."}</p> : null}
      {!list.isLoading && !diagrams.length ? (
        <div className="empty-state">No diagrams yet. Create one and describe the blocks, or paste a Mermaid flowchart into the text.</div>
      ) : null}
      {!list.isLoading && diagrams.length > 0 && !shown.length ? <p className="text-[13.5px] text-muted">No diagrams match that search.</p> : null}
      <ul className="space-y-2">
        {shown.map((diagram) => (
          <li key={diagram.id} className="tile flex items-center gap-3 rounded-xl bg-panel px-4 py-3">
            <Link
              href={`/diagrams/${diagram.id}`}
              prefetch={false}
              className="min-w-0 flex-1"
              onMouseEnter={() => router.prefetch(`/diagrams/${diagram.id}`)}
              onFocus={() => router.prefetch(`/diagrams/${diagram.id}`)}
            >
              <div className="truncate text-[15px] font-medium">{diagram.title || "Untitled diagram"}</div>
              <div className="mt-0.5 text-[12.5px] text-muted">Updated {relative(diagram.updatedAt)}</div>
            </Link>
            {pending === diagram.id ? (
              <span className="flex items-center gap-2 text-[13px]">
                <span className="text-muted">Delete this diagram?</span>
                <button type="button" className="btn" onClick={() => remove.mutate(diagram.id)}>
                  Delete
                </button>
                <button type="button" className="btn-ghost" onClick={() => setPending(null)}>
                  Keep
                </button>
              </span>
            ) : (
              <button type="button" className="btn-ghost" onClick={() => setPending(diagram.id)}>
                Delete
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
