/**
 * The connector store: every app a person can connect, import from, or reach
 * through a remote MCP server. Hub web renders this list; hub-api adds each
 * person's connection status (GET /api/connectors/catalog).
 *
 * Names and logos belong to their owners; they are shown only to identify the
 * service being connected.
 */

export type ConnectorCategory =
  | "suites"
  | "mail_calendar"
  | "files_docs"
  | "work_tracking"
  | "notes_docs"
  | "meetings"
  | "chat"
  | "developer"
  | "design"
  | "sales_support"
  | "sign"
  | "cloud";

export const CONNECTOR_CATEGORIES: ReadonlyArray<{ id: ConnectorCategory; label: string }> = [
  { id: "suites", label: "Google & Microsoft" },
  { id: "mail_calendar", label: "Mail & calendar" },
  { id: "files_docs", label: "Files & docs" },
  { id: "work_tracking", label: "Projects & issues" },
  { id: "notes_docs", label: "Notes & wikis" },
  { id: "meetings", label: "Meetings" },
  { id: "chat", label: "Chat" },
  { id: "developer", label: "Developer" },
  { id: "design", label: "Design" },
  { id: "sales_support", label: "Sales & support" },
  { id: "sign", label: "Signatures" },
  { id: "cloud", label: "Cloud" },
];

/**
 * How the connection is made.
 * - oauth: Ensemble's own OAuth app for the provider (the operator registers it once).
 * - token: the person pastes a personal token.
 * - mcp: the vendor's hosted MCP server, OAuth with dynamic client registration; no operator setup.
 * - file: an export file is uploaded (imports only).
 * - builtin: always on.
 */
export type ConnectorAuthKind = "oauth" | "token" | "mcp" | "file" | "builtin";

/** Products inside a suite. Each can be switched on or off; OAuth asks only for the scopes of the ones that are on. */
export interface ConnectorProduct {
  id: string;
  name: string;
  /** Plain-language access, e.g. "Read your mail" or "Create and edit documents". */
  access: string;
  /** Sync sources this product feeds (settings.connections keys). */
  sources?: readonly string[];
  write: boolean;
  defaultOn: boolean;
}

export interface ConnectorImport {
  /** Import source id understood by POST /api/imports. */
  source: string;
  /** Uploaded export formats the importer reads, e.g. ["csv", "zip"]. */
  files?: readonly string[];
  /** True when the importer can pull through the connected account or a pasted token. */
  api: boolean;
  /** Where to create a personal token, for the token path. */
  tokenUrl?: string;
  tokenHint?: string;
  /** What comes across, e.g. ["Databases as projects", "Rows as tasks with due dates and tags", "Pages"]. */
  brings: readonly string[];
}

export interface ConnectorCatalogEntry {
  id: string;
  name: string;
  vendor: string;
  category: ConnectorCategory;
  /** Shown in the short Connections list in Settings; everything else lives in Browse connectors. */
  featured: boolean;
  /** Logo key for components/connectors/brand-logo.tsx. */
  logo: string;
  tagline: string;
  /** How it connects. A connector can offer more than one, e.g. Linear: token sync plus MCP tools plus import. */
  auth: readonly ConnectorAuthKind[];
  /** oauth_tokens provider for oauth/token connectors. */
  provider?: string;
  products?: readonly ConnectorProduct[];
  /** Things it reads, in plain words. */
  reads: readonly string[];
  /** Things it can change. Every change waits for Apply. */
  writes: readonly string[];
  /** Remote MCP server, for auth "mcp". */
  mcp?: { url: string; transport: "streamable-http" | "sse"; docs?: string; note?: string };
  import?: ConnectorImport;
  /** ready: works today. setup: needs the operator's app keys (see private setup docs). soon: listed, not built. */
  status: "ready" | "soon";
  /** Shown on the detail view: plan requirements, account types, review notes. */
  notes?: readonly string[];
  docsUrl?: string;
}
