"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Check, Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { APP_ITEM_KIND_LABEL, type AppItem, type AppItemKind, type AppItemSourceInfo } from "@ensemble/shared-types";
import { APP_ITEM_QUERY, appItemsApi, type AppItemRef } from "@/lib/api-app-items";
import { plural } from "@/lib/format";
import { BrandLogo, brandName } from "../connectors/brand-logo";
import { Dialog, SkeletonRows, Spinner, cx } from "../ui";
import { sourceInfo, useAppItemSources } from "./use-app-items";

export const SETTINGS_CONNECTIONS = "/settings?tab=connections";

export type AppItemAction = {
  label: string;
  /** Shown on the row once the action worked, e.g. "Attached". */
  doneLabel?: string;
  onPick: (item: AppItem) => Promise<void> | void;
};

export const itemKey = (item: AppItemRef) => `${item.source}:${item.kind}:${item.id}`;

export function problemText(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

/** An app's error, with the way to Settings when the fix is to connect it there. */
export function ProblemNote({ message, className, onNavigate }: { message: string; className?: string; onNavigate?: () => void }) {
  return (
    <p role="alert" className={cx("text-[12.5px] text-danger", className)}>
      {message}
      {/Settings → Connections/.test(message) ? (
        <>
          {" "}
          <Link href={SETTINGS_CONNECTIONS} onClick={onNavigate} className="text-accent underline-offset-2 hover:underline">
            Open Connections
          </Link>
        </>
      ) : null}
    </p>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

function names(list: string[]): string {
  return list.length > 1 ? `${list.slice(0, -1).join(", ")} or ${list.at(-1)}` : (list[0] ?? "");
}

/**
 * Search the person's connected apps and act on one item: attach it, add it as a
 * task, use a repository… The caller names the action. The dialog stays open after
 * a pick so several can be added; close it from `onPick` when one is enough.
 */
export function AppItemPicker({
  open,
  onClose,
  title = "Add from your apps",
  description,
  kinds,
  sources,
  actionLabel,
  doneLabel,
  onPick,
  secondaryAction,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  /** Only these kinds are offered and listed. */
  kinds?: AppItemKind[];
  /** Only these apps (source ids) are offered. */
  sources?: string[];
  actionLabel: string;
  doneLabel?: string;
  onPick: (item: AppItem) => Promise<void> | void;
  secondaryAction?: AppItemAction;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={title} width={720}>
      {open ? (
        <PickerBody
          onClose={onClose}
          description={description}
          kinds={kinds}
          only={sources}
          primary={{ label: actionLabel, doneLabel, onPick }}
          secondary={secondaryAction}
        />
      ) : null}
    </Dialog>
  );
}

function PickerBody({
  onClose,
  description,
  kinds,
  only,
  primary,
  secondary,
}: {
  onClose: () => void;
  description?: string;
  kinds?: AppItemKind[];
  only?: string[];
  primary: AppItemAction;
  secondary?: AppItemAction;
}) {
  const listId = useId();
  const connected = useAppItemSources();
  const offered = connected.sources.filter((source) => (!only || only.includes(source.id)) && (!kinds || source.kinds.some((kind) => kinds.includes(kind))));
  const [chosen, setChosen] = useState<string | null>(null);
  const app = offered.length === 1 ? offered[0]!.id : offered.some((source) => source.id === chosen) ? chosen : null;
  const appName = app ? sourceInfo(offered, app).name : null;
  const kindChoices = kindsOf(app ? offered.filter((source) => source.id === app) : offered, kinds);
  const [pickedKind, setPickedKind] = useState<AppItemKind | "">("");
  const kind = kindChoices.length === 1 ? kindChoices[0] : kindChoices.find((value) => value === pickedKind);
  const [text, setText] = useState("");
  const q = useDebounced(text.trim(), 250);
  const input = { source: app ?? undefined, q, kind, limit: app ? 20 : 10 };
  const search = useQuery({
    queryKey: APP_ITEM_QUERY.search(input),
    queryFn: ({ signal }) => appItemsApi.search(input, signal),
    enabled: offered.length > 0,
    staleTime: 30_000,
    retry: false,
    placeholderData: keepPreviousData,
  });
  const items = (search.data?.items ?? []).filter((item) => (!only || only.includes(item.source)) && (!kinds || kinds.includes(item.kind)));
  const appErrors = (search.data?.errors ?? []).filter((row) => !only || only.includes(row.source));

  const [active, setActive] = useState(0);
  const byKeys = useRef(false);
  const current = items.length ? Math.min(active, items.length - 1) : -1;
  const rowId = (index: number) => `${listId}-row-${index}`;
  useEffect(() => setActive(0), [q, app, kind]);
  useEffect(() => {
    if (!byKeys.current || current < 0) return;
    byKeys.current = false;
    document.getElementById(`${listId}-row-${current}`)?.scrollIntoView?.({ block: "nearest" });
  }, [current, listId]);

  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, "primary" | "secondary">>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const run = async (item: AppItem, which: "primary" | "secondary") => {
    const action = which === "primary" ? primary : secondary;
    const key = itemKey(item);
    if (!action || busy || done[key]) return;
    setBusy(`${key}|${which}`);
    setFailure(null);
    try {
      await action.onPick(item);
      setDone((value) => ({ ...value, [key]: which }));
    } catch (caught) {
      setFailure(problemText(caught));
    } finally {
      setBusy(null);
    }
  };

  const settingsLink = useRef<HTMLAnchorElement>(null);
  const nothing = !connected.loading && !connected.error && offered.length === 0;
  useEffect(() => {
    if (nothing) settingsLink.current?.focus();
  }, [nothing]);

  if (nothing) {
    const wanted = only?.map((id) => brandName(id)) ?? [];
    return (
      <div className="empty-state" data-testid="app-items-none">
        <div className="mb-1 font-medium text-ink">{wanted.length ? `Connect ${names(wanted)} first` : "Nothing to pick from yet"}</div>
        <p>
          {wanted.length
            ? `Once ${names(wanted)} is connected in Settings → Connections, you can pick from it here.`
            : connected.sources.length
              ? "None of your connected apps has this kind of item. Connect another one in Settings → Connections."
              : "Connect Notion, GitHub, Linear, Slack, Google Drive or another app in Settings → Connections, then search it here."}
        </p>
        <Link ref={settingsLink} href={SETTINGS_CONNECTIONS} onClick={onClose} className="btn mt-3 inline-flex">
          Open Settings → Connections
        </Link>
      </div>
    );
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!items.length) return;
      byKeys.current = true;
      setActive(Math.max(0, Math.min(items.length - 1, current + (event.key === "ArrowDown" ? 1 : -1))));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = items[current];
      if (item) void run(item, "primary");
    } else if (event.key === "Escape" && text) {
      event.preventDefault();
      setText("");
    }
  };

  return (
    <div className="text-[13px]" data-testid="app-item-picker">
      <label className="flex h-9 min-w-0 items-center gap-2 rounded-lg border border-line bg-panel px-2.5 focus-within:border-accent">
        <Search size={14} className="shrink-0 text-muted" aria-hidden />
        <input
          type="search"
          role="combobox"
          aria-label={appName ? `Search ${appName}` : "Search your apps"}
          aria-autocomplete="list"
          aria-expanded={items.length > 0}
          aria-controls={listId}
          aria-activedescendant={current >= 0 ? rowId(current) : undefined}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={appName ? `Search ${appName}, or paste a link` : "Search your apps, or paste a link"}
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-faint [&::-webkit-search-cancel-button]:hidden"
        />
        {search.isFetching ? <Spinner size={12} /> : null}
      </label>
      {description ? <p className="mt-2 text-[12.5px] text-muted">{description}</p> : null}

      {offered.length > 1 || kindChoices.length > 1 ? (
        <div className="mt-2.5 flex items-start gap-2">
          {offered.length > 1 ? (
            <div className="-mx-1 flex min-w-0 flex-1 gap-1.5 overflow-x-auto px-1 pb-1 sm:flex-wrap" role="group" aria-label="Apps">
              <Chip on={!app} onClick={() => setChosen(null)}>
                All apps
              </Chip>
              {offered.map((source) => (
                <Chip key={source.id} on={app === source.id} onClick={() => setChosen(source.id)}>
                  <BrandLogo id={source.logo} name={source.name} size={16} decorative />
                  {source.name}
                </Chip>
              ))}
            </div>
          ) : (
            <span className="flex-1" />
          )}
          {kindChoices.length > 1 ? (
            <select className="field shrink-0 py-1 text-[12.5px]" aria-label="Kind" value={kind ?? ""} onChange={(event) => setPickedKind(event.target.value as AppItemKind | "")}>
              <option value="">All kinds</option>
              {kindChoices.map((value) => (
                <option key={value} value={value}>
                  {APP_ITEM_KIND_LABEL[value]}
                </option>
              ))}
            </select>
          ) : null}
        </div>
      ) : null}

      <div className="mb-1 mt-3 flex items-baseline justify-between gap-2 text-[12px] text-muted">
        <span>{q ? "Results" : appName ? `Recent in ${appName}` : "Recent in your apps"}</span>
        {search.data && !search.isPlaceholderData ? <span className="text-faint" aria-live="polite">{plural(items.length, "item")}</span> : null}
      </div>

      {connected.error ? (
        <ProblemNote message={problemText(connected.error)} />
      ) : connected.loading || search.isPending ? (
        <SkeletonRows count={4} rowClassName="h-12" />
      ) : search.error ? (
        <ProblemNote message={problemText(search.error)} onNavigate={onClose} />
      ) : items.length === 0 ? (
        <div className="empty-state" data-testid="app-items-empty">
          {q ? `Nothing matches “${q}”. Try other words, or paste a link to the item.` : "Nothing recent here. Search for it, or paste a link."}
        </div>
      ) : (
        <ul id={listId} role="listbox" aria-label="Items" className="max-h-[min(52dvh,440px)] space-y-0.5 overflow-y-auto">
          {items.map((item, index) => {
            const key = itemKey(item);
            const info = sourceInfo(connected.sources, item.source);
            return (
              <li
                key={key}
                id={rowId(index)}
                role="option"
                aria-selected={index === current}
                data-app-item={key}
                onMouseEnter={() => setActive(index)}
                className={cx("rounded-lg px-2 py-2", index === current && "bg-hover")}
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <div className="flex min-w-0 flex-1 basis-[220px] items-start gap-2.5">
                    <BrandLogo id={info.logo} name={info.name} size={22} className="mt-0.5" />
                    <div className="min-w-0">
                      <div className="truncate text-[13.5px] font-medium">{item.title || "Untitled"}</div>
                      <div className="truncate text-[12px] text-muted">{[APP_ITEM_KIND_LABEL[item.kind], item.subtitle].filter(Boolean).join(" · ")}</div>
                    </div>
                  </div>
                  <div className="ml-auto flex shrink-0 items-center gap-1">
                    {item.url ? (
                      <a href={item.url} target="_blank" rel="noreferrer" className="btn-ghost text-[12px]" aria-label={`Open ${item.title} in ${info.name}`}>
                        Open ↗
                      </a>
                    ) : null}
                    <button type="button" className="btn-ghost text-[12px]" aria-expanded={preview === key} onClick={() => setPreview(preview === key ? null : key)}>
                      Preview
                    </button>
                    {secondary ? <ActionButton action={secondary} busy={busy === `${key}|secondary`} locked={Boolean(busy) || Boolean(done[key])} done={done[key] === "secondary"} onClick={() => void run(item, "secondary")} /> : null}
                    <ActionButton action={primary} busy={busy === `${key}|primary`} locked={Boolean(busy) || Boolean(done[key])} done={done[key] === "primary"} onClick={() => void run(item, "primary")} />
                  </div>
                </div>
                {preview === key ? <Preview item={item} /> : null}
              </li>
            );
          })}
        </ul>
      )}

      {appErrors.length ? (
        <ul className="mt-2 space-y-1 text-[12px] text-muted" aria-label="Apps that did not answer">
          {appErrors.map((row) => {
            const info = sourceInfo(connected.sources, row.source);
            return (
              <li key={row.source} className="flex items-start gap-1.5">
                <BrandLogo id={info.logo} name={info.name} size={14} decorative className="mt-0.5" />
                <span>
                  <span className="text-ink/80">{info.name}:</span> {row.message}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {failure ? <ProblemNote message={failure} className="mt-2" onNavigate={onClose} /> : null}
      <p className="mt-3 hidden text-[11.5px] text-faint sm:block">↑ ↓ to move · Enter to {primary.label.toLowerCase()}</p>
    </div>
  );
}

function kindsOf(sources: AppItemSourceInfo[], allowed?: AppItemKind[]): AppItemKind[] {
  const seen = new Set<AppItemKind>();
  for (const source of sources) for (const kind of source.kinds) if (!allowed || allowed.includes(kind)) seen.add(kind);
  return [...seen];
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cx(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-[12.5px]",
        on ? "border-accent bg-accent-soft font-medium text-ink" : "border-line text-muted hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

function ActionButton({ action, busy, locked, done, onClick }: { action: AppItemAction; busy: boolean; locked: boolean; done: boolean; onClick: () => void }) {
  return (
    <button type="button" className="btn text-[12.5px]" disabled={locked} onClick={onClick}>
      {busy ? <Spinner size={12} /> : done ? <Check size={12} aria-hidden /> : null}
      {done ? (action.doneLabel ?? "Done") : action.label}
    </button>
  );
}

const PREVIEW_CHARS = 800;

function Preview({ item }: { item: AppItem }) {
  const read = useQuery({ queryKey: APP_ITEM_QUERY.read(item), queryFn: () => appItemsApi.read(item), staleTime: 5 * 60_000, retry: false });
  const content = read.data?.item;
  const text = content?.text.trim() ?? "";
  const facts = Object.entries(content?.facts ?? {});
  return (
    <div className="mt-2 rounded-md border border-line bg-panel px-3 py-2 text-[12.5px] sm:ml-8" data-testid="app-item-preview">
      {read.isPending ? (
        <SkeletonRows count={2} rowClassName="h-4" />
      ) : read.error ? (
        <ProblemNote message={problemText(read.error)} />
      ) : (
        <>
          {facts.length ? <p className="mb-1 text-muted">{facts.map(([name, value]) => `${name}: ${value}`).join(" · ")}</p> : null}
          <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words leading-5 text-ink/85">
            {text ? (text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS).trimEnd()}…` : text) : "No text in this item."}
          </p>
        </>
      )}
    </div>
  );
}
