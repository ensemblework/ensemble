"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { ArrowLeft, Plus, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Settings } from "@ensemble/shared-types";
import type { CatalogEntry, McpConnection } from "@/lib/api-connectors";
import { Modal } from "@/components/settings/modal";
import { QueryError, SkeletonRows, cx } from "../ui";
import { BrandLogo, TRADEMARK_NOTICE } from "./brand-logo";
import { categoryCounts, customConnections, filterEntries, isStoreCategory, STORE_CATEGORIES, type StoreCategory } from "./catalog-view";
import { ConnectorDetail, StatusBadge } from "./connector-detail";
import { CustomConnectionDetail, CustomConnectorForm } from "./custom-connector";
import { useCatalog, useMcpConnections } from "./use-connectors";

type Patch = (value: Record<string, unknown>) => void;

function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * The connector store: search, categories, and a detail page for each app,
 * all inside one dialog. The address carries the view (`store=<category>`,
 * `connector=<id>`), so a link or an OAuth return reopens the same place.
 */
export function ConnectorStore({
  open,
  category: rawCategory,
  connectorId,
  settings,
  patch,
  onNavigate,
  onClose,
  onImport,
}: {
  open: boolean;
  category: string | null;
  /** A catalog id, "custom" for the add form, or "mcp:<id>" for a custom server. */
  connectorId: string | null;
  settings?: Settings;
  patch?: Patch;
  onNavigate: (view: { store: string | null; connector: string | null }) => void;
  onClose: () => void;
  onImport: (source?: string) => void;
}) {
  const category: StoreCategory = isStoreCategory(rawCategory) ? rawCategory : "all";
  const catalog = useCatalog(open);
  const mcp = useMcpConnections(open);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const lastOpened = useRef<string | null>(null);
  const searchNext = useRef(false);
  const entries = useMemo(() => catalog.data?.entries ?? [], [catalog.data]);
  const connections = useMemo(() => mcp.data?.connections ?? [], [mcp.data]);
  const custom = useMemo(() => customConnections(connections, entries), [connections, entries]);
  const detail = Boolean(connectorId);
  const focusRef = detail ? headingRef : searchRef;

  const back = () => onNavigate({ store: rawCategory ?? "all", connector: null });
  const openEntry = (id: string) => {
    lastOpened.current = id;
    onNavigate({ store: rawCategory ?? "all", connector: id });
  };

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      if (connectorId) headingRef.current?.focus({ preventScroll: true });
      else {
        const card = searchNext.current ? undefined : Array.from(document.querySelectorAll<HTMLElement>("[data-store-card]")).find((node) => node.dataset.storeCard === lastOpened.current);
        searchNext.current = false;
        (card ?? searchRef.current)?.focus({ preventScroll: true });
      }
    });
    return () => window.cancelAnimationFrame(frame);
    // Focus moves only when the view changes, not on every catalog refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, connectorId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
      event.preventDefault();
      if (connectorId) {
        searchNext.current = true;
        onNavigate({ store: rawCategory ?? "all", connector: null });
      } else searchRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, connectorId, rawCategory, onNavigate]);

  const header = (
    <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2.5 sm:px-4">
      {detail ? (
        <button type="button" className="btn-ghost -ml-1" onClick={back}>
          <ArrowLeft size={14} /> All connectors
        </button>
      ) : (
        <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-panel px-2.5 focus-within:border-accent">
          <Search size={14} className="shrink-0 text-muted" aria-hidden />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.preventDefault();
                event.stopPropagation();
                event.nativeEvent.stopImmediatePropagation();
                setQuery("");
              }
            }}
            aria-label="Search connectors"
            placeholder="Search connectors"
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-faint [&::-webkit-search-cancel-button]:hidden"
          />
          <kbd className="kbd hidden sm:inline">/</kbd>
        </label>
      )}
      {detail ? <span className="flex-1" /> : null}
      <button type="button" className="icon-btn shrink-0" onClick={onClose} aria-label="Close">
        <X size={15} />
      </button>
    </div>
  );

  const footer = (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <p className={cx("max-w-[680px] text-[11.5px] leading-4 text-faint", !detail && "hidden md:block")} data-testid="trademark-notice">
        {TRADEMARK_NOTICE}
      </p>
      {connectorId === "custom" ? null : (
        <button type="button" className="btn shrink-0" onClick={() => onNavigate({ store: rawCategory ?? "all", connector: "custom" })}>
          <Plus size={12} /> Add custom connector
        </button>
      )}
    </div>
  );

  let body: React.ReactNode;
  if (connectorId === "custom") {
    body = <CustomConnectorForm headingRef={headingRef} onAdded={(id) => onNavigate({ store: "connected", connector: `mcp:${id}` })} />;
  } else if (connectorId?.startsWith("mcp:")) {
    const connection = connections.find((row) => row.id === connectorId.slice(4));
    body = connection ? (
      <CustomConnectionDetail connection={connection} headingRef={headingRef} />
    ) : mcp.isLoading ? (
      <SkeletonRows count={3} className="space-y-2 p-5" />
    ) : (
      <Missing headingRef={headingRef} onBack={back} />
    );
  } else if (connectorId) {
    const entry = entries.find((row) => row.id === connectorId);
    body = entry ? (
      <ConnectorDetail
        entry={entry}
        mcp={connections.find((row) => row.serverId === entry.id)}
        settings={settings}
        patch={patch}
        onImport={onImport}
        headingRef={headingRef}
      />
    ) : catalog.isLoading ? (
      <SkeletonRows count={4} className="space-y-2 p-5" />
    ) : catalog.error ? (
      <div className="p-5">
        <QueryError error={catalog.error as Error} retry={() => void catalog.refetch()} />
      </div>
    ) : (
      <Missing headingRef={headingRef} onBack={back} />
    );
  } else {
    body = (
      <Browse
        entries={entries}
        custom={custom}
        loading={catalog.isLoading}
        error={catalog.error as Error | null}
        retry={() => void catalog.refetch()}
        category={category}
        query={query}
        onCategory={(next) => onNavigate({ store: next, connector: null })}
        onClearQuery={() => {
          setQuery("");
          searchRef.current?.focus();
        }}
        onOpen={openEntry}
      />
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={detail && connectorId !== "custom" ? (entries.find((row) => row.id === connectorId)?.name ?? "Connector") : connectorId === "custom" ? "Add a custom connector" : "Connectors"}
      width={1000}
      height="min(80vh, 780px)"
      header={header}
      footer={footer}
      initialFocus={focusRef}
      scroll={detail}
      bodyClassName=""
      testId="connector-store"
    >
      {body}
    </Modal>
  );
}

function Missing({ onBack, headingRef }: { onBack: () => void; headingRef: React.Ref<HTMLHeadingElement> }) {
  return (
    <div className="p-6 text-[13px]">
      <h3 ref={headingRef} tabIndex={-1} className="text-[16px] font-semibold outline-none">
        This connector is not here
      </h3>
      <p className="mt-1 text-muted">It may have been removed, or the link is out of date.</p>
      <button type="button" className="btn mt-3" onClick={onBack}>
        See all connectors
      </button>
    </div>
  );
}

function Browse({
  entries,
  custom,
  loading,
  error,
  retry,
  category,
  query,
  onCategory,
  onClearQuery,
  onOpen,
}: {
  entries: CatalogEntry[];
  custom: McpConnection[];
  loading: boolean;
  error: Error | null;
  retry: () => void;
  category: StoreCategory;
  query: string;
  onCategory: (category: StoreCategory) => void;
  onClearQuery: () => void;
  onOpen: (id: string) => void;
}) {
  const counts = useMemo(() => {
    const base = categoryCounts(entries);
    base.connected += custom.length;
    return base;
  }, [entries, custom]);
  const categories = STORE_CATEGORIES.filter((row) => row.id === "all" || row.id === "connected" || counts[row.id] > 0);
  const shown = filterEntries(entries, { query, category });
  const words = query.trim().toLowerCase();
  const shownCustom = category === "connected" || category === "all" ? custom.filter((row) => !words || `${row.name} ${row.url}`.toLowerCase().includes(words)) : [];
  const label = STORE_CATEGORIES.find((row) => row.id === category)?.label ?? "All";
  return (
    <div className="flex h-full min-h-0">
      <nav aria-label="Categories" className="hidden w-52 shrink-0 overflow-y-auto border-r border-line p-2 md:block">
        <ul className="space-y-0.5">
          {categories.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                aria-current={row.id === category ? "true" : undefined}
                onClick={() => onCategory(row.id)}
                className={cx(
                  "row-tile flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[13px]",
                  row.id === category ? "bg-accent-soft font-medium text-ink" : "text-muted hover:text-ink",
                )}
              >
                <span className="truncate">{row.label}</span>
                <span className="text-[11.5px] tabular-nums text-faint">{counts[row.id]}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto p-3 sm:p-4" data-testid="store-results">
        <div className="-mx-3 mb-3 flex gap-1.5 overflow-x-auto px-3 pb-1 md:hidden" role="group" aria-label="Categories">
          {categories.map((row) => (
            <button
              key={row.id}
              type="button"
              aria-pressed={row.id === category}
              onClick={() => onCategory(row.id)}
              className={cx(
                "shrink-0 whitespace-nowrap rounded-full border px-2.5 py-1 text-[12.5px]",
                row.id === category ? "border-accent bg-accent-soft font-medium text-ink" : "border-line text-muted",
              )}
            >
              {row.label}
            </button>
          ))}
        </div>
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <h3 className="text-[13px] font-semibold">{label}</h3>
          {!loading && !error ? (
            <span className="text-[12px] text-faint" aria-live="polite">
              {shown.length + shownCustom.length} {shown.length + shownCustom.length === 1 ? "connector" : "connectors"}
            </span>
          ) : null}
        </div>
        {loading ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <SkeletonRows count={6} rowClassName="h-[92px]" className="contents" />
          </div>
        ) : error ? (
          <QueryError error={error} retry={retry} />
        ) : shown.length + shownCustom.length === 0 ? (
          <div className="empty-state" data-testid="store-empty">
            {query ? (
              <>
                Nothing matches “{query.trim()}”{category !== "all" ? ` in ${label}` : ""}.
                <div className="mt-2 flex flex-wrap gap-2">
                  {category !== "all" ? (
                    <button type="button" className="btn" onClick={() => onCategory("all")}>
                      Search all connectors
                    </button>
                  ) : null}
                  <button type="button" className="btn-ghost" onClick={onClearQuery}>
                    Clear search
                  </button>
                </div>
              </>
            ) : category === "connected" ? (
              "Nothing connected yet. Pick an app from All to start."
            ) : (
              "Nothing here yet."
            )}
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  data-store-card={entry.id}
                  onClick={() => onOpen(entry.id)}
                  className={cx(
                    "tile flex h-full w-full items-start gap-3 rounded-xl bg-panel p-3 text-left transition-colors hover:bg-hover focus-visible:border-accent focus-visible:outline-none",
                    entry.status === "soon" && "opacity-70",
                  )}
                >
                  <BrandLogo id={entry.logo} name={entry.name} size={36} decorative />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium">{entry.name}</span>
                    <span className="mt-0.5 line-clamp-2 block text-[12px] leading-4 text-muted">{entry.tagline}</span>
                    <span className="mt-1.5 block">
                      <StatusBadge entry={entry} />
                    </span>
                  </span>
                </button>
              </li>
            ))}
            {shownCustom.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  data-store-card={`mcp:${row.id}`}
                  onClick={() => onOpen(`mcp:${row.id}`)}
                  className="tile flex h-full w-full items-start gap-3 rounded-xl bg-panel p-3 text-left transition-colors hover:bg-hover focus-visible:border-accent focus-visible:outline-none"
                >
                  <BrandLogo id="custom" name={row.name} size={36} decorative />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium">{row.name}</span>
                    <span className="mt-0.5 block truncate font-mono text-[11.5px] text-muted">{row.url}</span>
                    <span className="mt-1.5 block text-[11.5px] text-faint">Custom · {row.status === "connected" ? `${row.toolCount} tools` : row.status}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-6 text-[11.5px] leading-4 text-faint md:hidden">{TRADEMARK_NOTICE}</p>
      </div>
    </div>
  );
}
