"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

/**
 * Settings → Connections → Calendars on Today: the calendar links (ICS / iCal /
 * webcal subscriptions) that join Google Calendar and Outlook on the Today
 * calendar (hub-api routes/calendar.ts). A link is stored encrypted and never
 * shown again; only its host is.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Link2, Pencil, Plus, Trash2, X } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { api, type CalendarFeed } from "@/lib/api";
import { plural, relative } from "@/lib/format";
import { FetchGlyph } from "@/components/motion/slot";
import { useToast } from "../toast";
import { SectionCard, Spinner } from "../ui";
import { invalidateCalendar, useCalendarSync } from "./sync";

function FeedRow({ feed }: { feed: CalendarFeed }) {
  const client = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(feed.name);
  const [confirming, setConfirming] = useState(false);
  const rename = useMutation({
    mutationFn: () => api.renameCalendarFeed(feed.id, name.trim()),
    onSuccess: () => {
      setEditing(false);
      invalidateCalendar(client);
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const remove = useMutation({
    mutationFn: () => api.removeCalendarFeed(feed.id),
    onSuccess: () => {
      invalidateCalendar(client);
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const status = feed.lastError
    ? null
    : feed.lastSyncAt
      ? `${plural(feed.itemCount, "event")} · synced ${relative(feed.lastSyncAt)}`
      : "Not read yet";
  return (
    <li className="cal-link-row" data-feed={feed.id}>
      <span className="cal-dot" data-source="ics" aria-hidden />
      <div className="min-w-0 flex-1">
        {editing ? (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim()) rename.mutate();
            }}
          >
            <input className="field h-7 min-w-0 flex-1 text-[13px]" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} aria-label="Calendar name" autoFocus />
            <button type="submit" className="icon-btn h-7 w-7" aria-label="Save name" disabled={!name.trim() || rename.isPending}>
              <Check size={13} aria-hidden />
            </button>
            <button
              type="button"
              className="icon-btn h-7 w-7"
              aria-label="Cancel"
              onClick={() => {
                setName(feed.name);
                setEditing(false);
              }}
            >
              <X size={13} aria-hidden />
            </button>
          </form>
        ) : (
          <p className="truncate text-[13.5px] font-medium text-ink">{feed.name}</p>
        )}
        <p className="flex min-w-0 items-center gap-1.5 text-[12px] text-muted">
          <span className="truncate">{feed.host}</span>
          {status ? <span className="shrink-0 text-faint">· {status}</span> : null}
        </p>
        {feed.lastError ? (
          <p className="cal-link-error" role="status">
            <AlertTriangle size={12} aria-hidden className="mt-0.5 shrink-0" />
            <span>{feed.lastError}</span>
          </p>
        ) : null}
      </div>
      {editing ? null : confirming ? (
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="text-[12px] text-muted">Remove?</span>
          <button type="button" className="btn-ghost px-2 py-0.5 text-[12px]" onClick={() => setConfirming(false)}>
            Keep
          </button>
          <button type="button" className="btn px-2 py-0.5 text-[12px] text-danger" onClick={() => remove.mutate()} disabled={remove.isPending}>
            Remove
          </button>
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-0.5">
          <button type="button" className="icon-btn h-7 w-7" aria-label={`Rename ${feed.name}`} title="Rename" onClick={() => setEditing(true)}>
            <Pencil size={13} aria-hidden />
          </button>
          <button type="button" className="icon-btn h-7 w-7" aria-label={`Remove ${feed.name}`} title="Remove" onClick={() => setConfirming(true)}>
            <Trash2 size={13} aria-hidden />
          </button>
        </div>
      )}
    </li>
  );
}

function AddFeed({ onDone }: { onDone: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const urlId = useId();
  const nameId = useId();
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const add = useMutation({
    mutationFn: () => api.addCalendarFeed({ url: url.trim(), ...(name.trim() ? { name: name.trim() } : {}) }),
    onSuccess: (result) => {
      toast(result.warning ? `${result.feed.name} added, but: ${result.warning}` : `${result.feed.name} added: ${plural(result.events, "event")} on Today.`, { tone: result.warning ? "error" : "ok" });
      setUrl("");
      setName("");
      invalidateCalendar(client);
      onDone();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (url.trim() && !add.isPending) add.mutate();
  };
  return (
    <form className="cal-link-form" onSubmit={submit} aria-label="Add calendar by URL (ICS)">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_12rem]">
        <label htmlFor={urlId} className="sr-only">
          Calendar link
        </label>
        <input
          id={urlId}
          className="field"
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="webcal://… or https://…/calendar.ics"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          aria-invalid={add.isError || undefined}
          aria-describedby={add.isError ? `${urlId}-error` : `${urlId}-hint`}
          autoFocus
        />
        <label htmlFor={nameId} className="sr-only">
          Name (optional)
        </label>
        <input id={nameId} className="field" placeholder="Name (optional)" maxLength={80} value={name} onChange={(event) => setName(event.target.value)} />
      </div>
      {add.isError ? (
        <p id={`${urlId}-error`} className="cal-link-error" role="alert">
          <AlertTriangle size={12} aria-hidden className="mt-0.5 shrink-0" />
          <span>{(add.error as Error).message}</span>
        </p>
      ) : (
        <p id={`${urlId}-hint`} className="text-[12px] leading-[18px] text-muted">
          Paste the private ICS, iCal or webcal address your calendar shares: iCloud (Share calendar → Public calendar), Google (Settings → Integrate calendar → Secret address in iCal format), Proton, Fastmail, Notion Calendar or a holiday calendar.
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="btn-primary" disabled={!url.trim() || add.isPending}>
          {add.isPending ? <Spinner size={12} /> : <Plus size={13} aria-hidden />} {add.isPending ? "Reading calendar…" : "Add calendar"}
        </button>
      </div>
    </form>
  );
}

/** The calendar links section on Settings → Connections (#calendars). */
export function CalendarLinksSection() {
  const feeds = useQuery({ queryKey: ["calendar-feeds"], queryFn: api.calendarFeeds });
  const sync = useCalendarSync();
  const list = feeds.data?.feeds ?? [];
  const [adding, setAdding] = useState(false);
  return (
    <SectionCard
      title="Calendars on Today"
      description="Google Calendar, Outlook and these calendar links show on Today as one calendar: a meeting or holiday in several of them shows once. They are read every 30 minutes and when you sync."
      actions={
        <>
          <button type="button" className="btn" onClick={() => sync.mutate()} disabled={sync.isPending}>
            <FetchGlyph active={sync.isPending} slot="connector.sync" size={12} /> Sync calendars
          </button>
          {adding ? null : (
            <button type="button" className="btn-primary" onClick={() => setAdding(true)}>
              <Link2 size={13} aria-hidden /> Add calendar by URL (ICS)
            </button>
          )}
        </>
      }
    >
      {adding ? <AddFeed onDone={() => setAdding(false)} /> : null}
      {feeds.isPending ? (
        <p className="text-[12.5px] text-muted">Loading calendar links…</p>
      ) : list.length ? (
        <ul className="cal-links" aria-label="Calendar links">
          {list.map((feed) => (
            <FeedRow key={feed.id} feed={feed} />
          ))}
        </ul>
      ) : adding ? null : (
        <p className="text-[12.5px] text-muted">No calendar links yet. Add one for iCloud, Proton, Fastmail, Notion Calendar or a holiday calendar.</p>
      )}
    </SectionCard>
  );
}
