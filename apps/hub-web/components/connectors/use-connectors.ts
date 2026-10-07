"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { CONNECTOR_QUERY, connectorsApi, type CatalogEntry, type ConnectorState } from "@/lib/api-connectors";

export function useCatalog(enabled = true) {
  return useQuery({ queryKey: CONNECTOR_QUERY.catalog, queryFn: connectorsApi.catalog, enabled, staleTime: 15_000 });
}

/** Remote MCP connections. Quiet when the server has no MCP routes. */
export function useMcpConnections(enabled = true) {
  return useQuery({ queryKey: CONNECTOR_QUERY.mcp, queryFn: connectorsApi.mcpConnections, enabled, retry: false, staleTime: 15_000 });
}

/** Everything a connect or disconnect can change. */
export function useRefreshConnections() {
  const client = useQueryClient();
  return useCallback(() => {
    void client.invalidateQueries({ queryKey: CONNECTOR_QUERY.catalog });
    void client.invalidateQueries({ queryKey: CONNECTOR_QUERY.mcp });
    void client.invalidateQueries({ queryKey: ["connections"] });
    void client.invalidateQueries({ queryKey: ["settings"] });
  }, [client]);
}

/** Write one entry's state into the cached catalog (optimistic updates and server answers). */
export function useSetEntryState() {
  const client = useQueryClient();
  return useCallback(
    (id: string, update: (state: ConnectorState) => ConnectorState) => {
      client.setQueryData<{ entries: CatalogEntry[] }>(CONNECTOR_QUERY.catalog, (old) =>
        old ? { ...old, entries: old.entries.map((entry) => (entry.id === id ? { ...entry, state: update(entry.state) } : entry)) } : old,
      );
    },
    [client],
  );
}
