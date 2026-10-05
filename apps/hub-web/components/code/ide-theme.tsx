"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BUILTINS,
  cycleFavourite,
  loadBuiltinTheme,
  parseOpenVsxThemeId,
  sanitizeIdeTheme,
  ensembleDefaultTheme,
  ENSEMBLE_DEFAULT_ID,
  type IdeTheme,
  type ThemeFavourite,
} from "@ensemble/ide-theme";
import { isCycleFavouriteThemesShortcut } from "@ensemble/shared-types";
import { Palette } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { api as hub } from "@/lib/api";
import { useToast } from "../toast";
import { cx } from "../ui";
import { IdeThemeContext } from "./ide-theme-context";
import { ThemePicker } from "./theme-picker";

const STORE_KEY = "ensemble.ideTheme";

type Store = {
  activeId: string;
  favourites: ThemeFavourite[];
  themes: Record<string, IdeTheme>;
  order: string[];
};

type IdeApi = {
  shown: IdeTheme;
  committed: IdeTheme;
  favourites: ThemeFavourite[];
  setPreview: (theme: IdeTheme | null) => void;
  commit: (theme: IdeTheme) => void;
  setFavourites: (next: ThemeFavourite[]) => void;
  applyId: (id: string) => Promise<void>;
};

const ApiContext = createContext<IdeApi | null>(null);

function emptyStore(): Store {
  return { activeId: ENSEMBLE_DEFAULT_ID, favourites: [], themes: {}, order: [] };
}

function readStore(): Store {
  if (typeof window === "undefined") return emptyStore();
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORE_KEY) ?? "") as Partial<Store>;
    const themes: Record<string, IdeTheme> = {};
    for (const [id, value] of Object.entries(raw.themes ?? {})) {
      const clean = sanitizeIdeTheme(value);
      if (clean && clean.id === id) themes[id] = clean;
    }
    const favourites = Array.isArray(raw.favourites) ? raw.favourites.filter(isFavourite).slice(0, 3) : [];
    const activeId = typeof raw.activeId === "string" ? raw.activeId : ENSEMBLE_DEFAULT_ID;
    return { activeId, favourites, themes, order: Array.isArray(raw.order) ? raw.order.filter((id) => typeof id === "string") : [] };
  } catch {
    return emptyStore();
  }
}

function isFavourite(value: unknown): value is ThemeFavourite {
  if (!value || typeof value !== "object") return false;
  const row = value as ThemeFavourite;
  return typeof row.id === "string" && typeof row.label === "string" && (row.kind === "dark" || row.kind === "light" || row.kind === "hc") && (row.source === "builtin" || row.source === "openvsx");
}

function writeStore(theme: IdeTheme, favourites: ThemeFavourite[], previous: Store): void {
  const order = [theme.id, ...previous.order.filter((id) => id !== theme.id)].slice(0, 8);
  const keep = new Set([...order, ...favourites.map((item) => item.id)]);
  const themes: Record<string, IdeTheme> = {};
  for (const id of keep) {
    const next = id === theme.id ? theme : previous.themes[id];
    if (next) themes[id] = next;
  }
  const payload: Store = { activeId: theme.id, favourites, themes, order };
  window.localStorage.setItem(STORE_KEY, JSON.stringify(payload));
}

function surfaceStyle(theme: IdeTheme): CSSProperties {
  if (!Object.keys(theme.cssVars).length) return {};
  const style: Record<string, string> = { background: "var(--bg)", color: "var(--ink)", colorScheme: theme.kind === "light" ? "light" : "dark" };
  for (const [key, value] of Object.entries(theme.cssVars)) style[`--${key}`] = value;
  return style as CSSProperties;
}

export function IdeSpace({ className, children, diagram = false }: { className?: string; children: ReactNode; diagram?: boolean }) {
  const toast = useToast();
  const client = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: hub.settings, staleTime: 30_000 });
  const [committed, setCommitted] = useState<IdeTheme>(ensembleDefaultTheme);
  const [favourites, setFavouritesState] = useState<ThemeFavourite[]>([]);
  const [preview, setPreview] = useState<IdeTheme | null>(null);
  const store = useRef<Store>(emptyStore());
  const localChange = useRef(false);
  const committedRef = useRef(committed);
  const favouritesRef = useRef(favourites);
  committedRef.current = committed;
  favouritesRef.current = favourites;
  const shown = preview ?? committed;

  const resolveTheme = useCallback(async (id: string): Promise<IdeTheme> => {
    if (id === ENSEMBLE_DEFAULT_ID) return ensembleDefaultTheme;
    const cached = sanitizeIdeTheme(store.current.themes[id]);
    if (cached) return cached;
    if (id.startsWith("builtin:")) return (await loadBuiltinTheme(id)) ?? ensembleDefaultTheme;
    const parsed = parseOpenVsxThemeId(id);
    if (!parsed) return ensembleDefaultTheme;
    const loaded = await hub.loadOpenVsxTheme(parsed);
    const clean = loaded.theme ? sanitizeIdeTheme(loaded.theme) : null;
    if (!clean) throw new Error(loaded.reason ?? "Couldn't load that theme.");
    return clean;
  }, []);

  const persist = useCallback(
    async (theme: IdeTheme, nextFavourites: ThemeFavourite[]) => {
      writeStore(theme, nextFavourites, store.current);
      store.current = readStore();
      try {
        const saved = await hub.saveSettings({ ideTheme: { activeId: theme.id, favourites: nextFavourites } });
        client.setQueryData(["settings"], (current: { settings: unknown; connectors?: unknown } | undefined) =>
          current ? { ...current, settings: saved.settings } : current,
        );
      } catch {
        toast("Saved on this device. Ensemble couldn't reach its server, so another browser may not see it yet.");
      }
    },
    [client, toast],
  );

  const commit = useCallback(
    (theme: IdeTheme) => {
      localChange.current = true;
      setPreview(null);
      setCommitted(theme);
      void persist(theme, favouritesRef.current);
    },
    [persist],
  );

  const applyId = useCallback(
    async (id: string) => {
      try {
        commit(await resolveTheme(id));
      } catch (error) {
        toast((error as Error).message, { tone: "error" });
      }
    },
    [commit, resolveTheme, toast],
  );

  const setFavourites = useCallback(
    (next: ThemeFavourite[]) => {
      localChange.current = true;
      setFavouritesState(next);
      void persist(committedRef.current, next);
    },
    [persist],
  );

  useEffect(() => {
    store.current = readStore();
    setFavouritesState(store.current.favourites);
    const cached = sanitizeIdeTheme(store.current.themes[store.current.activeId]);
    if (cached) setCommitted(cached);
    else if (store.current.activeId.startsWith("builtin:")) {
      void loadBuiltinTheme(store.current.activeId).then((theme) => {
        if (theme && !localChange.current) setCommitted(theme);
      });
    }
  }, []);

  useEffect(() => {
    const ide = settings.data?.settings.ideTheme;
    if (!ide || localChange.current) return;
    setFavouritesState(ide.favourites);
    if (ide.activeId === committedRef.current.id) return;
    let cancel = false;
    void resolveTheme(ide.activeId)
      .then((theme) => {
        if (!cancel && !localChange.current) setCommitted(theme);
      })
      .catch(() => undefined);
    return () => {
      cancel = true;
    };
  }, [resolveTheme, settings.data]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isCycleFavouriteThemesShortcut(event)) return;
      if (document.querySelector("[data-ide-theme-picker]")) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable=true]")) return;
      event.preventDefault();
      const next = cycleFavourite(favouritesRef.current, committedRef.current.id);
      if (!next) {
        toast("Star up to 3 themes, then Alt+Shift+T switches between them.");
        return;
      }
      void applyId(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [applyId, toast]);

  const controls = useMemo<IdeApi>(
    () => ({ shown, committed, favourites, setPreview, commit, setFavourites, applyId }),
    [shown, committed, favourites, commit, setFavourites, applyId],
  );

  return (
    <ApiContext.Provider value={controls}>
      <IdeThemeContext.Provider value={shown}>
        <div className={cx("ide-space", className)} style={surfaceStyle(shown)} data-ide-theme={shown.id} data-ide-kind={shown.kind} {...(diagram ? { "data-diagram-editor": "" } : {})}>
          {children}
        </div>
      </IdeThemeContext.Provider>
    </ApiContext.Provider>
  );
}

function useIdeApi(): IdeApi {
  const controls = useContext(ApiContext);
  if (!controls) throw new Error("Theme controls belong inside the code space.");
  return controls;
}

export function ThemeControl() {
  const controls = useIdeApi();
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const close = () => {
    controls.setPreview(null);
    setOpen(false);
  };
  return (
    <>
      {controls.favourites.length ? (
        <div role="group" aria-label="Starred themes" className="flex max-w-[18rem] overflow-hidden rounded-md border border-line">
          {controls.favourites.map((fav) => (
            <button
              key={fav.id}
              type="button"
              title={fav.label}
              aria-pressed={fav.id === controls.committed.id}
              className={cx(
                "max-w-[7.5rem] truncate px-2 py-0.5 text-[12px]",
                fav.id === controls.committed.id ? "bg-hover font-medium text-ink" : "text-muted hover:bg-hover hover:text-ink",
              )}
              onClick={() => void controls.applyId(fav.id)}
            >
              {fav.label}
            </button>
          ))}
        </div>
      ) : null}
      <button
        ref={button}
        type="button"
        className={cx("btn", open && "bg-hover")}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Choose a theme. Alt+Shift+T switches starred themes."
        onClick={() => {
          if (open) close();
          else {
            setAnchor(button.current?.getBoundingClientRect() ?? null);
            setOpen(true);
          }
        }}
      >
        <Palette size={13} /> Theme
      </button>
      {open ? (
        <ThemePicker
          anchor={anchor}
          committed={controls.committed}
          favourites={controls.favourites}
          catalog={BUILTINS}
          onPreview={controls.setPreview}
          onCommit={(theme) => {
            controls.commit(theme);
            setOpen(false);
          }}
          onFavourites={controls.setFavourites}
          onClose={close}
        />
      ) : null}
    </>
  );
}
