"use client";

import type { ReactNode } from "react";

/**
 * Placeholders reserve their geometry and own their delayed visual reveal.
 * Results replace them immediately, including completion during the delay.
 * Cached data (`pending` false from the first paint) renders children immediately.
 */
export function Held({ pending, fallback, children }: { pending: boolean; fallback: ReactNode; children: ReactNode }) {
  if (pending) return fallback;
  return children;
}
