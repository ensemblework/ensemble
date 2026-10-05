"use client";

import type { QueryClient } from "@tanstack/react-query";

const pending = new Map<string, number>();

/**
 * Coalesce the mutation's invalidate with the SSE event for the same key.
 * The API publishes the event before the HTTP response returns, so both
 * land inside this window and become one refetch.
 */
export function invalidateSoon(client: QueryClient, queryKey: readonly unknown[], wait = 60): void {
  const id = JSON.stringify(queryKey);
  const existing = pending.get(id);
  if (existing) window.clearTimeout(existing);
  pending.set(
    id,
    window.setTimeout(() => {
      pending.delete(id);
      void client.invalidateQueries({ queryKey: [...queryKey] });
    }, wait),
  );
}
