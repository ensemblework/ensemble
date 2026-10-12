"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, ExternalLink, FileText, GitPullRequest, Mail, MessageSquare, Search, Trash2, Video, X, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { APP_ITEM_KIND_LABEL, type AppItemKind } from "@ensemble/shared-types";
import type { ArtifactRecord } from "@/lib/api";
import { useSpaceAccess } from "@/lib/access";
import { FROM_APPS_QUERY, fromAppsApi, type AppItemDetail } from "@/lib/api-files";
import { dateTime, relative } from "@/lib/format";
import { emitToast } from "@/lib/toast-bus";
import { BrandLogo } from "../connectors/brand-logo";
import { MarkdownText } from "../markdown-text";
import { Dialog, Empty, QueryError, SkeletonRows, Spinner, cx } from "../ui";

/** Artifact kinds (prisma ArtifactKind), as one item and as a filter. */
const KINDS: Record<string, { one: string; many: string; icon: LucideIcon }> = {
  email: { one: "Email", many: "Email", icon: Mail },
  event: { one: "Event", many: "Events", icon: CalendarDays },
  chat_msg: { one: "Chat", many: "Chats", icon: MessageSquare },
  channel_msg: { one: "Message", many: "Channel messages", icon: MessageSquare },
  transcript: { one: "Transcript", many: "Transcripts", icon: Video },
  transcript_segment: { one: "Transcript", many: "Transcript parts", icon: Video },
  file: { one: "Doc", many: "Docs", icon: FileText },
  pr: { one: "Pull request", many: "Pull requests", icon: GitPullRequest },
  pr_comment: { one: "Review comment", many: "Review comments", icon: GitPullRequest },
  commit: { one: "Commit", many: "Commits", icon: GitPullRequest },
  issue: { one: "Issue", many: "Issues", icon: GitPullRequest },
  meeting_note: { one: "Meeting note", many: "Meeting notes", icon: FileText },
};
const KIND_ORDER = Object.keys(KINDS);
/** Kinds whose text is markdown at the source. */
const MARKDOWN = new Set(["file", "pr", "issue", "pr_comment", "meeting_note"]);

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

function attached(row: ArtifactRecord): boolean {
  return row.metadata?.via === "app-item";
}

/** "Pull request", or the app's own word for an item attached from it ("Page", "Card"). */
export function itemKindLabel(row: ArtifactRecord): string {
  const itemKind = row.metadata?.itemKind;
  if (attached(row) && typeof itemKind === "string" && itemKind in APP_ITEM_KIND_LABEL) return APP_ITEM_KIND_LABEL[itemKind as AppItemKind];
  return KINDS[row.kind]?.one ?? row.kind.replaceAll("_", " ");
}

/** Events show their day and time; everything else how long ago it happened. */
function when(row: ArtifactRecord): string {
  return row.kind === "event" || Date.parse(row.ts) > Date.now() ? dateTime(row.ts) : relative(row.ts);
}

function OriginMark({ row, size }: { row: ArtifactRecord; size: number }) {
  const origin = row.origin;
  if (origin?.app) return <BrandLogo id={origin.app} name={origin.label} size={size} decorative />;
  const Icon = KINDS[row.kind]?.icon ?? FileText;
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-lg border border-line bg-raised text-muted" style={{ width: size, height: size }} aria-hidden>
      <Icon size={Math.round(size * 0.5)} />
    </span>
  );
}

/** What the item says about itself, as label and value pairs. */
function facts(item: AppItemDetail): Array<[string, string]> {
  const meta = item.metadata ?? {};
  const rows: Array<[string, string]> = [];
  if (item.kind === "event") {
    rows.push(["Starts", dateTime(item.ts)]);
    const end = text(meta.end);
    if (end) rows.push(["Ends", dateTime(end)]);
  } else {
    rows.push(["Date", dateTime(item.ts)]);
  }
  for (const [label, key] of [
    ["From", "from"],
    ["To", "to"],
    ["Cc", "cc"],
    ["Where", "location"],
    ["Calendar", "calendar"],
    ["Chat", "chatName"],
    ["Channel", "channelName"],
    ["Repository", "repo"],
    ["Team", "team"],
    ["State", "state"],
    ["Details", "subtitle"],
  ] as const) {
    const value = text(meta[key]);
    if (value) rows.push([label, value]);
  }
  if (typeof meta.durationMinutes === "number") rows.push(["Length", `${meta.durationMinutes} min`]);
  if (attached(item) && meta.facts && typeof meta.facts === "object") {
    for (const [label, value] of Object.entries(meta.facts as Record<string, unknown>)) {
      const shown = text(value);
      if (shown) rows.push([label, shown]);
    }
  }
  return rows;
}

function people(item: AppItemDetail): string[] {
  if (item.kind === "email") return [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const person of item.participants ?? []) {
    const name = text(person.name);
    const address = text(person.email) ?? text(person.handle);
    const line = name && address ? `${name} (${address})` : (name ?? address);
    if (!line || seen.has(line.toLowerCase())) continue;
    seen.add(line.toLowerCase());
    names.push(line);
  }
  return names.slice(0, 30);
}

/** Reads one item: its facts, people and text, a link to it in its app, and Remove for the owner. */
function AppItemReader({ id, onClose, onOpenFile }: { id: string; onClose: () => void; onOpenFile: (documentId: string) => void }) {
  const client = useQueryClient();
  const { guest } = useSpaceAccess();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const detail = useQuery({ queryKey: FROM_APPS_QUERY.one(id), queryFn: () => fromAppsApi.get(id), retry: false });
  const item = detail.data?.artifact;
  const openFile = useRef(onOpenFile);
  openFile.current = onOpenFile;
  useEffect(() => {
    if (item?.documentId) openFile.current(item.documentId);
  }, [item?.documentId]);

  const app = item?.origin?.label ?? "the app";
  const remove = async () => {
    if (!item) return;
    setBusy(true);
    try {
      await fromAppsApi.remove(item.id);
      setAsking(false);
      onClose();
      client.removeQueries({ queryKey: FROM_APPS_QUERY.one(item.id) });
      // Every list that may show it; not the open reader's own query, which would now be a 404.
      void client.invalidateQueries({ predicate: (query) => query.queryKey[0] === "artifacts" && query.queryKey[1] !== "one" });
      for (const key of ["desk-live", "graph", "calendar", "widget-feed"]) void client.invalidateQueries({ queryKey: [key] });
      emitToast(`Removed ${item.title || "the item"}.`);
    } catch (error) {
      emitToast(error instanceof Error ? error.message : "Could not remove the item.", { tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="min-w-0 rounded-xl border border-line bg-panel lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem)] lg:overflow-auto" aria-label="Item" data-app-item-reader={id}>
      {detail.error ? (
        <div className="p-4 text-[13px]">
          <div className="flex items-start justify-between gap-2">
            <p className="font-medium">This item is not here anymore.</p>
            <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
              <X size={15} />
            </button>
          </div>
          <p className="mt-1 text-muted">It may have been removed.</p>
        </div>
      ) : !item ? (
        <div className="flex h-40 items-center justify-center">
          <Spinner />
        </div>
      ) : (
        <>
          <header className="border-b border-line p-4">
            <div className="flex items-start gap-3">
              <OriginMark row={item} size={30} />
              <div className="min-w-0 flex-1">
                <h2 className="break-words text-[16px] font-semibold leading-6">{item.title || "Untitled"}</h2>
                <p className="text-[12.5px] text-muted">{[itemKindLabel(item), item.origin?.label].filter(Boolean).join(" · ")}</p>
              </div>
              <button type="button" className="icon-btn" aria-label="Close" title="Close" onClick={onClose}>
                <X size={15} />
              </button>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {item.url ? (
                <a href={item.url} target="_blank" rel="noreferrer" className="btn">
                  Open in {app} <ExternalLink size={12} aria-hidden />
                </a>
              ) : null}
              {guest ? null : (
                <button type="button" className="btn" onClick={() => setAsking(true)}>
                  <Trash2 size={13} aria-hidden /> Remove
                </button>
              )}
            </div>
          </header>
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 border-b border-line px-4 py-3 text-[12.5px]">
            {facts(item).map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted">{label}</dt>
                <dd className="break-words">{value}</dd>
              </div>
            ))}
            {people(item).length ? (
              <div className="contents">
                <dt className="text-muted">People</dt>
                <dd className="break-words">{people(item).join(", ")}</dd>
              </div>
            ) : null}
          </dl>
          <div className="px-4 py-3" data-app-item-text>
            {!item.text.trim() ? (
              <p className="text-[13px] text-muted">No text was kept for this item.</p>
            ) : MARKDOWN.has(item.kind) || attached(item) ? (
              <MarkdownText text={item.text} />
            ) : (
              <div className="whitespace-pre-wrap break-words text-[13.5px] leading-[1.6]">{item.text}</div>
            )}
          </div>
          <Dialog open={asking} onClose={() => setAsking(false)} title="Remove this item?" width={460}>
            <div className="space-y-3 text-[13px] leading-5">
              <p>
                <span className="font-medium">{item.title || "This item"}</span> will be removed from Ensemble. The assistant, agents and your editors stop seeing it, and syncing {app} will not
                bring it back. It stays in {app}.
              </p>
              <div className="flex justify-end gap-2">
                <button type="button" className="btn-ghost" onClick={() => setAsking(false)}>
                  Keep it
                </button>
                <button type="button" className="btn-danger" disabled={busy} onClick={() => void remove()}>
                  {busy ? <Spinner size={12} /> : <Trash2 size={13} aria-hidden />} Remove
                </button>
              </div>
            </div>
          </Dialog>
        </>
      )}
    </aside>
  );
}

/**
 * Files → From your apps: mail, events, messages, docs and pull requests Ensemble synced or
 * attached from connected apps, with a reader beside the list (full width on phones).
 */
export function FromApps({ item, onItem, onOpenFile }: { item: string | null; onItem: (id: string | null) => void; onOpenFile: (documentId: string) => void }) {
  const { guest } = useSpaceAccess();
  const [input, setInput] = useState("");
  const q = useDebounced(input.trim(), 250);
  const [kind, setKind] = useState("all");
  const list = useInfiniteQuery({
    queryKey: FROM_APPS_QUERY.list(q, kind),
    queryFn: ({ pageParam }) => fromAppsApi.list({ q: q || undefined, kind: kind === "all" ? undefined : kind, before: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
  });
  const pages = list.data?.pages ?? [];
  const rows = pages.flatMap((page) => page.artifacts);
  const counts = new Map((pages[0]?.counts ?? []).map((row) => [row.kind, row.count]));
  const kinds = KIND_ORDER.filter((value) => (counts.get(value) ?? 0) > 0);
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  useEffect(() => {
    if (kind !== "all" && list.data && !list.isPlaceholderData && !kinds.includes(kind)) setKind("all");
  }, [kind, kinds, list.data, list.isPlaceholderData]);

  const empty = list.data && !list.isPlaceholderData && total === 0;
  return (
    <div className={cx(item && "lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(340px,440px)] lg:items-start lg:gap-5")}>
      <section className={cx("min-w-0", item && "hidden lg:block")} aria-label="Items from your apps">
        {empty ? (
          <Empty title="Nothing from your apps yet">
            Mail, calendar events, docs and messages from your connected apps appear here once Ensemble syncs them, with anything you attach to a task or project.
            {guest ? null : (
              <>
                {" "}
                <Link href="/settings?tab=connections" className="text-accent hover:underline">
                  Connect an app in Settings → Connections
                </Link>
                .
              </>
            )}
          </Empty>
        ) : (
          <>
            <label className="mb-3 flex h-9 min-w-0 items-center gap-2 rounded-lg border border-line bg-panel px-2.5 focus-within:border-accent">
              <Search size={14} className="shrink-0 text-muted" aria-hidden />
              <input
                type="search"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="Search titles and text"
                aria-label="Search items from your apps"
                className="search-line min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-faint"
              />
            </label>
            {kinds.length > 1 ? (
              <div className="mb-4 flex flex-wrap gap-1.5" role="group" aria-label="Kind of item">
                {(["all", ...kinds] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={kind === value}
                    onClick={() => setKind(value)}
                    className={cx(
                      "rounded-full border px-2.5 py-1 text-[12.5px]",
                      kind === value ? "border-accent bg-accent-soft font-medium text-ink" : "border-line text-muted hover:text-ink",
                    )}
                  >
                    {value === "all" ? "All" : KINDS[value]!.many}
                    <span className="ml-1 text-faint">{value === "all" ? total : counts.get(value)}</span>
                  </button>
                ))}
              </div>
            ) : null}
            {list.error && !list.data ? (
              <QueryError error={list.error as Error} retry={() => void list.refetch()} />
            ) : list.isPending ? (
              <SkeletonRows count={5} rowClassName="h-12" />
            ) : !rows.length ? (
              <p className="text-[13.5px] text-muted">{q ? `Nothing matches “${q}”.` : "Nothing of this kind."}</p>
            ) : (
              <>
                <ul className="space-y-0.5" aria-label="Items">
                  {rows.map((row) => (
                    <li key={row.id}>
                      <button
                        type="button"
                        onClick={() => onItem(row.id)}
                        aria-current={row.id === item ? "true" : undefined}
                        className={cx("row-tile flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left", row.id === item && "bg-hover")}
                        data-app-item={row.id}
                      >
                        <OriginMark row={row} size={28} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13.5px] font-medium text-ink">{row.title || "Untitled"}</span>
                          <span className="block truncate text-[12px] text-muted">{[itemKindLabel(row), row.origin?.label, when(row)].filter(Boolean).join(" · ")}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                {list.hasNextPage ? (
                  <button type="button" className="btn mt-3" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                    {list.isFetchingNextPage ? <Spinner size={12} /> : null} Show more
                  </button>
                ) : null}
              </>
            )}
          </>
        )}
      </section>
      {item ? <AppItemReader key={item} id={item} onClose={() => onItem(null)} onOpenFile={onOpenFile} /> : null}
    </div>
  );
}
