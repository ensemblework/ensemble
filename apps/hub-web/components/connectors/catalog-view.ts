import { CONNECTOR_CATEGORIES, type ConnectorAuthKind, type ConnectorCategory } from "@ensemble/shared-types";
import type { CatalogEntry, McpConnection } from "@/lib/api-connectors";

/** The short list on Settings → Connections, in this order. */
export const FEATURED_ORDER = ["google_workspace", "microsoft_365", "notion", "linear", "github"] as const;

export type StoreCategory = "all" | "connected" | "import" | ConnectorCategory;

export const STORE_CATEGORIES: ReadonlyArray<{ id: StoreCategory; label: string }> = [
  { id: "all", label: "All" },
  { id: "connected", label: "Connected" },
  ...CONNECTOR_CATEGORIES,
  { id: "import", label: "Import" },
];

export function isStoreCategory(value: string | null | undefined): value is StoreCategory {
  return Boolean(value) && STORE_CATEGORIES.some((category) => category.id === value);
}

export function featuredEntries(entries: readonly CatalogEntry[]): CatalogEntry[] {
  const rank = (id: string) => {
    const index = (FEATURED_ORDER as readonly string[]).indexOf(id);
    return index === -1 ? FEATURED_ORDER.length : index;
  };
  return entries.filter((entry) => entry.featured).sort((a, b) => rank(a.id) - rank(b.id));
}

export function mcpConnected(entry: CatalogEntry): boolean {
  return entry.state.mcp?.status === "connected";
}

/** Signed in, a token saved, or the vendor's MCP server connected. */
export function isConnected(entry: CatalogEntry): boolean {
  return entry.state.connected || mcpConnected(entry);
}

/** Browser sign-in is set up on this server (the operator registered the provider's app). */
export function oauthReady(entry: CatalogEntry): boolean {
  return entry.state.oauthReady ?? entry.state.appReady;
}

/** Auth kinds that work on this server right now. */
export function usableAuth(entry: CatalogEntry): ConnectorAuthKind[] {
  return entry.auth.filter((kind) => kind !== "oauth" || oauthReady(entry));
}

export type EntryStatus = "connected" | "attention" | "pending" | "available" | "not_set_up" | "soon";

export function entryStatus(entry: CatalogEntry): EntryStatus {
  if (entry.status === "soon") return "soon";
  const sourceError = Object.values(entry.state.sources ?? {}).some((source) => source.enabled && source.lastError);
  if (isConnected(entry)) return sourceError || entry.state.mcp?.status === "error" ? "attention" : "connected";
  if (entry.state.mcp?.status === "pending") return "pending";
  if (entry.state.mcp?.status === "error") return "attention";
  if (entry.auth.includes("builtin")) return "connected";
  return entry.state.appReady && usableAuth(entry).length ? "available" : "not_set_up";
}

export function statusLabel(entry: CatalogEntry): string {
  const status = entryStatus(entry);
  switch (status) {
    case "connected":
      if (entry.auth.includes("builtin") && !entry.state.connected) return "Built in";
      return entry.state.account ? `Connected as ${entry.state.account}` : "Connected";
    case "attention":
      return entry.state.account ? `${entry.state.account} · needs attention` : "Needs attention";
    case "pending":
      return "Waiting for approval";
    case "not_set_up":
      return "Not set up on this server";
    case "soon":
      return "Coming soon";
    default:
      return entry.auth.every((kind) => kind === "file") ? "Import from a file" : "Not connected";
  }
}

function haystack(entry: CatalogEntry): string {
  const category = CONNECTOR_CATEGORIES.find((row) => row.id === entry.category)?.label ?? "";
  return [
    entry.name,
    entry.vendor,
    entry.tagline,
    category,
    ...(entry.products ?? []).map((product) => product.name),
    ...entry.reads,
    ...entry.writes,
    entry.import ? "import" : "",
  ]
    .join(" ")
    .toLowerCase();
}

/** Every word of the query must appear somewhere in the entry. Ready entries come before "soon" ones. */
export function filterEntries(entries: readonly CatalogEntry[], options: { query?: string; category?: StoreCategory }): CatalogEntry[] {
  const words = (options.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const category = options.category ?? "all";
  const matches = entries.filter((entry) => {
    if (category === "connected" && !isConnected(entry)) return false;
    if (category === "import" && !entry.import) return false;
    if (category !== "all" && category !== "connected" && category !== "import" && entry.category !== category) return false;
    if (!words.length) return true;
    const text = haystack(entry);
    return words.every((word) => text.includes(word));
  });
  return matches
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => Number(a.entry.status === "soon") - Number(b.entry.status === "soon") || a.index - b.index)
    .map((row) => row.entry);
}

export function categoryCounts(entries: readonly CatalogEntry[]): Record<StoreCategory, number> {
  const counts = Object.fromEntries(STORE_CATEGORIES.map((category) => [category.id, 0])) as Record<StoreCategory, number>;
  for (const entry of entries) {
    counts.all += 1;
    counts[entry.category] = (counts[entry.category] ?? 0) + 1;
    if (isConnected(entry)) counts.connected += 1;
    if (entry.import) counts.import += 1;
  }
  return counts;
}

/** Custom servers added by URL (no catalog entry). */
export function customConnections(connections: readonly McpConnection[], entries: readonly CatalogEntry[]): McpConnection[] {
  const known = new Set(entries.map((entry) => entry.id));
  return connections.filter((connection) => !connection.serverId || !known.has(connection.serverId));
}

/** Where OAuth and MCP sign-in send the person back: this connector's detail in the store. */
export function connectorReturnTo(id: string, pathname = "/settings"): string {
  return `${pathname}?tab=connections&connector=${encodeURIComponent(id)}`;
}
