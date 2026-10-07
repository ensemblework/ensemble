"use client";

import { useQuery } from "@tanstack/react-query";
import {
  addFavourite,
  BUILTINS,
  loadBuiltinTheme,
  MAX_FAVOURITES,
  parseOpenVsxThemeId,
  removeFavourite,
  replaceFavourite,
  sanitizeIdeTheme,
  type BuiltinMeta,
  type IdeTheme,
  type ThemeDirectoryExtension,
  type ThemeFavourite,
  type ThemeKind,
} from "@ensemble/ide-theme";
import { Star } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "@/lib/api";
import { cx } from "../ui";

type Row = {
  key: string;
  id: string;
  label: string;
  publisher: string;
  kind: ThemeKind;
  badge: string;
  downloads?: number;
  supported: boolean;
  reason?: string;
  source: "builtin" | "openvsx";
  section: "Starred" | "Included" | "Theme directory";
  load: () => Promise<IdeTheme | null>;
};

export function ThemePicker({
  anchor,
  committed,
  favourites,
  catalog,
  onPreview,
  onCommit,
  onFavourites,
  onClose,
}: {
  anchor: DOMRect | null;
  committed: IdeTheme;
  favourites: ThemeFavourite[];
  catalog: BuiltinMeta[];
  onPreview: (theme: IdeTheme | null) => void;
  onCommit: (theme: IdeTheme) => void;
  onFavourites: (next: ThemeFavourite[]) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [index, setIndex] = useState(0);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [pending, setPending] = useState<ThemeFavourite | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const loaded = useRef(new Map<string, IdeTheme>());
  const request = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 220);
    return () => window.clearTimeout(timer);
  }, [query]);

  const remote = useQuery({
    queryKey: ["theme-search", debounced],
    queryFn: () => api.searchThemes(debounced),
    enabled: debounced.length >= 2,
    staleTime: 60_000,
  });

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = (text: string) => !needle || text.toLowerCase().includes(needle);
    const favIds = new Set(favourites.map((item) => item.id));
    const list: Row[] = [];
    for (const fav of favourites) {
      if (!matches(`${fav.label} ${fav.id}`)) continue;
      list.push(rowFromFavourite(fav));
    }
    for (const item of catalog) {
      if (favIds.has(item.id)) continue;
      if (!matches(`${item.label} ${item.publisher} ${item.attribution}`)) continue;
      list.push(rowFromBuiltin(item));
    }
    for (const extension of remote.data?.extensions ?? []) {
      if (extension.note && extension.themes.length === 0) {
        if (!matches(`${extension.displayName} ${extension.publisher} ${extension.description}`)) continue;
        list.push({
          key: `ext:${extension.namespace}/${extension.name}`,
          id: `ext:${extension.namespace}/${extension.name}`,
          label: extension.displayName,
          publisher: extension.publisher,
          kind: "dark",
          badge: "Not a color theme",
          downloads: extension.downloadCount,
          supported: false,
          reason: extension.note,
          source: "openvsx",
          section: "Theme directory",
          load: async () => null,
        });
        continue;
      }
      for (const theme of extension.themes) {
        if (!matches(`${theme.label} ${extension.displayName} ${extension.publisher} ${extension.description}`)) continue;
        list.push(rowFromDirectory(extension, theme));
      }
    }
    return list;
  }, [catalog, favourites, query, remote.data]);

  useEffect(() => {
    setIndex(0);
  }, [debounced, favourites.length]);

  useEffect(() => {
    search.current?.focus();
  }, []);

  useEffect(() => {
    const row = rows[index];
    if (!armed || !row || !row.supported) return;
    const cached = loaded.current.get(row.key);
    if (cached) {
      onPreview(cached);
      return;
    }
    const token = ++request.current;
    const timer = window.setTimeout(() => {
      setLoadingKey(row.key);
      void row
        .load()
        .then((theme) => {
          if (request.current !== token) return;
          if (!theme) {
            setNote("That theme couldn't be loaded.");
            return;
          }
          loaded.current.set(row.key, theme);
          onPreview(theme);
        })
        .catch((error: Error) => {
          if (request.current === token) setNote(error.message);
        })
        .finally(() => {
          if (request.current === token) setLoadingKey(null);
        });
    }, row.source === "builtin" ? 0 : 160);
    return () => window.clearTimeout(timer);
  }, [armed, index, onPreview, rows]);

  useEffect(() => {
    const option = dialog.current?.querySelector<HTMLElement>(`[data-theme-index="${index}"]`);
    option?.scrollIntoView({ block: "nearest" });
  }, [index]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setArmed(true);
        setIndex((current) => {
          if (!rows.length) return 0;
          const next = event.key === "ArrowDown" ? current + 1 : current - 1;
          return (next + rows.length) % rows.length;
        });
        return;
      }
      if (event.key === "Enter") {
        if ((event.target as HTMLElement | null)?.closest("button")) return;
        event.preventDefault();
        const row = rows[index];
        if (row) void choose(row);
        return;
      }
      if (event.key === "Tab" && dialog.current) {
        const items = [...dialog.current.querySelectorAll<HTMLElement>("button, input")].filter((el) => !el.hasAttribute("disabled"));
        const first = items[0];
        const last = items[items.length - 1];
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (dialog.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onPointer);
    };
  });

  const choose = async (row: Row) => {
    if (!row.supported) {
      setNote(row.reason ?? "This theme can't be applied.");
      return;
    }
    setNote(null);
    const theme = loaded.current.get(row.key) ?? (await row.load());
    if (!theme) {
      setNote(row.reason ?? "That theme couldn't be loaded.");
      return;
    }
    loaded.current.set(row.key, theme);
    onCommit(theme);
  };

  const star = (row: Row) => {
    if (!row.supported) return;
    const existing = favourites.find((item) => item.id === row.id);
    if (existing) {
      onFavourites(removeFavourite(favourites, row.id));
      setPending(null);
      return;
    }
    const next: ThemeFavourite = { id: row.id, label: row.label, kind: row.kind, source: row.source };
    const added = addFavourite(favourites, next);
    if (added.ok) {
      onFavourites(added.favourites);
      setPending(null);
      return;
    }
    setPending(next);
  };

  const top = anchor ? Math.min(anchor.bottom + 8, window.innerHeight - 120) : 64;
  const right = anchor ? Math.max(12, window.innerWidth - anchor.right) : 16;
  let lastSection = "";

  return createPortal(
    <div
      ref={dialog}
      role="dialog"
      aria-label="Choose a theme"
      data-ide-theme-picker=""
      className="pop-in fixed z-[60] flex w-[min(22.5rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-xl border border-line-strong bg-panel text-ink shadow-pop"
      style={{ top, right, maxHeight: "min(32rem, calc(100vh - 1.5rem))" }}
    >
      <div className="border-b border-line p-2">
        <input
          ref={search}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search themes"
          aria-label="Search themes"
          aria-controls="ide-theme-list"
          className="field w-full text-[13px]"
        />
      </div>
      <div id="ide-theme-list" role="listbox" aria-activedescendant={rows[index] ? `ide-theme-opt-${index}` : undefined} className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {rows.length === 0 && !remote.isFetching ? (
          <p className="px-2 py-6 text-center text-[13px] text-muted">{debounced.length >= 2 ? "No themes matched." : "No included themes matched."}</p>
        ) : null}
        {rows.map((row, rowIndex) => {
          const header = row.section !== lastSection;
          lastSection = row.section;
          const active = rowIndex === index;
          const starred = favourites.some((item) => item.id === row.id);
          return (
            <div key={row.key}>
              {header ? <div className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-faint">{row.section}</div> : null}
              <div
                id={`ide-theme-opt-${rowIndex}`}
                role="option"
                aria-selected={active}
                data-theme-index={rowIndex}
                className={cx("flex items-center gap-2 rounded-md px-2 py-1.5", active ? "bg-hover" : "hover:bg-hover")}
                onMouseEnter={() => {
                  setArmed(true);
                  setIndex(rowIndex);
                }}
              >
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => void choose(row)}>
                  <span className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium">{row.label}</span>
                    <span className="tag shrink-0" style={{ background: "var(--tag-gray-bg)", color: "var(--tag-gray-fg)" }}>
                      {row.badge}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate text-[12px] text-muted">
                    {row.publisher}
                    {row.downloads != null ? ` · ${row.downloads.toLocaleString("en-US")} downloads` : ""}
                    {loadingKey === row.key ? " · Loading colors…" : ""}
                  </span>
                  {!row.supported && row.reason ? <span className="mt-0.5 block text-[12px] text-muted">{row.reason}</span> : null}
                </button>
                {row.supported ? (
                  <button
                    type="button"
                    className={cx("icon-btn h-7 w-7 shrink-0", starred && "text-warn")}
                    aria-pressed={starred}
                    aria-label={starred ? `Remove ${row.label} from starred themes` : `Star ${row.label}`}
                    onClick={() => star(row)}
                  >
                    <Star size={14} className={starred ? "fill-current" : undefined} />
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
        {remote.isFetching ? <p className="px-2 py-2 text-[12.5px] text-muted">Searching the theme directory…</p> : null}
        {remote.isError ? <p className="px-2 py-2 text-[12.5px] text-muted">Search needs a connection. Included themes still work.</p> : null}
        {debounced.length < 2 && !query.trim() ? (
          <p className="px-2 py-2 text-[12px] leading-5 text-faint">Search to use any color theme made for VS Code or Cursor. Starred themes also switch with Alt+Shift+T.</p>
        ) : null}
      </div>
      {pending ? (
        <div role="alert" className="border-t border-line px-3 py-2 text-[12.5px]">
          <p>You can star {MAX_FAVOURITES} themes. Replace one to add {pending.label}.</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {favourites.map((fav) => (
              <button key={fav.id} type="button" className="btn" onClick={() => { onFavourites(replaceFavourite(favourites, fav.id, pending)); setPending(null); }}>
                Replace {fav.label}
              </button>
            ))}
            <button type="button" className="btn-ghost" onClick={() => setPending(null)}>Cancel</button>
          </div>
        </div>
      ) : null}
      {note ? <p className="border-t border-line px-3 py-2 text-[12.5px] text-muted">{note}</p> : null}
      <details className="border-t border-line px-3 py-2 text-[12px] text-muted">
        <summary className="cursor-pointer">Licenses for included themes</summary>
        <ul className="mt-2 space-y-1">
          {catalog.map((item) => (
            <li key={item.id}>
              <span className="text-ink">{item.label}</span> - {item.attribution}
            </li>
          ))}
        </ul>
      </details>
    </div>,
    document.body,
  );
}

function rowFromBuiltin(item: BuiltinMeta): Row {
  return {
    key: item.id,
    id: item.id,
    label: item.label,
    publisher: item.publisher,
    kind: item.kind,
    badge: item.badge ?? kindBadge(item.kind),
    supported: true,
    source: "builtin",
    section: "Included",
    load: () => loadBuiltinTheme(item.id),
  };
}

const BUILTIN_LOOKUP = new Map(BUILTINS.map((item) => [item.id, item]));

function rowFromFavourite(fav: ThemeFavourite): Row {
  const builtin = BUILTIN_LOOKUP.get(fav.id);
  return {
    key: `fav:${fav.id}`,
    id: fav.id,
    label: fav.label,
    publisher: builtin?.publisher ?? "Starred",
    kind: fav.kind,
    badge: builtin?.badge ?? kindBadge(fav.kind),
    supported: true,
    source: fav.source,
    section: "Starred",
    load: async () => {
      if (fav.source === "builtin" || fav.id.startsWith("builtin:")) return loadBuiltinTheme(fav.id);
      const parsed = parseOpenVsxThemeId(fav.id);
      if (!parsed) return null;
      const loaded = await api.loadOpenVsxTheme(parsed);
      return loaded.theme ? sanitizeIdeTheme(loaded.theme) : null;
    },
  };
}

function rowFromDirectory(extension: ThemeDirectoryExtension, theme: ThemeDirectoryExtension["themes"][number]): Row {
  const parsed = parseOpenVsxThemeId(theme.id);
  return {
    key: theme.id,
    id: theme.id,
    label: theme.label,
    publisher: extension.publisher || extension.namespace,
    kind: theme.kind,
    badge: kindBadge(theme.kind),
    downloads: extension.downloadCount,
    supported: theme.supported,
    reason: theme.reason,
    source: "openvsx",
    section: "Theme directory",
    load: async () => {
      if (!theme.supported || !parsed) return null;
      const loaded = await api.loadOpenVsxTheme({ ...parsed, label: theme.label });
      if (!loaded.theme) throw new Error(loaded.reason ?? "Couldn't load that theme.");
      const clean = sanitizeIdeTheme(loaded.theme);
      if (!clean) throw new Error("That theme's colors couldn't be read.");
      return clean;
    },
  };
}

function kindBadge(kind: ThemeKind): string {
  if (kind === "light") return "Light";
  if (kind === "hc") return "High contrast";
  return "Dark";
}
