"use client";

import { useQuery } from "@tanstack/react-query";
import { CalendarDays } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, type ContextItemCard, type ContextItemResponse, type ContextRelationGroup, type TaskStatus } from "@/lib/api";
import { STATUS, shortDate } from "@/lib/format";
import { usePeek, type PeekKind } from "../shell/peek";
import { Tag, cx } from "../ui";

export const contextItemKey = (ref: string) => ["context-item", ref] as const;

/** One record and what links to it (`GET /api/context/item`). */
export function useContextItem(ref: string | null) {
  return useQuery({ queryKey: contextItemKey(ref ?? ""), queryFn: () => api.contextItem(ref!), enabled: Boolean(ref), staleTime: 15_000 });
}

/** Opens a linked record where the rest of the Hub opens it: the side peek for work and people, else its page. */
export function useOpenCard() {
  const router = useRouter();
  const peek = usePeek();
  return (card: ContextItemCard) => {
    if (card.kind === "task" || card.kind === "project" || card.kind === "deliverable" || card.kind === "page") peek.open(card.id, card.kind as PeekKind);
    else if (card.kind === "person") peek.open(card.id, "person");
    else if (card.path) router.push(card.path);
  };
}

const DONE = new Set(["done", "completed", "dropped"]);

export function StatusChip({ status }: { status: string | null | undefined }) {
  if (!status) return null;
  const task = STATUS[status as TaskStatus];
  if (task) return <Tag tone={task.tone}>{task.label}</Tag>;
  return <Tag tone={DONE.has(status) ? "green" : "gray"}>{status.charAt(0).toUpperCase() + status.slice(1).replaceAll("_", " ")}</Tag>;
}

function Row({ card, onOpen }: { card: ContextItemCard; onOpen: (card: ContextItemCard) => void }) {
  const done = Boolean(card.status && DONE.has(card.status));
  const opens = Boolean(card.path || ["task", "project", "deliverable", "page", "person"].includes(card.kind));
  return (
    <li className="linked-row" data-context-card={card.kind}>
      <button type="button" className="linked-main !gap-2 !py-1.5 !text-[13px]" disabled={!opens} onClick={() => onOpen(card)}>
        <span className="min-w-0 flex-1">
          <span className={cx("linked-title block truncate", done && "is-done")}>{card.title}</span>
          {card.detail && card.detail !== card.role ? <span className="block truncate text-[11.5px] text-faint">{card.detail}</span> : null}
        </span>
        {card.role ? <span className="max-w-[40%] shrink-0 truncate text-[12px] text-muted">{card.role}</span> : null}
        {card.due ? (
          <span className="linked-meta">
            <CalendarDays size={12} aria-hidden /> {shortDate(card.due)}
          </span>
        ) : null}
        <StatusChip status={card.status} />
      </button>
    </li>
  );
}

const cardKey = (card: ContextItemCard) => `${card.kind}:${card.id}`;

function Group({ itemRef, group, onOpen }: { itemRef: string; group: ContextRelationGroup; onOpen: (card: ContextItemCard) => void }) {
  const [extra, setExtra] = useState<{ items: ContextItemCard[]; more: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const shown = new Set(group.items.map(cardKey));
  const rows = [...group.items, ...(extra?.items ?? []).filter((card) => !shown.has(cardKey(card)))];
  const more = extra ? extra.more : group.more;
  const loadMore = async () => {
    setLoading(true);
    setFailed(false);
    try {
      const page = await api.contextItem(itemRef, { rel: group.rel, offset: rows.length, limit: 20 });
      const next = page.groups[0];
      setExtra((current) => ({ items: [...(current?.items ?? []), ...(next?.items ?? [])], more: Boolean(next?.more) }));
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };
  return (
    <section aria-label={group.label} data-context-rel={group.rel}>
      <h3 className="mb-0.5 flex items-center gap-2 px-2 text-[12.5px] font-semibold text-muted">
        {group.label}
        <span className="linked-count">{more ? `${rows.length}+` : rows.length}</span>
      </h3>
      <ul className="linked-rows">
        {rows.map((card) => (
          <Row key={cardKey(card)} card={card} onOpen={onOpen} />
        ))}
      </ul>
      {more ? (
        <button type="button" className="linked-action ml-1 mt-0.5" onClick={() => void loadMore()} disabled={loading} aria-busy={loading || undefined}>
          {loading ? "Loading…" : failed ? "Couldn't load more. Try again" : "Show more"}
        </button>
      ) : null}
    </section>
  );
}

/** What links to a record, one compact list per relation, each with Show more. */
export function RelationGroups({ data, onOpen, empty = "Nothing links to this yet." }: { data: ContextItemResponse; onOpen: (card: ContextItemCard) => void; empty?: string }) {
  const itemRef = data.item.ref;
  if (!data.groups.length || !itemRef) return <p className="linked-empty">{empty}</p>;
  return (
    <div className="flex flex-col gap-4">
      {data.groups.map((group) => (
        <Group key={`${itemRef}:${group.rel}`} itemRef={itemRef} group={group} onOpen={onOpen} />
      ))}
    </div>
  );
}

/** A few of the record's facts that read as text: dates, names, short lists. */
export function factRows(facts: Record<string, unknown>, skip: readonly string[] = []): Array<{ key: string; label: string; value: string }> {
  const rows: Array<{ key: string; label: string; value: string }> = [];
  for (const [key, raw] of Object.entries(facts)) {
    if (skip.includes(key) || raw === null || raw === undefined || raw === "") continue;
    let value: string | null = null;
    if (typeof raw === "string") value = /^\d{4}-\d{2}-\d{2}T/.test(raw) ? shortDate(raw) : raw;
    else if (typeof raw === "number") value = String(raw);
    else if (typeof raw === "boolean") value = raw ? "Yes" : "No";
    else if (Array.isArray(raw) && raw.length && raw.every((entry) => typeof entry === "string")) value = (raw as string[]).slice(0, 4).join("; ") + (raw.length > 4 ? ` +${raw.length - 4}` : "");
    if (!value) continue;
    rows.push({ key, label: key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (first) => first.toUpperCase()), value: value.length > 160 ? `${value.slice(0, 159)}…` : value });
    if (rows.length >= 6) break;
  }
  return rows;
}
