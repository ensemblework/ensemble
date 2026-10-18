import { CONNECTOR_CATEGORIES, TASK_LIKE_KINDS, type AppItemKind, type ConnectorAuthKind, type ConnectorCategory } from "@ensemble/shared-types";
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

/** The featured short list: connected apps first, then FEATURED_ORDER. */
export function featuredEntries(entries: readonly CatalogEntry[]): CatalogEntry[] {
  const rank = (id: string) => {
    const index = (FEATURED_ORDER as readonly string[]).indexOf(id);
    return index === -1 ? FEATURED_ORDER.length : index;
  };
  return entries.filter((entry) => entry.featured).sort((a, b) => Number(isConnected(b)) - Number(isConnected(a)) || rank(a.id) - rank(b.id));
}

export function mcpConnected(entry: CatalogEntry): boolean {
  return entry.state.mcp?.status === "connected";
}

/** Connected without an account to a vendor server that holds the person's data (not `mcp.open`): only its public tools work. */
export function mcpPublicOnly(entry: Pick<CatalogEntry, "mcp" | "state">): boolean {
  return entry.state.mcp?.status === "connected" && entry.state.mcp.auth === "none" && !entry.mcp?.open;
}

/** Signed in, a token saved, or the vendor's MCP server connected. */
export function isConnected(entry: CatalogEntry): boolean {
  return entry.state.connected || mcpConnected(entry);
}

/** Sync sources that Sync people reads (names and addresses only). */
export const PEOPLE_SYNC_SOURCES: ReadonlySet<string> = new Set(["gmail", "outlook", "slack", "teams", "github", "google_calendar", "outlook_calendar"]);

/** Browser sign-in is set up on this server (the operator registered the provider's app). */
export function oauthReady(entry: CatalogEntry): boolean {
  return entry.state.oauthReady ?? entry.state.appReady;
}

/** Auth kinds that work on this server right now. */
export function usableAuth(entry: CatalogEntry): ConnectorAuthKind[] {
  return entry.auth.filter((kind) => kind !== "oauth" || oauthReady(entry));
}

const KIND_WORDS: Partial<Record<AppItemKind, string>> = {
  page: "pages",
  database: "databases",
  repo: "repositories",
  issue: "issues",
  pull_request: "pull requests",
  board: "boards",
  card: "cards",
  project: "projects",
  task: "tasks",
  file: "files",
  channel: "channels",
  person: "people",
  ticket: "tickets",
  conversation: "conversations",
  contact: "contacts",
  company: "companies",
  deal: "deals",
  design: "designs",
  deployment: "deployments",
  work_item: "work items",
  invoice: "invoices",
  reference: "references",
  collection: "collections",
  attachment: "attachments",
  dashboard: "dashboards",
  record: "records",
  meeting: "meetings",
  video: "videos",
};

function words(list: readonly string[]): string {
  return list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}` : (list[0] ?? "");
}

/** Built-in assistant tools for apps with no item search or MCP server of their own. */
const BUILT_IN_TOOLS: Readonly<Record<string, string>> = {
  zoom: "Ask the assistant about your Zoom meetings, recordings, summaries and transcripts.",
  docusign: "Ask the assistant which envelopes are waiting for whom, and what was completed.",
};

/** What Ensemble does with an app once it is connected, in the order people meet it. Only what the code does today. */
export function connectorUses(entry: CatalogEntry): string[] {
  const uses: string[] = [];
  const brandName = entry.vendor === entry.name ? entry.name : (entry.name.split(" ")[0] ?? entry.name);
  if (Object.keys(entry.state.sources ?? {}).some((id) => PEOPLE_SYNC_SOURCES.has(id))) {
    uses.push("Sync people adds the people you work with here to People. Messages and files are saved only when you ask.");
  }
  if (entry.category === "meetings" && entry.auth.includes("token")) {
    uses.push("With an API key, ask the assistant to import recent notes into Meetings (up to 20 at a time), matched to your calendar. Action items become proposed todos only if you ask.");
  }
  const builtIn = BUILT_IN_TOOLS[entry.id];
  if (builtIn) uses.push(builtIn);
  const items = entry.items;
  if (items) {
    const kinds = items.kinds.filter((kind) => kind !== "person").map((kind) => KIND_WORDS[kind] ?? kind);
    if (kinds.length) uses.push(`Attach ${words(kinds)} to a task or project. The assistant and agents working on it read them.`);
    if (items.kinds.some((kind) => TASK_LIKE_KINDS.has(kind))) uses.push(`Turn ${words(items.kinds.filter((kind) => TASK_LIKE_KINDS.has(kind)).map((kind) => KIND_WORDS[kind] ?? kind))} into tasks, and hand them to an agent.`);
    if (items.comments) {
      const where = entry.id === "atlassian" ? " to Jira (when connected with an API token)" : "";
      uses.push(`Post an update back${where} when the work is done. Nothing is posted until you press Post or Apply.`);
    }
    if (items.people) uses.push("Add its people to People, so mentions, mail and meetings point to the same person.");
    uses.push(`Ask the assistant: it searches and reads ${entry.name} for you.`);
  }
  if (entry.id === "github") uses.push("Agents can clone the repositories you pick, using this connection.");
  if (entry.import) uses.push(`Import into Ensemble: ${words(entry.import.brings.map((line) => line.charAt(0).toLowerCase() + line.slice(1)))}. Running it again updates instead of duplicating.`);
  if (entry.mcp) uses.push(`The assistant can use ${brandName}'s own tools. Anything that changes ${brandName} waits for your Apply.`);
  if (entry.products?.some((product) => product.write)) uses.push(`After your Apply, the assistant can change these for you: ${entry.writes.join("; ")}.`);
  return uses;
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
    case "connected": {
      if (entry.auth.includes("builtin") && !entry.state.connected) return "Built in";
      const account = entry.state.account ?? (mcpConnected(entry) ? entry.state.mcp?.account : null);
      if (account) return `Connected as ${account}`;
      return !entry.state.connected && mcpPublicOnly(entry) ? "Connected · public data only" : "Connected";
    }
    case "attention":
      return entry.state.account ? `${entry.state.account} · needs attention` : "Needs attention";
    case "pending":
      return "Waiting for approval";
    case "not_set_up":
      return "Not available to connect yet";
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

/** Connected first, then ready, then "soon"; catalog order within each. */
function storeRank(entry: CatalogEntry): number {
  if (entry.status === "soon") return 2;
  return isConnected(entry) ? 0 : 1;
}

/** Every word of the query must appear somewhere in the entry. Connected entries come first and "soon" ones last. */
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
    .sort((a, b) => storeRank(a.entry) - storeRank(b.entry) || a.index - b.index)
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

export type StoreCard = { kind: "entry"; entry: CatalogEntry } | { kind: "custom"; connection: McpConnection };

/** The grid in order: connected apps and connected custom servers first, then the rest of each. */
export function storeCards(entries: readonly CatalogEntry[], custom: readonly McpConnection[]): StoreCard[] {
  const on = (card: StoreCard) => (card.kind === "entry" ? isConnected(card.entry) : card.connection.status === "connected");
  const cards: StoreCard[] = [...entries.map((entry) => ({ kind: "entry" as const, entry })), ...custom.map((connection) => ({ kind: "custom" as const, connection }))];
  return [...cards.filter(on), ...cards.filter((card) => !on(card))];
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
