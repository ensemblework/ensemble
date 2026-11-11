"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { DIAGRAM_TEMPLATES } from "@ensemble/block-diagrams/templates";
import {
  ArrowLeftRight,
  Database,
  GitBranch,
  ListChecks,
  Milestone,
  Network,
  Plus,
  Route,
  Search,
  Server,
  Shapes,
  Share2,
  Waypoints,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";
import { LoadError } from "@/components/load-error";
import { PageHeader, Segmented, Skeleton } from "@/components/ui";
import { useToast } from "@/components/toast";
import { api, type DiagramSummary } from "@/lib/api";
import { relative } from "@/lib/format";
import { DiagramCardMenu } from "@/components/diagrams/download-menu";
import { DiagramThumb } from "@/components/diagrams/diagram-thumb";

const TEMPLATE_ICONS: Record<string, LucideIcon> = {
  flowchart: Workflow,
  architecture: Server,
  journey: Route,
  decision: GitBranch,
  timeline: Milestone,
  org: Network,
  mindmap: Waypoints,
  network: Share2,
  er: Database,
  sequence: ArrowLeftRight,
  plan: ListChecks,
};

type Sort = "recent" | "name";

const collator = typeof Intl === "undefined" ? null : new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

export default function DiagramsPage() {
  const router = useRouter();
  const client = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ["diagrams"], queryFn: api.diagrams });
  const [pending, setPending] = useState<string | null>(null);
  const [gallery, setGallery] = useState(false);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<Sort>("recent");
  const creating = useRef(false);
  const galleryRef = useRef<HTMLElement>(null);
  const create = useMutation({
    mutationFn: (source?: string) => api.createDiagram(source),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: ["diagrams"] });
      router.push(`/diagrams/${result.diagram.id}`);
    },
    onError: (error) => {
      creating.current = false;
      toast(error instanceof Error ? error.message : "Couldn't create a diagram.", { tone: "error" });
    },
  });
  // A double click lands both clicks before isPending disables the buttons; one diagram per choice.
  // The guard stays up after success, while the editor opens.
  const start = (source?: string) => {
    if (creating.current) return;
    creating.current = true;
    create.mutate(source);
  };
  const failure = list.data ? null : (list.error ?? list.failureReason);
  // refetch() waits for a retry that is sleeping out its delay; cancel it so Retry asks now.
  const retry = () => void client.cancelQueries({ queryKey: ["diagrams"], exact: true }).then(() => list.refetch());
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteDiagram(id),
    onSuccess: () => {
      setPending(null);
      void client.invalidateQueries({ queryKey: ["diagrams"] });
    },
    onError: (error) => toast(error instanceof Error ? error.message : "Couldn't delete that diagram.", { tone: "error" }),
  });
  const diagrams = useMemo(() => list.data?.diagrams ?? [], [list.data]);
  const prefetchIds = diagrams.slice(0, 8).map((diagram) => diagram.id).join(" ");
  useEffect(() => {
    for (const id of prefetchIds.split(" ").filter(Boolean)) router.prefetch(`/diagrams/${id}`);
  }, [prefetchIds, router]);
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matching = needle ? diagrams.filter((diagram) => (diagram.title || "Untitled diagram").toLowerCase().includes(needle)) : diagrams;
    if (sort === "recent") return [...matching].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return [...matching].sort((a, b) => (collator ? collator.compare(a.title || "Untitled diagram", b.title || "Untitled diagram") : 0));
  }, [diagrams, filter, sort]);
  const empty = Boolean(list.data) && !diagrams.length;
  const showGallery = gallery || empty;
  useEffect(() => {
    if (!gallery) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) setGallery(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [gallery]);
  const openGallery = () => {
    if (empty) {
      galleryRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
      return;
    }
    setGallery((open) => !open);
  };
  const count = diagrams.length;

  return (
    <div className="mx-auto max-w-[1120px] px-4 pb-24 pt-8 sm:px-10">
      <PageHeader
        title="Diagrams"
        description="Describe a system in plain text, or start from a few blocks and rearrange them."
        actions={
          <button type="button" className="btn-primary dg-primary" disabled={create.isPending} aria-expanded={showGallery} aria-controls="diagram-gallery" onClick={openGallery}>
            <Plus size={15} aria-hidden />
            {create.isPending ? "Creating…" : "New diagram"}
          </button>
        }
      />
      {empty ? (
        <div className="dg-empty">
          <span className="dg-empty-icon" aria-hidden>
            <Shapes size={22} />
          </span>
          <h2 className="dg-empty-title">No diagrams yet</h2>
          <p className="dg-empty-text">Describe the blocks in plain text, paste a Mermaid flowchart, or pick a starting point below.</p>
        </div>
      ) : null}
      {showGallery ? (
        <section ref={galleryRef} id="diagram-gallery" className="dg-gallery" aria-label="New diagram">
          <div className="dg-gallery-head">
            <h2 className="dg-gallery-title">Start from</h2>
            {empty ? null : (
              <button type="button" className="icon-btn" aria-label="Close templates" onClick={() => setGallery(false)}>
                <X size={15} aria-hidden />
              </button>
            )}
          </div>
          <div className="dg-gallery-grid">
            <button type="button" className="dg-template is-blank" disabled={create.isPending} onClick={() => start()}>
              <span className="dg-template-icon" aria-hidden>
                <Plus size={18} />
              </span>
              <span className="min-w-0">
                <span className="dg-template-name">Blank</span>
                <span className="dg-template-blurb">An empty canvas</span>
              </span>
            </button>
            {DIAGRAM_TEMPLATES.map((template) => {
              const Icon = TEMPLATE_ICONS[template.id] ?? Shapes;
              return (
                <button key={template.id} type="button" className="dg-template" disabled={create.isPending} onClick={() => start(template.source)}>
                  <span className="dg-template-icon" aria-hidden>
                    <Icon size={18} />
                  </span>
                  <span className="min-w-0">
                    <span className="dg-template-name">{template.name}</span>
                    <span className="dg-template-blurb">{template.blurb}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}
      {empty ? null : (
        <div className="dg-list-bar">
          <label className="dg-search">
            <Search size={15} aria-hidden className="dg-search-icon" />
            <input value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Search diagrams" placeholder="Search diagrams" className="dg-search-input" />
          </label>
          {count ? (
            <span className="dg-list-count" aria-live="polite">
              {filter.trim() ? `${shown.length} of ${count}` : count === 1 ? "1 diagram" : `${count} diagrams`}
            </span>
          ) : null}
          <Segmented<Sort>
            label="Sort diagrams"
            value={sort}
            onChange={setSort}
            options={[
              { id: "recent", label: "Recent" },
              { id: "name", label: "Name" },
            ]}
          />
        </div>
      )}
      {failure ? (
        <LoadError error={failure} what="your diagrams" onRetry={retry} />
      ) : list.isPending ? (
        <ul className="dg-grid" aria-hidden>
          {[0, 1, 2].map((index) => (
            <li key={index} className="dg-card is-skeleton">
              <Skeleton className="dg-thumb" />
              <div className="dg-card-body">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="mt-2 h-3 w-1/3" />
              </div>
            </li>
          ))}
        </ul>
      ) : diagrams.length && !shown.length ? (
        <div className="dg-no-match">
          <p>No diagrams match “{filter.trim()}”.</p>
          <button type="button" className="btn-ghost" onClick={() => setFilter("")}>
            Clear search
          </button>
        </div>
      ) : null}
      {shown.length ? (
        <ul className="dg-grid">
          {shown.map((diagram) => (
            <DiagramListCard
              key={diagram.id}
              diagram={diagram}
              confirming={pending === diagram.id}
              deleting={remove.isPending && remove.variables === diagram.id}
              onPrefetch={() => router.prefetch(`/diagrams/${diagram.id}`)}
              onAskDelete={() => setPending(diagram.id)}
              onDelete={() => remove.mutate(diagram.id)}
              onKeep={() => setPending(null)}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function DiagramListCard({
  diagram,
  confirming,
  deleting,
  onPrefetch,
  onAskDelete,
  onDelete,
  onKeep,
}: {
  diagram: DiagramSummary;
  confirming: boolean;
  deleting: boolean;
  onPrefetch: () => void;
  onAskDelete: () => void;
  onDelete: () => void;
  onKeep: () => void;
}) {
  const title = diagram.title || "Untitled diagram";
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirming) keep.current?.focus();
  }, [confirming]);
  return (
    <li className="dg-card" data-confirming={confirming || undefined}>
      <Link href={`/diagrams/${diagram.id}`} prefetch={false} className="dg-card-link" onMouseEnter={onPrefetch} onFocus={onPrefetch}>
        <DiagramThumb id={diagram.id} updatedAt={diagram.updatedAt} />
        <span className="dg-card-body">
          <span className="dg-card-title" title={title}>
            {title}
          </span>
          <span className="dg-card-meta">Updated {relative(diagram.updatedAt)}</span>
        </span>
      </Link>
      <div className="dg-card-actions">
        <DiagramCardMenu id={diagram.id} title={title} onDelete={onAskDelete} />
      </div>
      {confirming ? (
        <div className="dg-card-confirm" role="group" aria-label={`Delete ${title}`}>
          <p className="dg-card-confirm-text">Delete this diagram?</p>
          <div className="flex items-center gap-2">
            <button type="button" className="btn-danger dg-danger" disabled={deleting} onClick={onDelete}>
              {deleting ? "Deleting…" : "Delete"}
            </button>
            <button ref={keep} type="button" className="btn" onClick={onKeep}>
              Keep
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
