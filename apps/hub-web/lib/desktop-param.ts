"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

type DesktopWindow = Window & { __ENSEMBLE_DESKTOP__?: { apiBase?: string } };

export function desktopShell(): boolean {
  return typeof window !== "undefined" && Boolean((window as DesktopWindow).__ENSEMBLE_DESKTOP__);
}

/** The id the static export bakes into a dynamic route's one HTML file. */
export const BAKED_PARAM = "_";

/** True until the desktop page has read the real id; fetching with it would ask the API for "_". */
export function isBakedParam(value: string): boolean {
  return value === BAKED_PARAM;
}

/** The static export bakes "_". A full page load keeps the real id in the address bar. */
export function pathParam(fallback: string): string {
  if (!desktopShell()) return fallback;
  const parts = window.location.pathname.split("/").filter(Boolean);
  const last = parts[parts.length - 1];
  return last ? decodeURIComponent(last) : fallback;
}

/** The last segment of a path, decoded: `/tasks/abc/` → `abc`. */
export function lastSegment(pathname: string): string | null {
  const last = pathname.split("/").filter(Boolean).pop();
  return last ? decodeURIComponent(last) : null;
}

/**
 * The route's id. On the desktop every id shares the one "_" page, and moving from one task
 * to another happens in place, so the id comes from the address on each render, not once.
 * The first render returns the baked value, like the static HTML it hydrates.
 */
export function useDesktopParam(baked: string | undefined): string {
  const initial = baked ?? "";
  const pathname = usePathname();
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    setDesktop(desktopShell());
  }, []);
  if (!desktop) return initial;
  return (pathname ? lastSegment(pathname) : null) ?? pathParam(initial);
}
