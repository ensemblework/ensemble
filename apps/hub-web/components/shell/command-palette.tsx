"use client";

import { useQuery } from "@tanstack/react-query";
import { CornerDownLeft, type LucideIcon } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { activeShortcuts, useShortcuts } from "@/lib/shortcut-store";
import { shortcutHelp } from "@/lib/shortcut-help";
import { hasModule } from "@ensemble/shared-types/modules";
import { shellProfile } from "@/components/desk/tile-catalog";
import { DESK_IDS, DESKS, MARKET_ID } from "@/components/desk/desks";
import { api } from "@/lib/api";
import { switchSpace } from "@/lib/spaces";
import { plural } from "@/lib/format";
import { isApplePlatform } from "@/lib/platform";
import { findSettingsTarget, SETTINGS_DESTINATION_BY_ID } from "../settings/navigation";
import { navigationDestinations, navigationScore } from "./navigation-destinations";
import { useModalFocus } from "@/lib/modal-focus";
import { SearchQuery } from "@/components/motion/search-query";
import { HighlightMatch, searchHitHref } from "./search-match";
import { GROUP_TITLE, PALETTE_GROUPS, actionIcon, destinationIcon, hitKind, readRecents, rememberRecent, shortcutKeys, type PaletteGroup, type PaletteRecent } from "./palette-items";
import { cx } from "../ui";

const ACTIONS: Array<{ id: string; label: string; hint: string; run: () => void }> = [
  { id: "act-capture", label: "Quick capture", hint: "New reminder", run: () => window.dispatchEvent(new CustomEvent("ensemble:capture")) },
  { id: "act-help", label: "Keyboard shortcuts", hint: "Help", run: () => window.dispatchEvent(new CustomEvent("ensemble:help")) },
];

type Item = {
  id: string;
  group: PaletteGroup;
  label: string;
  hint: string;
  excerpt?: string;
  icon: LucideIcon;
  /** A workspace kind tint (`--kind-*`). */
  tint?: string;
  /** Shown on the right: the kind of a search hit. */
  meta?: string;
  keys?: string[];
  /** Set for anything that opens a page, so it can come back under Recent. */
  recent?: PaletteRecent;
  run: () => void;
};

const storage = () => {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
};

export function CommandPalette({ open, onClose, initialQuery = "" }: { open: boolean; onClose: () => void; initialQuery?: string }) {
  const router = useRouter();
  const dialog = useRef<HTMLDivElement>(null);
  useModalFocus(dialog, open, onClose);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [debounced, setDebounced] = useState("");
  const [submitted, setSubmitted] = useState(false);
  // The row that was selected when Enter was pressed while still searching.
  const submittedId = useRef<string | undefined>(undefined);
  useEffect(() => { setIndex(0); setSubmitted(false); const timer = window.setTimeout(() => setDebounced(query.trim()), 180); return () => clearTimeout(timer); }, [query]);
  const found = useQuery({ queryKey: ["workspace-search", debounced], queryFn: ({ signal }) => api.searchWorkspace(debounced, signal), enabled: open && Boolean(debounced), staleTime: 15_000, retry: false });
  const current = query.trim() === debounced;
  const pending = Boolean(query.trim()) && (!current || found.isPending);

  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, enabled: open, staleTime: 30_000 });
  const spaces = useQuery({ queryKey: ["spaces"], queryFn: api.spaces, enabled: open, staleTime: 30_000 });
  const space = shell.data?.space?.id ?? "default";
  const apple = isApplePlatform();

  const go = useMemo(() => (href: string) => {
    const url = new URL(href, window.location.origin);
    if (url.href === window.location.href) {
      const key = decodeURIComponent(url.hash.slice(1)), setting = SETTINGS_DESTINATION_BY_ID.get(key);
      const section = setting ? document.getElementById(setting.section) : null;
      (setting && section ? findSettingsTarget(section, setting.target) ?? section : document.getElementById(key))?.scrollIntoView({ block: "start" });
    } else router.push(href);
  }, [router]);

  const navigation = useMemo<Item[]>(() => {
    const modules = shell.data?.modules;
    const bindings = activeShortcuts();
    const actions = [
      ...ACTIONS,
      {
        id: "act-diagram",
        label: "Create diagram",
        hint: "New block diagram",
        run: () => {
          void api.createDiagram().then(({ diagram }) => router.push(`/diagrams/${diagram.id}`));
        },
      },
    ]
      .filter((action) => action.id !== "act-diagram" || hasModule(modules, "diagrams"))
      .concat(
        hasModule(modules, "plots")
          ? [{
              id: "act-plot",
              label: "Create plot",
              hint: "New 2D chart",
              run: () => {
                void api.createPlot().then(({ plot }) => router.push(`/plots/${plot.id}`));
              },
            }]
          : [],
      )
      .concat(
        (spaces.data?.spaces ?? [])
          .filter((space) => space.id !== spaces.data?.activeId)
          .map((space) => ({ id: `space-${space.id}`, label: `Switch to ${space.name}`, hint: "Space", run: () => void switchSpace(space.id) })),
        [{ id: "act-new-space", label: "New space", hint: "A separate line of work", run: () => router.push("/spaces/new") }],
      )
      .concat(
        shell.data?.devTools
          ? DESK_IDS.map((id) => ({
              id: `desk-${id}`,
              label: `Switch desk to ${DESKS[id].name}`,
              hint: "Tester",
              run: () => {
                void api.applyTemplate(MARKET_ID[id]).then(() => router.push("/today?apply=1"));
              },
            }))
          : [],
      )
      .filter((action) => navigationScore(query, action.label, action.hint)>0)
      .map((action): Item => ({
      id: action.id,
      group: "actions",
      label: action.label,
      hint: action.hint,
      icon: actionIcon(action.id),
      keys: shortcutKeys(action.id, bindings, apple),
      run: action.run,
    }));
    const destinations = navigationDestinations(query, { modules, guest:Boolean(shell.data?.space?.shared), template:shell.data?.activeTemplateId, boardLabel:shell.data?.labels?.board, profile:shellProfile(shell.data) }).map((row): Item => ({
      id: row.href,
      group: "go",
      label: row.label,
      hint: row.hint,
      icon: destinationIcon(row.href),
      keys: shortcutKeys(row.href, bindings, apple),
      recent: { label: row.label, hint: row.hint, href: row.href },
      run: () => go(row.href),
    }));
    return [...destinations, ...actions];
  }, [query, router, shell.data, spaces.data, go, apple]);

  // Read when the palette opens; what you open now shows next time.
  const recents = useMemo<Item[]>(() => open ? readRecents(storage(), space).map((row) => {
    const kind = row.kind ? hitKind(row.kind) : null;
    return { id: `recent-${row.href}`, group: "recent", label: row.label, hint: kind ? "" : row.hint, meta: kind?.label, icon: kind?.icon ?? destinationIcon(row.href), tint: kind?.tint, recent: row, run: () => go(row.href) };
  }) : [], [open, space, go]);

  const hits: Item[] = current ? (found.data?.results ?? []).map((hit): Item => {
    const kind = hitKind(hit.kind);
    return { id: `work-${hit.path}`, group: "work", label: hit.label, excerpt: hit.excerpt, hint: "", meta: kind.label, icon: kind.icon, tint: kind.tint, recent: { label: hit.label, hint: "", href: hit.path, kind: hit.kind }, run: () => router.push(searchHitHref(hit.path, query.trim())) };
  }) : [];
  const items = query.trim() ? [...hits, ...navigation] : [...recents, ...navigation];
  const sections = PALETTE_GROUPS.map((group) => ({ group, rows: items.filter((item) => item.group === group) })).filter((section) => section.rows.length);
  const choose = (item: Item) => {
    if (item.recent) rememberRecent(storage(), space, item.recent);
    item.run();
    onClose();
  };
  useEffect(() => {
    if (!open || !submitted || !current || pending) return;
    setSubmitted(false);
    const chosen = (submittedId.current ? items.find((item) => item.id === submittedId.current) : undefined) ?? (items.length === 1 ? items[0] : undefined);
    if (chosen) choose(chosen);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, submitted, current, pending, items, onClose]);

  useEffect(() => {
    if (!open) return;
    setQuery(initialQuery);
    setSubmitted(false);
    setIndex(0);
    const frame = requestAnimationFrame(() => input.current?.focus());
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => setIndex(0), [query]);

  const selectedId = items[Math.min(index, Math.max(items.length - 1, 0))]?.id;
  useEffect(() => {
    if (!open || !selectedId) return;
    const row = document.getElementById(`cmd-${selectedId}`);
    const box = document.getElementById("command-list");
    if (!row || !box) return;
    // The first row of a section brings its heading with it.
    const first = row.parentElement?.firstElementChild === row ? row.closest<HTMLElement>("[data-cmdk-section]") : null;
    const target = first ?? row;
    const rowRect = target.getBoundingClientRect();
    const listRect = box.getBoundingClientRect();
    const pad = 6;
    if (rowRect.top < listRect.top + pad) box.scrollTop -= listRect.top + pad - rowRect.top;
    else if (row.getBoundingClientRect().bottom > listRect.bottom - pad) box.scrollTop += row.getBoundingClientRect().bottom - (listRect.bottom - pad);
  }, [open, selectedId]);

  if (!open) return null;
  const selected = Math.min(index, Math.max(items.length - 1, 0));
  const trimmed = query.trim();
  let position = 0;

  return (
    <div className="cmdk-backdrop fixed inset-0 z-[70] flex items-start justify-center px-4 pt-[14vh]" onMouseDown={onClose}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-label="Search and jump" className="cmdk-dialog pop-in" onMouseDown={(event) => event.stopPropagation()}>
        <SearchQuery
          className="cmdk flex min-h-0 flex-1 flex-col"
          inputRef={input}
          value={query}
          onValue={setQuery}
          placeholder="Search your work, views and settings"
          label="Search your work, views and settings"
          pending={pending}
          // Views and settings are local: they stay listed while your work is still being searched.
          count={pending ? (items.length || null) : items.length}
          list
          controls="command-list"
          resultsId="command-list"
          activeDescendant={items[selected] ? `cmd-${items[selected].id}` : undefined}
          status={pending ? "Searching your work" : `${plural(items.length, "result")} · ↑↓ move · ↵ open`}
          emptyTitle={found.isError ? "Workspace search couldn’t load." : `No results for “${trimmed}”`}
          emptyHint={found.isError ? "Navigation still works. Try searching again in a moment." : "Try a title, a phrase in your notes, or a setting like Avatar."}
          resultsClassName="cmdk-list min-h-0 flex-1 overflow-y-auto overscroll-contain"
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setIndex((value) => Math.min(value + 1, items.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setIndex((value) => Math.max(value - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              if (pending) { submittedId.current = items[selected]?.id; setDebounced(query.trim()); setSubmitted(true); }
              else if (items[selected]) choose(items[selected]);
            } else if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
          results={
            <>
              {sections.map((section) => (
                <li key={section.group} role="presentation" className="cmdk-section" data-cmdk-section={section.group}>
                  <div className="cmdk-heading" id={`cmdk-group-${section.group}`} aria-hidden>{GROUP_TITLE[section.group]}</div>
                  <ul role="group" aria-labelledby={`cmdk-group-${section.group}`}>
                    {section.rows.map((item) => {
                      const itemIndex = position++;
                      const active = itemIndex === selected;
                      const Icon = item.icon;
                      return (
                        <li
                          key={item.id}
                          id={`cmd-${item.id}`}
                          className="sq-item cmdk-item"
                          role="option"
                          aria-selected={active}
                          // Moving the pointer selects; a list scrolled by the keyboard under a still pointer does not.
                          onMouseMove={() => { if (index !== itemIndex) setIndex(itemIndex); }}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => choose(item)}
                        >
                          <span className="cmdk-icon" data-tint={item.tint} aria-hidden><Icon size={15} strokeWidth={1.75} /></span>
                          <span className="cmdk-text">
                            <span className="cmdk-line">
                              <span className="cmdk-title"><HighlightMatch text={item.label} query={trimmed} /></span>
                              {item.hint ? <span className="cmdk-hint">{item.hint}</span> : null}
                            </span>
                            {item.excerpt ? <span className="cmdk-excerpt"><HighlightMatch text={item.excerpt} query={trimmed} /></span> : null}
                          </span>
                          {item.meta ? <span className="cmdk-meta">{item.meta}</span> : null}
                          {item.keys?.length ? (
                            <span className="cmdk-keys" aria-hidden>
                              {item.keys.map((key, at) => <kbd key={`${key}-${at}`} className="kbd">{key}</kbd>)}
                            </span>
                          ) : null}
                          <CornerDownLeft size={13} className="cmdk-enter" aria-hidden />
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </>
          }
        />
        <footer className="cmdk-foot" aria-hidden>
          <span className="cmdk-foot-keys">
            <span><kbd className="kbd">↑</kbd><kbd className="kbd">↓</kbd> Move</span>
            <span><kbd className="kbd">↵</kbd> Open</span>
            <span><kbd className="kbd">Esc</kbd> Close</span>
          </span>
          <span className="cmdk-foot-count">{pending ? "Searching…" : items.length ? plural(items.length, "result") : ""}</span>
        </footer>
      </div>
    </div>
  );
}

export function ShortcutSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { bindings } = useShortcuts();
  const pathname = usePathname();
  const dialog = useRef<HTMLDivElement>(null);
  useModalFocus(dialog, open, onClose);
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, enabled: open, staleTime: 30_000 });
  const groups = useMemo(
    () => shortcutHelp(bindings, { apple: isApplePlatform(), modules: shell.data?.modules, pathname }),
    [bindings, shell.data?.modules, pathname],
  );

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/45 px-4 pt-[18vh]" data-modal-layer="shortcuts" onMouseDown={onClose}>
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-sheet-title"
        tabIndex={-1}
        className="pop-in max-h-[70vh] w-full max-w-[460px] overflow-y-auto rounded-xl border border-line-strong bg-panel p-4 shadow-pop"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 id="shortcut-sheet-title" className="text-[15px] font-semibold">Shortcuts</h2>
          <span className="flex items-center gap-1">
            <a href="/settings?tab=shortcuts" className="btn-ghost" onClick={onClose}>
              Change
            </a>
            <button type="button" className="btn-ghost" onClick={onClose}>
              Close
            </button>
          </span>
        </div>
        {groups.map((group) => (
          <section key={group.title} className="mb-3 last:mb-0" aria-labelledby={`shortcut-group-${group.title}`}>
            <h3 id={`shortcut-group-${group.title}`} className="mb-1.5 text-[11.5px] font-medium uppercase tracking-[0.06em] text-faint">{group.title}</h3>
            <ul className="space-y-1.5">
              {group.rows.map((row) => (
                <li key={row.label} className="flex items-center justify-between gap-4 text-[13px]">
                  <span className="text-muted">{row.label}</span>
                  <span className="flex shrink-0 items-center gap-1 text-[12px] text-faint">
                    {row.keys.map((keys, index) => (
                      <span key={keys} className="flex items-center gap-1">
                        {index ? "or" : null}
                        <kbd className="kbd">{keys}</kbd>
                      </span>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
