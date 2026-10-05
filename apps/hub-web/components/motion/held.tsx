"use client";

import type { ReactNode } from "react";
import { useDelayedFlag } from "@/lib/motion/use-delayed-flag";

/**
 * Keeps a loading placeholder mounted through the show-delay and the minimum
 * hold. Unmounting the placeholder when the request finishes would cancel the hold.
 * Cached data (`pending` false from the first paint) renders children immediately.
 */
export function Held({ pending, fallback, children }: { pending: boolean; fallback: ReactNode; children: ReactNode }) {
  const shown = useDelayedFlag(pending);
  if (pending || shown) return fallback;
  return children;
}
