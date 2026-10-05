"use client";

import { useCallback, useEffect, useState } from "react";
import type { AppearanceSettings, MotionTheme } from "@ensemble/shared-types";
import { accentChoice, resolveAccent } from "@/lib/accent";

const EVENT = "ensemble:pref";

function read<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

/**
 * UI state that survives reloads and stays in sync across tabs — sidebar
 * collapsed, peek width, graph layout. Server settings are for things that
 * matter to the agent; this is for things that only matter to this browser.
 */
export function usePersistentState<T>(key: string, fallback: T): [T, (value: T | ((prev: T) => T)) => void, boolean] {
  const [value, setValue] = useState<T>(fallback);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const load = () => setValue(storedPref(key, fallback, read(key, fallback)));
    load();
    setReady(true);
    const onStorage = (event: StorageEvent) => {
      if (event.key === key) load();
    };
    const onLocal = (event: Event) => {
      if ((event as CustomEvent<string>).detail === key) load();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(EVENT, onLocal);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(EVENT, onLocal);
    };
    // fallback is intentionally not a dependency: callers pass literals
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const update = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved = typeof next === "function" ? (next as (prev: T) => T)(prev) : next;
        try {
          window.localStorage.setItem(key, JSON.stringify(resolved));
          window.dispatchEvent(new CustomEvent(EVENT, { detail: key }));
        } catch {
          // storage full or disabled
        }
        return resolved;
      });
    },
    [key],
  );

  return [value, update, ready];
}

/**
 * localStorage key for this browser's appearance. The motion style is the
 * `motion` field: "expressive" | "minimal-quiet" | "minimal-dot".
 * Desktop and the static error pages must read this key, not ensemble:motion-theme.
 */
export const APPEARANCE_KEY = "ensemble.appearance";

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  theme: "dark",
  textScale: 100,
  font: "system",
  motion: "expressive",
  reduceMotion: false,
  accent: "indigo",
  accentCustom: null,
};

export function storedMotionChosen(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = JSON.parse(window.localStorage.getItem(APPEARANCE_KEY) || "null") as { motion?: string } | null;
    return !!raw && typeof raw === "object" && (raw.motion === "expressive" || raw.motion === "minimal-quiet" || raw.motion === "minimal-dot");
  } catch {
    return false;
  }
}

/** First visit on a device that asks for reduced motion starts on Minimal · Dot. */
export function resolveMotionTheme(appearance: AppearanceSettings, osReduce: boolean): MotionTheme {
  if (storedMotionChosen()) return appearance.motion ?? "expressive";
  if (osReduce) return "minimal-dot";
  return appearance.motion ?? "expressive";
}

/** Skip a server echo that would clobber an accent the user just picked. */
let accentWriteAt = 0;
export function markAccentWrite(): void {
  accentWriteAt = Date.now();
}
export function accentWriteIsFresh(): boolean {
  return Date.now() - accentWriteAt < 2500;
}

/** A partial `ensemble.appearance` blob must not drop fields the controls require. */
export function completeAppearance(value: Partial<AppearanceSettings> | null | undefined): AppearanceSettings {
  const raw = value && typeof value === "object" ? value : {};
  const textScale = typeof raw.textScale === "number" && Number.isFinite(raw.textScale) ? raw.textScale : DEFAULT_APPEARANCE.textScale;
  return { ...DEFAULT_APPEARANCE, ...raw, textScale };
}

function storedPref<T>(key: string, _fallback: T, stored: T): T {
  if (key !== APPEARANCE_KEY) return stored;
  return completeAppearance(stored as Partial<AppearanceSettings>) as T;
}

export function readAppearance(): AppearanceSettings {
  if (typeof window === "undefined") return DEFAULT_APPEARANCE;
  return completeAppearance(read(APPEARANCE_KEY, {}));
}

export function publishAppearance(next: AppearanceSettings): void {
  const accentAt = Date.now();
  try {
    window.localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ ...next, accentAt }));
    const custom = next.accentCustom;
    const value = custom && /^#[0-9a-fA-F]{6}$/.test(custom) ? `c:${custom}` : next.accent;
    document.cookie = `ensemble_accent=${encodeURIComponent(`${value}@${accentAt}`)}; Path=/; Max-Age=34560000; SameSite=Lax`;
    window.dispatchEvent(new CustomEvent(EVENT, { detail: APPEARANCE_KEY }));
  } catch {
    // storage full or disabled
  }
  applyAppearance(next);
}

export function applyAppearance(appearance: AppearanceSettings): void {
  const root = document.documentElement;
  const theme =
    appearance.theme === "system"
      ? window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"
      : appearance.theme;
  root.dataset.theme = theme;
  root.dataset.font = appearance.font;
  const osReduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const reduce = appearance.reduceMotion || osReduce;
  root.dataset.reduceMotion = String(reduce);
  root.dataset.motionTheme = resolveMotionTheme(appearance, osReduce);
  const textScale = Number.isFinite(appearance.textScale) ? appearance.textScale : DEFAULT_APPEARANCE.textScale;
  root.style.fontSize = `${textScale}%`;
  const resolved = resolveAccent(accentChoice(appearance, theme), theme);
  root.style.setProperty("--accent", resolved.hex);
  root.style.setProperty("--accent-rgb", resolved.rgb);
  root.style.setProperty("--accent-fg", resolved.fg);
  root.style.setProperty("--accent-hover", resolved.hover);
  root.style.setProperty("--accent-soft", resolved.soft);
  root.style.setProperty("--wash", resolved.wash);
  root.style.setProperty("--agent", resolved.hex);
  root.style.setProperty("--agent-soft", resolved.soft);
}
