"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { AppearanceSettings } from "@ensemble/shared-types";
import { MotionContextProvider } from "@/components/motion/slot";
import { ToastProvider } from "@/components/toast";
import { ApiError, api } from "@/lib/api";
import { isRequestCancelled } from "@/lib/fetch-cancel";
import { FetchGuards } from "@/lib/use-fetch-guards";
import { APPEARANCE_KEY, DEFAULT_APPEARANCE, applyAppearance, publishAppearance, resolveMotionTheme, storedMotionChosen, usePersistentState } from "@/lib/prefs";

function Appearance({ children }: { children: React.ReactNode }) {
  const [appearance, , ready] = usePersistentState<AppearanceSettings>(APPEARANCE_KEY, DEFAULT_APPEARANCE);
  const [osReduce, setOsReduce] = useState(false);
  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setOsReduce(motion.matches);
    sync();
    motion.addEventListener("change", sync);
    return () => motion.removeEventListener("change", sync);
  }, []);
  useEffect(() => {
    if (!ready) return;
    // A new browser has no local copy. The boot script already painted the
    // accent cookie; applying the default here would flash indigo over it.
    if (window.localStorage.getItem(APPEARANCE_KEY) === null && /(?:^|; )ensemble_accent=/.test(document.cookie)) return;
    applyAppearance(appearance);
    if (appearance.theme !== "system") return;
    const color = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => applyAppearance(appearance);
    color.addEventListener("change", onChange);
    return () => color.removeEventListener("change", onChange);
  }, [appearance, ready, osReduce]);
  useEffect(() => {
    if (!ready || storedMotionChosen()) return;
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const next = { ...appearance, motion: "minimal-dot" as const, reduceMotion: true };
    if (window.localStorage.getItem(APPEARANCE_KEY) === null && /(?:^|; )ensemble_accent=/.test(document.cookie)) {
      document.documentElement.dataset.motionTheme = "minimal-dot";
      document.documentElement.dataset.reduceMotion = "true";
      try {
        sessionStorage.setItem("ensemble.motion.auto", "1");
      } catch {
        // private mode
      }
      return;
    }
    publishAppearance(next);
    try {
      sessionStorage.setItem("ensemble.motion.auto", "1");
    } catch {
      // private mode
    }
    void api.saveSettings({ appearance: { motion: "minimal-dot", reduceMotion: true } }).catch(() => {});
  }, [appearance, ready]);
  const theme = resolveMotionTheme(appearance, osReduce);
  const reduce = appearance.reduceMotion || osReduce;
  return <MotionContextProvider value={{ theme, reduce }}>{children}</MotionContextProvider>;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => {
    const next = new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 20_000,
          refetchOnWindowFocus: false,
          retry: (failureCount, error) => {
            if (isRequestCancelled(error)) return false;
            if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
            return failureCount < 6;
          },
          retryDelay: (attempt) => Math.min(800 * 2 ** attempt, 8000),
        },
      },
    });
    const slow = { staleTime: 60_000 };
    for (const key of [["people"], ["projects"], ["repos"], ["skills"], ["preferences"], ["entities"], ["settings"], ["me"]]) {
      next.setQueryDefaults(key, key[0] === "me" ? { staleTime: 5 * 60_000 } : slow);
    }
    next.setQueryDefaults(["graph"], { staleTime: 30_000 });
    next.setQueryDefaults(["shell"], { staleTime: 30_000 });
    return next;
  });
  return (
    <QueryClientProvider client={client}>
      <FetchGuards />
      <ToastProvider>
        <Appearance>{children}</Appearance>
      </ToastProvider>
    </QueryClientProvider>
  );
}
