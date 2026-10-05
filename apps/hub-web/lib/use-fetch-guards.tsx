"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { beginNavigation, installFetchGuards } from "./fetch-cancel";
import { isPrefetchQuery, isPrefetchRequest } from "./prefetch";

/**
 * Aborts in-flight hub requests when a same-origin navigation starts, and
 * swallows unload / fire-and-forget cancellations. Queries that are still
 * on screen and have no data are fetched again so a shared request (shell,
 * settings) does not stay pending.
 */
export function FetchGuards(): null {
  const client = useQueryClient();
  useEffect(() => {
    return installFetchGuards((pathname) => {
      // The hover prefetch for the page being opened is already in flight.
      // Aborting it here makes the new page start the same request again.
      const keepRequest = (path: string) => (pathname ? isPrefetchRequest(pathname, path) : false);
      const keepQuery = (queryKey: readonly unknown[]) => (pathname ? isPrefetchQuery(client, pathname, queryKey) : false);
      if (!beginNavigation(keepRequest)) return;
      void client
        .cancelQueries({ predicate: (query) => !keepQuery(query.queryKey) }, { revert: true })
        .finally(() => {
          void client.refetchQueries({
            type: "active",
            predicate: (query) =>
              query.getObserversCount() > 0 &&
              query.state.data === undefined &&
              query.state.status === "pending" &&
              query.state.fetchStatus === "idle",
          });
        });
    });
  }, [client]);
  return null;
}
